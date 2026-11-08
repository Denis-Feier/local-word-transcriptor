// Declarations for dependencies that ship none: only the surface this app uses (docs/typescript-migration.md, E11).

// Inside the desktop app the server runs as an Electron utility process, which gives it a port to its parent;
// desktop/main.ts sends 'shutdown' over it (server.ts). Node's own types do not know the port.
declare namespace NodeJS {
  interface Process {
    parentPort?: { on(event: 'message', listener: (e: { data: unknown }) => void): void };
  }
}

declare module 'sherpa-onnx-node' {
  /** The Silero voice detector's settings, as lib/vad.ts builds them. */
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
    /** As given to the constructor. */
    readonly config: VadConfig;
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
