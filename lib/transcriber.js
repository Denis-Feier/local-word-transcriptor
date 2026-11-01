import { EventEmitter } from 'node:events';
import { findModel, isInstalled, modelPath } from './models.js';
import { WhisperCppEngine } from './engines/whisper-cpp.js';
import { SherpaEngine } from './engines/sherpa.js';
import { TranscribeCppEngine } from './engines/transcribe-cpp.js';
import { PythonNemoEngine } from './engines/python-nemo.js';
import { AppleSpeechEngine } from './engines/apple-speech.js';

const MAX_RESTARTS = 3;

/**
 * Owns the active speech model and serialises all transcription requests to it.
 * Switching models unloads the old one first, so only one big model is in memory.
 *
 * Events: 'state' ({ state, message, model }) where state is 'idle' | 'loading' | 'ready' | 'error'.
 */
export class Transcriber extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.model = null;
    this.engine = null;
    this.state = 'idle';
    this.message = 'No model selected';
    this.pending = 0;
    this.queue = Promise.resolve();
    this.avgMs = null; // moving average of inference time, used to pace live guesses
    this.restarts = 0;
  }

  status() {
    return { state: this.state, message: this.message, model: this.model?.id ?? null };
  }

  get busy() {
    return this.pending > 0;
  }

  get supportsPrompt() {
    return Boolean(this.engine?.supportsPrompt) && !this.model?.noPrompt;
  }

  /** Switch to another model. Queued behind in-flight requests; later requests wait for the load. */
  select(id) {
    const model = findModel(id);
    if (!model) return this.#setState('error', `Unknown model "${id}"`);
    if (!isInstalled(model)) return this.#setState('error', `${model.label} is not downloaded yet`);
    if (this.model === model && this.state !== 'error') return;

    this.model = model;
    this.#setState('loading', `Loading ${model.label}…`);
    const job = this.queue.then(async () => {
      if (this.model !== model) return; // superseded by a later select
      await this.engine?.unload();
      this.engine = null;
      const engine = this.#createEngine(model);
      const t0 = Date.now();
      await engine.load();
      if (this.model !== model) return engine.unload();
      this.engine = engine;
      this.avgMs = null;
      this.#setState('ready', `${model.label} ready (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    });
    this.queue = job.catch((err) => {
      if (this.model === model) this.#setState('error', err.message);
    });
    return this.queue;
  }

  /** Queue a transcription. Resolves to { text, segments, ms, model }. */
  transcribe(samples, opts = {}) {
    this.pending++;
    const run = this.queue.then(async () => {
      if (this.state !== 'ready' || !this.engine) throw new Error(this.message);
      const t0 = performance.now();
      const result = await this.engine.transcribe(samples, opts);
      const ms = performance.now() - t0;
      this.avgMs = this.avgMs === null ? ms : this.avgMs * 0.8 + ms * 0.2;
      return { ...result, ms, model: this.model.id };
    });
    this.queue = run.catch(() => {});
    return run.finally(() => this.pending--);
  }

  /** Transcribe only if the model is idle right now (used for throwaway live guesses). */
  tryTranscribe(samples, opts = {}) {
    if (this.busy || this.state !== 'ready') return null;
    return this.transcribe(samples, opts);
  }

  /** Wait (at most timeoutMs) for queued transcriptions to finish. */
  async drain(timeoutMs) {
    await Promise.race([this.queue, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
    await new Promise((resolve) => setImmediate(resolve)); // let callers write their results
  }

  async shutdown() {
    await this.engine?.unload();
  }

  /** Synchronous cleanup for process exit. */
  kill() {
    this.engine?.kill();
  }

  #createEngine(model) {
    const { config } = this;
    if (model.engine === 'whisper.cpp') {
      return new WhisperCppEngine({
        ...config.whisper,
        modelPath: modelPath(model),
        language: config.language,
        threads: config.threads,
        onCrash: (message) => this.#recover(model, message),
      });
    }
    if (model.engine === 'python-nemo') {
      return new PythonNemoEngine({
        modelDir: modelPath(model),
        nemo: model.nemo,
        threads: config.threads,
        onCrash: (message) => this.#recover(model, message),
      });
    }
    if (model.engine === 'apple-speech') {
      return new AppleSpeechEngine({
        bin: modelPath(model),
        language: config.language,
        module: model.apple.module,
        onCrash: (message) => this.#recover(model, message),
      });
    }
    if (model.engine === 'transcribe.cpp') {
      return new TranscribeCppEngine({ modelPath: modelPath(model), language: config.language });
    }
    return new SherpaEngine({ recognizerConfig: model.recognizer(modelPath(model)), threads: config.threads });
  }

  /** The model process died mid-session (e.g. a GPU hiccup): reload it so a long meeting keeps going. */
  #recover(model, message) {
    if (this.model !== model) return;
    this.engine = null;
    // Only repeated crashes in quick succession count towards giving up.
    if (Date.now() - (this.lastCrashAt ?? 0) > 60_000) this.restarts = 0;
    this.lastCrashAt = Date.now();
    if (++this.restarts > MAX_RESTARTS) return this.#setState('error', message);
    console.error(`\n✖ ${message}\n  Restarting ${model.label} (attempt ${this.restarts}/${MAX_RESTARTS})…`);
    this.model = null;
    this.select(model.id);
  }

  #setState(state, message) {
    this.state = state;
    this.message = message;
    if (state === 'error') console.error(`\n✖ ${message}\n`);
    this.emit('state', this.status());
  }
}
