import { EventEmitter } from 'node:events';
import { findModel, isInstalled, modelPath } from './models.ts';
import { WhisperCppEngine } from './engines/whisper-cpp.ts';
import { TranscribeCppEngine } from './engines/transcribe-cpp.ts';
import { PythonNemoEngine } from './engines/python-nemo.ts';
import { AppleSpeechEngine } from './engines/apple-speech.ts';
import { ElevenLabsEngine } from './engines/elevenlabs.ts';
import type { Config } from '../types/config.ts';
import type { Model } from '../types/model.ts';
import type { Engine, OnCrash, SessionStream, StreamOptions, TimedResult, TranscribeOptions, TranscriberState, TranscriberStatus } from '../types/engine.ts';

const MAX_RESTARTS = 3;
const RETRY_MS = 30_000; // after giving up on a crashing model, try it again this often

/**
 * Owns the active speech model and serialises all transcription requests to it.
 * Switching models unloads the old one first, so only one big model is in memory.
 *
 * Events: 'state' ({ state, message, model }) where state is 'idle' | 'loading' | 'ready' | 'error'.
 */
export class Transcriber extends EventEmitter {
  config: Config;
  model: Model | null;
  engine: Engine | null;
  loaded: Model | null;
  state: TranscriberState;
  message: string;
  pending: number;
  queue: Promise<unknown>;
  avgMs: number | null;
  restarts: number;
  retryMs: number;
  retryTimer: NodeJS.Timeout | null;
  commits: Set<Promise<unknown>>;
  sentences: Set<Promise<unknown>>;
  /** The engine whose model is loading right now (null between loads): kill() reaches it too (#62). */
  loading: Engine | null;
  /** Set by kill(): the process is exiting, so nothing is loaded or restarted any more. */
  closed: boolean;
  #loadEnd: Promise<void> | null;
  // Set once a model has loaded, or crashed.
  declare device: string | null | undefined;
  declare lastCrashAt: number | undefined;

  constructor(config: Config) {
    super();
    this.config = config;
    this.model = null;
    this.engine = null;
    this.loaded = null; // the model the engine serves: during a switch, still the old one
    this.state = 'idle';
    this.message = 'No model selected';
    this.pending = 0;
    this.queue = Promise.resolve();
    this.avgMs = null; // moving average of inference time, used to pace live guesses
    this.restarts = 0;
    this.retryMs = RETRY_MS;
    this.retryTimer = null;
    this.commits = new Set(); // streamed sentences waiting for their text
    this.sentences = new Set(); // transcribe() calls not finished yet, including a sentence waiting to be sent again
    this.loading = null;
    this.closed = false;
    this.#loadEnd = null;
  }

  status(): TranscriberStatus {
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

  /** Switch to another model. Queued behind in-flight requests; later requests wait for the load. */
  select(id: string) {
    if (this.closed) return; // the process is exiting
    const model = findModel(id);
    if (!model) return this.#setState('error', `Unknown model "${id}"`);
    if (!isInstalled(model)) return this.#setState('error', model.cloud ? `${model.label} needs ELEVENLABS_API_KEY` : `${model.label} is not downloaded yet`);
    if (this.model === model && this.state !== 'error') return;
    this.#stopRetrying();
    return this.#load(model);
  }

  /** Load model behind queued requests. quiet: a background retry, so the error stays shown until it works. */
  #load(model: Model, { quiet = false }: { quiet?: boolean } = {}) {
    this.model = model;
    if (!quiet) this.#setState('loading', `Loading ${model.label}…`);
    const job = this.queue.then(async () => {
      if (this.model !== model || this.closed) return; // superseded by a later select, or the process is exiting
      await this.engine?.unload();
      this.engine = null;
      this.loaded = null;
      if (this.closed) return;
      const engine = this.createEngine(model, (message) => this.#recover(model, engine, message));
      const t0 = Date.now();
      // A load cannot be stopped mid-way (#62): kill() reaches the engine meanwhile (a model process is killed, which
      // fails its load) and loadEnded() waits for it; a model that finished loading after kill() is thrown away below.
      this.loading = engine;
      const load = engine.load();
      this.#loadEnd = load.catch(() => {}).finally(() => (this.loading = null));
      await this.#loadEnd;
      await load; // its error, if it failed
      if (this.model !== model || this.closed) return engine.unload();
      this.engine = engine;
      this.loaded = model;
      this.device = engine.device;
      this.avgMs = null;
      const seconds = ((Date.now() - t0) / 1000).toFixed(1);
      // Say where it runs: the CPU is only a fallback for models that can use the GPU, so say why when it is used.
      const where = engine.device ? ` on ${engine.device}` : '';
      this.#setState('ready', `${model.label} ready${where} (${seconds} s)`);
      if (engine.fallback) console.error(`\n! ${model.label} could not use the GPU, so it runs on the CPU: ${engine.fallback.split('\n')[0]}`);
    });
    this.queue = job.catch((err) => {
      if (this.model !== model || this.closed) return; // superseded, or the process is exiting: nothing to report
      if (quiet) this.#retryLater(model);
      else this.#setState('error', err.message);
    });
    return this.queue;
  }

  /**
   * Queue a transcription. Resolves to { text, segments, ms, model }. A sentence the model went away under (its process
   * died while it worked on it, or before its turn) is sent once more when the model is back, instead of failing (#45).
   */
  transcribe(samples: Float32Array, opts: TranscribeOptions = {}): Promise<TimedResult> {
    const sentence = this.#counted(this.#transcribe(samples, opts));
    const done = sentence.catch(() => {}).finally(() => this.sentences.delete(done));
    this.sentences.add(done);
    return sentence;
  }

  /** Transcribe only if the model is idle right now (used for throwaway live guesses, which are not sent again). */
  tryTranscribe(samples: Float32Array, opts: TranscribeOptions = {}): Promise<TimedResult> | null {
    // A streaming model's live text comes from its stream; a guess would send (and bill) the audio again.
    if (this.busy || this.state !== 'ready' || (this.engine as Engine).stream) return null; // ready: an engine is loaded
    return this.#counted(this.#run(samples, opts));
  }

  #counted<T>(job: Promise<T>): Promise<T> {
    this.pending++;
    return job.finally(() => this.pending--);
  }

