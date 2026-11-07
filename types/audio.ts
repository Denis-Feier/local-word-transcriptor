// The audio pipeline's shapes shared between modules: frames, sentences, detectors and the crosstalk gate's noise
// floors (lib/vad.ts, lib/segmenter.ts, lib/crosstalk.ts, lib/session.ts). Phase 1 of docs/typescript-migration.md; the
// shapes one module alone uses live in that module since Phase 5.

/** One detector frame (512 samples, 32 ms at 16 kHz) as Segmenter.analyze() returns it and CrosstalkGate.push() reads it. */
export interface Frame {
  samples: Float32Array;
  /** RMS level. */
  level: number;
  /** The detector heard speech. */
  loud: boolean;
  /** Frame number since the session started: frame N is the same moment on every mic. */
  index: number;
}

/** A sentence the segmenter cut out (onSegment): its audio and its times in seconds since the session started. */
export interface Segment {
  id: number;
  samples: Float32Array;
  start: number;
  end: number;
}

/** The sentence being spoken right now (Segmenter.current()); null when nobody speaks on that mic. */
export interface CurrentSegment {
  id: number;
  /** Seconds so far. */
  duration: number;
  start: number;
  samples(): Float32Array;
  /** Read only. */
  frames: Frame[];
  /** The first `settled` frames stay in the sentence whatever comes next; the rest is a pause that may end it. */
  settled: number;
}

export type DetectorName = 'silero' | 'energy';

/** A frame-level speech detector (SileroDetector, EnergyDetector in lib/vad.ts). */
export interface Detector {
  readonly name: DetectorName;
  /** Loud frames in a row that start a sentence. */
  readonly onsetFrames: number;
  isSpeech(samples: Float32Array, level: number): boolean;
  /** Silero only: a new threshold swaps in a detector that has it. */
  setThreshold?(threshold: number): void;
  /** Silero only: give the detector back to the pool for the next mic (#4). */
  release?(): void;
}

/**
 * A mic's background noise as the crosstalk gate learned it (lib/crosstalk.ts NoiseFloor), kept when the mics change
 * and across a reconnect (#44).
 */
export interface NoiseFloor {
  /** dB; the quietest fifth of the recent quiet frames. */
  readonly db: number;
  readonly learned: boolean;
  push(level: number, index: number): void;
  forget(index: number): void;
}
