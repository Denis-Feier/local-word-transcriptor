import { EventEmitter } from 'node:events';
import { findModel, isInstalled, modelPath } from './models.js';
import { WhisperCppEngine } from './engines/whisper-cpp.js';
import { TranscribeCppEngine } from './engines/transcribe-cpp.js';
import { PythonNemoEngine } from './engines/python-nemo.js';
import { AppleSpeechEngine } from './engines/apple-speech.js';
import { ElevenLabsEngine } from './engines/elevenlabs.js';
/** @import { Config } from '../types/config.ts' */
/** @import { Model } from '../types/model.ts' */
/** @import { Engine, OnCrash, SessionStream, StreamOptions, TimedResult, TranscribeOptions, TranscriberState, TranscriberStatus } from '../types/engine.ts' */

const MAX_RESTARTS = 3;
const RETRY_MS = 30_000; // after giving up on a crashing model, try it again this often

/**
 * Owns the active speech model and serialises all transcription requests to it.
 * Switching models unloads the old one first, so only one big model is in memory.
 *
 * Events: 'state' ({ state, message, model }) where state is 'idle' | 'loading' | 'ready' | 'error'.
 */
export class Transcriber extends EventEmitter {
  /** @param {Config} config */
  constructor(config) {
    super();
    this.config = config;
    /** @type {Model | null} */
    this.model = null;
    /** @type {Engine | null} */
    this.engine = null;
    /** @type {Model | null} */
    this.loaded = null; // the model the engine serves: during a switch, still the old one
    /** @type {TranscriberState} */
    this.state = 'idle';
    this.message = 'No model selected';
    this.pending = 0;
    /** @type {Promise<unknown>} */
    this.queue = Promise.resolve();
    /** @type {number | null} */
    this.avgMs = null; // moving average of inference time, used to pace live guesses
    this.restarts = 0;
    this.retryMs = RETRY_MS;
    /** @type {NodeJS.Timeout | null} */
    this.retryTimer = null;
    /** @type {Set<Promise<unknown>>} */
    this.commits = new Set(); // streamed sentences waiting for their text
    /** @type {Set<Promise<unknown>>} */
    this.sentences = new Set(); // transcribe() calls not finished yet, including a sentence waiting to be sent again
  }

  /** @returns {TranscriberStatus} */
  status() {
    // device: where the model runs ('GPU (Metal)', 'CPU', ...); fallback: why not on the GPU, when it could not be.
    const engine = this.state === 'ready' ? this.engine : null;
    return { state: this.state, message: this.message, model: this.model?.id ?? null, device: engine?.device ?? null, fallback: engine?.fallback ?? null };
  }

  get busy() {
    return this.pending > 0;
  }

  get supportsPrompt() {
    return Boolean(this.engine?.supportsPrompt) && !this.model?.noPrompt;
  }

  /**
   * Switch to another model. Queued behind in-flight requests; later requests wait for the load.
   * @param {string} id
   */
  select(id) {
    const model = findModel(id);
    if (!model) return this.#setState('error', `Unknown model "${id}"`);
    if (!isInstalled(model)) return this.#setState('error', model.cloud ? `${model.label} needs ELEVENLABS_API_KEY` : `${model.label} is not downloaded yet`);
    if (this.model === model && this.state !== 'error') return;
    this.#stopRetrying();
    return this.#load(model);
  }

  /**
   * Load model behind queued requests. quiet: a background retry, so the error stays shown until it works.
   * @param {Model} model
   * @param {{ quiet?: boolean }} [opts]
   */
  #load(model, { quiet = false } = {}) {
    this.model = model;
    if (!quiet) this.#setState('loading', `Loading ${model.label}…`);
    const job = this.queue.then(async () => {
      if (this.model !== model) return; // superseded by a later select
      await this.engine?.unload();
      this.engine = null;
      this.loaded = null;
      const engine = this.createEngine(model, (message) => this.#recover(model, engine, message));
      const t0 = Date.now();
      await engine.load();
      if (this.model !== model) return engine.unload();
      this.engine = engine;
      this.loaded = model;
      /** @type {string | null | undefined} */
      this.device = engine.device;
      this.avgMs = null;
      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      // Say where it runs: the CPU is only a fallback for models that can use the GPU, so say why when it is used.
      const where = engine.device ? ` on ${engine.device}` : '';
      this.#setState('ready', `${model.label} ready${where} (${seconds} s)`);
      if (engine.fallback) console.error(`\n! ${model.label} could not use the GPU, so it runs on the CPU: ${engine.fallback.split('\n')[0]}`);
    });
    this.queue = job.catch((err) => {
      if (this.model !== model) return;
      if (quiet) this.#retryLater(model);
      else this.#setState('error', err.message);
    });
    return this.queue;
  }

