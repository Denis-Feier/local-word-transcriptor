// The audio pipeline's shapes: frames, sentences, detectors, the crosstalk gate's noise floors and WAV files
// (lib/vad.js, lib/segmenter.js, lib/crosstalk.js, lib/wav.js). Phase 1 of docs/typescript-migration.md.

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

/** A frame-level speech detector (SileroDetector, EnergyDetector in lib/vad.js). */
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

/** The timing of a sentence; the live settings change it mid-session (Segmenter.setTiming). */
export interface SegmentTiming {
  silenceMs: number;
  preRollMs: number;
  minSpeechMs: number;
  maxSegmentSec: number;
}

export interface SegmenterOptions extends SegmentTiming {
  detector: Detector;
  onSpeechStart?(id: number): void;
  onSegment?(segment: Segment): void;
  /** Too little speech: a click or a cough. */
  onDiscard?(id: number): void;
  /** A mic added mid-session starts at the session's current frame. */
  startFrame?: number;
  /** Audio not yet cut into frames, carried over from the previous layout. */
  leftover?: Float32Array;
  /** Several mics share one id sequence. */
  newId?(): number;
}

/**
 * A mic's background noise as the crosstalk gate learned it (lib/crosstalk.js NoiseFloor), kept when the mics change
 * and across a reconnect (#44).
 */
export interface NoiseFloor {
  /** dB; the quietest fifth of the recent quiet frames. */
  readonly db: number;
  readonly learned: boolean;
  push(level: number, index: number): void;
  forget(index: number): void;
}

/** What WavWriter takes besides the file. */
export interface WavWriterOptions {
  sampleRate?: number;
  /** Carry on an existing file after its last whole sample (the page reconnected, #10). */
  resume?: boolean;
}

/** decodeWav(): a mono WAV's samples as floats. */
export interface DecodedWav {
  sampleRate: number;
  samples: Float32Array;
}

// ---------- the page's audio backlog (public/backlog.js; here, not in page.ts, because the unit tests import it) ----------

export interface BacklogTaken {
  /** Oldest first. */
  chunks: ArrayBuffer[];
  dropped: number;
}

/** createBacklog(): audio kept while the server is unreachable (#11). */
export interface Backlog {
  push(chunk: ArrayBuffer): void;
  readonly dropped: number;
  /** Everything kept and how many chunks were dropped; empties the backlog. */
  take(): BacklogTaken;
}
