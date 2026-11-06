// The server's configuration (lib/config.js builds it from the environment) and the live speech-detection settings
// (lib/tuning.js). Phase 1 of docs/typescript-migration.md: written from what the code does today.

/** Voice-detection settings: the two detectors' thresholds and the timing of a sentence. */
export interface VadConfig {
  /** 'silero' (neural, robust in rooms) or 'energy' (loudness threshold); any other value counts as 'silero'. */
  engine: string;
  /** Path of silero_vad.onnx in the models folder. */
  sileroModel: string;
  /** Silero's speech probability threshold; lower picks up quieter, farther voices. */
  sileroThreshold: number;
  /** Energy detector only: the quietest level that counts as speech. */
  minRms: number;
  /** Energy detector only: how far above the noise floor speech must be. */
  noiseRatio: number;
  /** The pause that ends a sentence. */
  silenceMs: number;
  /** Audio kept from before speech was noticed. */
  preRollMs: number;
  /** Shorter sounds (a click, a cough) are dropped. */
  minSpeechMs: number;
  /** Longer speech is cut at its quietest recent moment. */
  maxSegmentSec: number;
}

export interface WhisperConfig {
  /** The whisper-server binary (name on PATH or absolute path). */
  bin: string;
  /** 0 picks a free port, so several instances never collide. */
  port: number;
  /** Names and jargon for the first sentence; empty by default. */
  initialPrompt: string;
}

export interface ElevenLabsConfig {
  /** Empty when there is no key: the cloud model is then not offered. */
  apiKey: string;
  /** A data-residency region, or the tests' stand-in; undefined for the default. */
  baseUrl: string | undefined;
}

/** `config` in lib/config.js. Sessions read the live values (vad, partialEverySec, crosstalkDb) on every use. */
export interface Config {
  host: string;
  port: number;
  /** The port people open: differs from `port` inside Docker. */
  publicPort: number;
  inDocker: boolean;
  transcriptsDir: string;
  settingsFile: string;
  defaultModel: string;
  /** Download the starting model when it is missing (the desktop app's first run). */
  autoInstall: boolean;
  /** ISO 639-1, 'ro' by default. */
  language: string;
  threads: number;
  whisper: WhisperConfig;
  vad: VadConfig;
  /** Live guesses refresh at most this often; slower models refresh less often by themselves. */
  partialEverySec: number;
  elevenlabs: ElevenLabsConfig;
  /** Microphones used at the same time (at least 1). */
  maxMics: number;
  /** With several mics, a mic ignores speech it hears this many dB less clearly than another mic. */
  crosstalkDb: number;
}

/** The six settings the page's Settings panel changes live (lib/tuning.js TUNING). */
export type TuningKey = 'vadThreshold' | 'silenceMs' | 'minSpeechMs' | 'maxSegmentSec' | 'partialEverySec' | 'crosstalkDb';

/** The current (or default) value of every live setting. */
export type Tuning = Record<TuningKey, number>;

/** A slider's range; the page builds its sliders from these. */
export interface TuningRange {
  min: number;
  max: number;
  step: number;
}

export type TuningRanges = Record<TuningKey, TuningRange>;

/** What the page sends when a slider moves, and what sanitizeTuning() accepts: unknown keys and non-numbers are dropped. */
export type TuningPatch = Partial<Tuning>;

/** The settings file (`.settings.json`; SETTINGS_FILE): the chosen model and the live settings, when changed. */
export interface Settings {
  model?: string;
  tuning?: TuningPatch;
}