  /**
   * Queue a transcription. Resolves to { text, segments, ms, model }. A sentence the model went away under (its process
   * died while it worked on it, or before its turn) is sent once more when the model is back, instead of failing (#45).
   * @param {Float32Array} samples
   * @param {TranscribeOptions} [opts]
   * @returns {Promise<TimedResult>}
   */
  transcribe(samples, opts = {}) {
    const sentence = this.#counted(this.#transcribe(samples, opts));
    const done = sentence.catch(() => {}).finally(() => this.sentences.delete(done));
    this.sentences.add(done);
    return sentence;
  }

  /**
   * Transcribe only if the model is idle right now (used for throwaway live guesses, which are not sent again).
   * @param {Float32Array} samples
   * @param {TranscribeOptions} [opts]
   * @returns {Promise<TimedResult> | null}
   */
  tryTranscribe(samples, opts = {}) {
    // A streaming model's live text comes from its stream; a guess would send (and bill) the audio again.
    if (this.busy || this.state !== 'ready' || /** @type {Engine} */ (this.engine).stream) return null; // ready: an engine is loaded
    return this.#counted(this.#run(samples, opts));
  }

  /**
   * @template T
   * @param {Promise<T>} job
   * @returns {Promise<T>}
   */
  #counted(job) {
    this.pending++;
    return job.finally(() => this.pending--);
  }

  /**
   * @param {Float32Array} samples
   * @param {TranscribeOptions} opts
   * @param {boolean} [again]
   * @returns {Promise<TimedResult>}
   */
  async #transcribe(samples, opts, again = false) {
    try {
      return await this.#run(samples, opts);
    } catch (/** @type {any} */ err) {
      if (again || !err.modelLost) throw err;
      await this.#settled(); // the reload is queued behind this sentence: wait outside the queue, then queue it again
      return this.#transcribe(samples, opts, true);
    }
  }

  /**
   * One turn on the model. Rejects with err.modelLost when the model went away under it and is being loaded again.
   * @param {Float32Array} samples
   * @param {TranscribeOptions} opts
   * @returns {Promise<TimedResult>}
   */
  #run(samples, opts) {
    const run = this.queue.then(async () => {
      const { engine, loaded: model } = this;
      // During a switch the old model is still loaded: it transcribes the sentences queued before the switch.
      if (!engine || this.state === 'error') throw Object.assign(new Error(this.message), { modelLost: this.state === 'loading' });
      const t0 = performance.now();
      let result;
      try {
        result = await engine.transcribe(samples, opts);
      } catch (/** @type {any} */ err) {
        // Its process died while it worked on this sentence (#recover dropped it): the sentence is not at fault.
        if (this.engine !== engine) err.modelLost = true;
        throw err;
      } finally {
        this.#checkDevice();
      }
      const ms = performance.now() - t0;
      this.avgMs = this.avgMs === null ? ms : this.avgMs * 0.8 + ms * 0.2;
      return { ...result, ms, model: /** @type {Model} */ (model).id }; // an engine always serves a model
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Resolves once no model is loading: it is ready, or in error.
   * @returns {Promise<void>}
   */
  #settled() {
    if (this.state !== 'loading') return Promise.resolve();
    return new Promise((resolve) => {
      /** @param {TranscriberStatus} status */
      const onState = ({ state }) => {
        if (state === 'loading') return;
        this.off('state', onState);
        resolve();
      };
      this.on('state', onState);
    });
  }

  /**
   * A sentence for a streaming model (ElevenLabs), sent while it is spoken: push(samples), commit() resolves like
   * transcribe(), cancel(); opts.onPartial(text) gets the live text. Null when the model does not stream or is not ready.
   * @param {StreamOptions} [opts]
   * @returns {SessionStream | null}
   */
  stream(opts = {}) {
    if (this.state !== 'ready' || !this.engine?.stream) return null;
    const sentence = this.engine.stream(opts);
    const model = /** @type {Model} */ (this.model).id; // ready: a model is chosen
    return {
      push: (samples) => sentence.push(samples),
      cancel: () => sentence.cancel(),
      live: () => !sentence.closed,
      commit: () => {
        this.pending++;
        const t0 = performance.now();
        const run = sentence.commit().then((result) => ({ ...result, ms: performance.now() - t0, model }));
        const done = run.catch(() => {}).finally(() => {
          this.pending--;
          this.commits.delete(done);
        });
        this.commits.add(done);
        return run;
      },
    };
  }

  /**
   * Wait (at most timeoutMs) for queued transcriptions and streamed sentences to finish.
   * @param {number} timeoutMs
   */
  async drain(timeoutMs) {
    await Promise.race([Promise.all([this.queue, ...this.sentences, ...this.commits]), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    await new Promise((resolve) => setImmediate(resolve)); // let callers write their results
  }

  async shutdown() {
    this.#stopRetrying();
    await this.engine?.unload();
  }

  /** Synchronous cleanup for process exit. */
  kill() {
    this.#stopRetrying();
    this.engine?.kill();
  }

  /**
   * Builds the engine for a model; onCrash reloads it. A test can override this to stand in a fake engine. An engine
   * whose process dies while it serves a request calls onCrash before that request fails.
   * @param {Model} model
   * @param {OnCrash} onCrash
   * @returns {Engine}
   */
  createEngine(model, onCrash) {
    const { config } = this;
    if (model.engine === 'whisper.cpp') {
      return new WhisperCppEngine({
        ...config.whisper,
        modelPath: modelPath(model),
        language: config.language,
        threads: config.threads,
        onCrash,
      });
    }
    if (model.engine === 'python-nemo') {
      return new PythonNemoEngine({
        id: model.id,
        modelDir: modelPath(model),
        nemo: model.nemo,
        threads: config.threads,
        onCrash,
      });
    }
    if (model.engine === 'apple-speech') {
      return new AppleSpeechEngine({
        bin: modelPath(model),
        language: config.language,
        module: model.apple.module,
        preset: model.apple.preset,
        onCrash,
      });
    }
    if (model.engine === 'elevenlabs') {
      return new ElevenLabsEngine({ ...config.elevenlabs, modelId: model.elevenlabs.modelId, language: config.language });
    }
    if (model.engine === 'transcribe.cpp') {
      return new TranscribeCppEngine({ modelPath: modelPath(model), language: config.language });
    }
    const { label, engine } = /** @type {Model} */ (model); // every kind is handled above, so the checker sees none left
    throw new Error(`${label}: unknown engine "${engine}"`);
  }

  /**
   * The model process died mid-session (e.g. a GPU hiccup): reload it so a long meeting keeps going.
   * @param {Model} model
   * @param {Engine} engine
   * @param {string} message
   */
  #recover(model, engine, message) {
    // Its sentences wait for the model that is loaded next, this one again or the one being switched to.
    if (this.engine === engine) Object.assign(this, { engine: null, loaded: null });
    if (this.model !== model) return;
    // Only repeated crashes in quick succession count towards giving up.
    if (Date.now() - (this.lastCrashAt ?? 0) > 60_000) this.restarts = 0;
    this.lastCrashAt = Date.now();
    if (++this.restarts > MAX_RESTARTS) {
      // Give up on quick restarts, but not for the rest of the meeting: the error stays shown and the model is tried
      // again every retryMs until it loads, or until another model is picked.
      this.#setState('error', `${message} Retrying every ${Math.round(this.retryMs / 1000)} s…`);
      return this.#retryLater(model);
    }
    console.error(`\n✖ ${message}\n  Restarting ${model.label} (attempt ${this.restarts}/${MAX_RESTARTS})…`);
    this.model = null;
    this.select(model.id);
  }

  /** @param {Model} model */
  #retryLater(model) {
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.model !== model || this.state !== 'error') return;
      console.error(`  Retrying ${model.label}…`);
      this.#load(model, { quiet: true });
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  #stopRetrying() {
    clearTimeout(this.retryTimer ?? undefined);
    this.retryTimer = null;
  }

  /** A model that moved to the CPU mid-meeting (the GPU failed): say so in the terminal and on the page. */
  #checkDevice() {
    const { engine, loaded: model } = this;
    if (!engine || engine.device === this.device) return;
    this.device = engine.device;
    const { label } = /** @type {Model} */ (model); // an engine always serves a model
    if (engine.fallback) console.error(`\n! ${label} moved to the ${engine.device}, the GPU failed: ${engine.fallback.split('\n')[0]}`);
    this.#setState(this.state, `${label} ready on ${engine.device}`);
  }

  /**
   * @param {TranscriberState} state
   * @param {string} message
   */
  #setState(state, message) {
    this.state = state;
    this.message = message;
    if (state === 'error') console.error(`\n✖ ${message}\n`);
    this.emit('state', this.status());
  }
}
