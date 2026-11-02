import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import v8 from 'node:v8';
import vm from 'node:vm';
import { SAMPLE_RATE } from './wav.js';

const require = createRequire(import.meta.url);

export const FRAME = 512; // 32 ms at 16 kHz, Silero's window size

const CALIBRATION_FRAMES = 10; // measure the room for ~320 ms before detecting speech
const MAX_CALIBRATED_FLOOR = 0.01; // -40 dBFS; anything louder at startup is the user already talking
const MAX_IDLE = 4; // spare Silero detectors kept for reuse: a reconnect with up to four mics takes them all back

/** A new Silero detector (sherpa-onnx's Vad): ~10 ms to load the model, ~3 MB of native memory. */
function createVad(model, threshold) {
  const { Vad } = require('sherpa-onnx-node');
  return new Vad({
    sileroVad: { model, threshold, minSilenceDuration: 0.1, minSpeechDuration: 0.1, windowSize: FRAME, maxSpeechDuration: 30 },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: false,
  }, 30);
}

let gc = null;
let gcSoon = false;

/**
 * A full garbage collection on the next turn of the event loop, so a dropped detector's native memory is freed now:
 * V8 does not see that memory, and on its own collects only after hundreds of them. (Not within the current turn:
 * sherpa-onnx frees a collected detector from a callback that Node runs only after it.) Node hides gc() unless
 * started with --expose-gc, so the flag is turned on just long enough to get it, as Jest's leak detector does.
 */
function collectSoon() {
  if (gcSoon) return;
  gcSoon = true;
  setImmediate(() => {
    gcSoon = false;
    gc ??= exposeGc();
    gc();
  });
}

function exposeGc() {
  if (typeof globalThis.gc === 'function') return globalThis.gc;
  try {
    v8.setFlagsFromString('--expose-gc');
    return vm.runInNewContext('gc');
  } catch {
    return () => {}; // V8 collects them in its own time, as before
  } finally {
    v8.setFlagsFromString('--no-expose-gc');
  }
}

/**
 * Silero detectors for the whole server, reused (#4). Each one holds ~3 MB of native memory (its model and a 30 s
 * buffer) that V8 does not see, and sherpa-onnx cannot free one: a dropped detector stays until V8 happens to
 * collect it, and 300 of them took the server from 70 to 1,007 MB first. So a mic that goes away (connection closed,
 * mics changed) gives its detector back, reset() to a fresh state, and the next mic gets it. sherpa-onnx cannot change
 * a detector's threshold either, and the threshold is one setting for every mic, so spares with another threshold are
 * dropped when a detector is asked for, as are spares beyond `maxIdle`; whatever is dropped is collected at once.
 */
export class VadPool {
  constructor({ create = createVad, maxIdle = MAX_IDLE, collect = collectSoon } = {}) {
    this.create = create;
    this.maxIdle = maxIdle;
    this.collect = collect;
    this.idle = []; // { model, threshold, vad }, oldest first
    this.created = 0;
    this.dropped = 0;
  }

  /** A detector with this threshold: the one given back last, or a new one. */
  acquire(model, threshold) {
    this.#drop((d) => d.model !== model || d.threshold !== threshold);
    const spare = this.idle.pop();
    if (spare) return spare.vad;
    const vad = this.create(model, threshold);
    this.created++;
    return vad;
  }

  /** Take a detector back. reset() makes it as good as new and frees the speech it was holding. */
  release(vad, model, threshold) {
    vad.reset();
    this.idle.push({ model, threshold, vad });
    const extra = this.idle.length - this.maxIdle;
    if (extra > 0) this.#drop((d, i) => i < extra);
  }

  #drop(which) {
    const keep = this.idle.filter((d, i) => !which(d, i));
    if (keep.length === this.idle.length) return;
    this.dropped += this.idle.length - keep.length;
    this.idle = keep;
    this.collect();
  }
}

export const vadPool = new VadPool();

/**
 * Neural voice detector (Silero VAD via sherpa-onnx). Robust to background noise and
 * picks up quieter, farther-away voices than a loudness threshold.
 */
export class SileroDetector {
  name = 'silero';
  onsetFrames = 1; // Silero already debounces with minSpeechDuration

  constructor({ model, threshold, pool = vadPool }) {
    this.model = model;
    this.pool = pool;
    this.threshold = threshold;
    this.vad = pool.acquire(model, threshold);
  }

  /** sherpa-onnx cannot change a detector's threshold, so this swaps in one that has the new one; it re-settles within ~0.1 s. */
  setThreshold(threshold) {
    if (threshold === this.threshold || !this.vad) return;
    this.release();
    this.threshold = threshold;
    this.vad = this.pool.acquire(this.model, threshold);
  }

  isSpeech(samples) {
    this.vad.acceptWaveform(samples);
    // We only use the detector's on/off state; segments are cut by our own Segmenter.
    while (!this.vad.isEmpty()) this.vad.pop();
    return this.vad.isDetected();
  }

  /** The mic is gone: give the detector back for the next one. This one is not used again. */
  release() {
    if (!this.vad) return;
    this.pool.release(this.vad, this.model, this.threshold);
    this.vad = null;
  }
}

/**
 * Loudness detector with an adaptive background-noise floor. Fallback when the Silero model is missing.
 */
export class EnergyDetector {
  name = 'energy';
  onsetFrames = 3; // ~100 ms of loud audio starts a segment

  constructor({ minRms, noiseRatio }) {
    this.minRms = minRms;
    this.noiseRatio = noiseRatio;
    this.noiseFloor = minRms / noiseRatio;
    this.calibration = []; // levels of the first frames; null once calibrated
  }

  isSpeech(samples, level) {
    if (this.calibration) {
      // The quietest early frame is a good noise estimate even if the user starts talking right away.
      this.calibration.push(level);
      if (this.calibration.length === CALIBRATION_FRAMES) {
        this.noiseFloor = Math.min(...this.calibration, MAX_CALIBRATED_FLOOR);
        this.calibration = null;
      }
      return false;
    }
    const loud = level > Math.max(this.minRms, this.noiseFloor * this.noiseRatio);
    // Asymmetric tracking: the floor drops quickly in quiet moments and rises slowly with steady noise.
    this.noiseFloor += (level - this.noiseFloor) * (level < this.noiseFloor ? 0.05 : 0.002);
    return loud;
  }
}

export function createDetector(vadConfig) {
  if (vadConfig.engine !== 'energy' && existsSync(vadConfig.sileroModel)) {
    try {
      return new SileroDetector({ model: vadConfig.sileroModel, threshold: vadConfig.sileroThreshold });
    } catch (err) {
      // e.g. sherpa-onnx's native library can't load (missing Visual C++ runtime on Windows): keep working.
      console.error(`Silero voice detector unavailable (${err.message}); using the loudness detector.`);
    }
  }
  return new EnergyDetector(vadConfig);
}