  async #transcribe(samples: Float32Array, opts: TranscribeOptions, again = false): Promise<TimedResult> {
    try {
      return await this.#run(samples, opts);
    } catch (err: any) {
      if (again || !err.modelLost) throw err;
      await this.#settled(); // the reload is queued behind this sentence: wait outside the queue, then queue it again
      return this.#transcribe(samples, opts, true);
    }
  }

  /**
   * One turn on the model. Rejects with err.modelLost when the model went away under it and is being loaded again.
   */
  #run(samples: Float32Array, opts: TranscribeOptions): Promise<TimedResult> {
    const run = this.queue.then(async () => {
      const { engine, loaded: model } = this;
      // During a switch the old model is still loaded: it transcribes the sentences queued before the switch.
      if (!engine || this.state === 'error') throw Object.assign(new Error(this.message), { modelLost: this.state === 'loading' });
      const t0 = performance.now();
      let result;
      try {
        result = await engine.transcribe(samples, opts);
      } catch (err: any) {
        // Its process died while it worked on this sentence (#recover dropped it): the sentence is not at fault.
        if (this.engine !== engine) err.modelLost = true;
        throw err;
      } finally {
        this.#checkDevice();
      }
      const ms = performance.now() - t0;
      this.avgMs = this.avgMs === null ? ms : this.avgMs * 0.8 + ms * 0.2;
      return { ...result, ms, model: (model as Model).id }; // an engine always serves a model
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /** Resolves once no model is loading: it is ready, or in error. */
  #settled(): Promise<void> {
    if (this.state !== 'loading') return Promise.resolve();
    return new Promise((resolve) => {
      const onState = ({ state }: TranscriberStatus) => {
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
   */
  stream(opts: StreamOptions = {}): SessionStream | null {
    if (this.state !== 'ready' || !this.engine?.stream) return null;
    const sentence = this.engine.stream(opts);
    const model = (this.model as Model).id; // ready: a model is chosen
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

  /** Wait (at most timeoutMs) for queued transcriptions and streamed sentences to finish. */
  async drain(timeoutMs: number) {
    await Promise.race([Promise.all([this.queue, ...this.sentences, ...this.commits]), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    await new Promise((resolve) => setImmediate(resolve)); // let callers write their results
  }

  async shutdown() {
    this.#stopRetrying();
    await this.engine?.unload();
  }

  /**
   * Synchronous cleanup for process exit: the loaded model and the one being loaded (#62), and nothing loads or restarts
   * after. A load in this process goes on regardless: loadEnded() waits for it.
   */
  kill() {
    this.closed = true;
    this.#stopRetrying();
    this.loading?.kill();
    this.engine?.kill();
  }

  /** Wait (at most ms) for the model being loaded, if any; true when no load is in progress any more. */
  async loadEnded(ms: number): Promise<boolean> {
    if (!this.loading) return true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.#loadEnd, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
    return !this.loading;
  }

  /**
   * Builds the engine for a model; onCrash reloads it. A test can override this to stand in a fake engine. An engine
   * whose process dies while it serves a request calls onCrash before that request fails.
   */
  createEngine(model: Model, onCrash: OnCrash): Engine {
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
    const { label, engine } = model as Model; // every kind is handled above, so the checker sees none left
    throw new Error(`${label}: unknown engine "${engine}"`);
  }

  /** The model process died mid-session (e.g. a GPU hiccup): reload it so a long meeting keeps going. */
  #recover(model: Model, engine: Engine, message: string) {
    // Its sentences wait for the model that is loaded next, this one again or the one being switched to.
    if (this.engine === engine) Object.assign(this, { engine: null, loaded: null });
    if (this.model !== model || this.closed) return;
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

  #retryLater(model: Model) {
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
    const { label } = model as Model; // an engine always serves a model
    if (engine.fallback) console.error(`\n! ${label} moved to the ${engine.device}, the GPU failed: ${engine.fallback.split('\n')[0]}`);
    this.#setState(this.state, `${label} ready on ${engine.device}`);
  }

  #setState(state: TranscriberState, message: string) {
    this.state = state;
    this.message = message;
    if (state === 'error') console.error(`\n✖ ${message}\n`);
    this.emit('state', this.status());
  }
}
