// Declarations for dependencies that ship none: only the surface this app uses (docs/typescript-migration.md, E11).

declare module 'sherpa-onnx-node' {
  /** The Silero voice detector's settings, as lib/vad.js builds them. */
  export interface SileroVadConfig {
    model: string;
    threshold: number;
    minSilenceDuration: number;
    minSpeechDuration: number;
    windowSize: number;
    maxSpeechDuration: number;
  }

  export interface VadConfig {
    sileroVad: SileroVadConfig;
    sampleRate: number;
    numThreads: number;
    provider: string; // 'cpu' here: a 2 MB model on every 32 ms frame, where a GPU round trip costs more than it saves
    debug: boolean;
  }

  /** A stretch of speech the detector cut out; the app ignores these (its own Segmenter cuts sentences). */
  export interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }

  /** sherpa-onnx's voice activity detector (node_modules/sherpa-onnx-node/vad.js). */
  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    clear(): void;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    reset(): void;
    flush(): void;
  }
}
