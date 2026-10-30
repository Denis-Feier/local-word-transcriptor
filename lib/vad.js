import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SAMPLE_RATE } from './wav.js';

const require = createRequire(import.meta.url);

export const FRAME = 512; // 32 ms at 16 kHz, Silero's window size

const CALIBRATION_FRAMES = 10; // measure the room for ~320 ms before detecting speech
const MAX_CALIBRATED_FLOOR = 0.01; // -40 dBFS; anything louder at startup is the user already talking

/**
 * Neural voice detector (Silero VAD via sherpa-onnx). Robust to background noise and
 * picks up quieter, farther-away voices than a loudness threshold.
 */
export class SileroDetector {
  name = 'silero';
  onsetFrames = 1; // Silero already debounces with minSpeechDuration

  constructor({ model, threshold }) {
    this.model = model;
    this.setThreshold(threshold);
  }

  /** Changing Silero's threshold means a new detector; it re-settles within ~0.1 s. */
  setThreshold(threshold) {
    if (threshold === this.threshold) return;
    this.threshold = threshold;
    const { Vad } = require('sherpa-onnx-node');
    this.vad = new Vad({
      sileroVad: { model: this.model, threshold, minSilenceDuration: 0.1, minSpeechDuration: 0.1, windowSize: FRAME, maxSpeechDuration: 30 },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: false,
    }, 30);
  }

  isSpeech(samples) {
    this.vad.acceptWaveform(samples);
    // We only use the detector's on/off state; segments are cut by our own Segmenter.
    while (!this.vad.isEmpty()) this.vad.pop();
    return this.vad.isDetected();
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
    return new SileroDetector({ model: vadConfig.sileroModel, threshold: vadConfig.sileroThreshold });
  }
  return new EnergyDetector(vadConfig);
}
