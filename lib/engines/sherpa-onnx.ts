/**
 * Runs a NeMo transducer exported to ONNX (Parakeet Redux) in-process with sherpa-onnx, on the CPU: the one engine
 * without a GPU path. sherpa-onnx-node already ships with the app for the voice detector, so nothing else is needed.
 * It came back for #60 after #38 had moved Parakeet v3 from it to transcribe.cpp.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { SAMPLE_RATE } from '../wav.ts';
import type { OfflineRecognizerConfig } from 'sherpa-onnx-node';
import type { TranscribeResult } from '../../types/engine.ts';
import type { SherpaSpec } from '../../types/model.ts';

const require = createRequire(import.meta.url);

/** What this engine needs from a recognizer: sherpa-onnx's OfflineRecognizer, or a test's stand-in. */
export type Recognizer = {
  createStream(): { acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void };
  decodeAsync(stream: ReturnType<Recognizer['createStream']>): Promise<{ text?: string }>;
};
export type CreateRecognizer = (config: OfflineRecognizerConfig) => Promise<Recognizer>;

export class SherpaOnnxEngine {
  supportsPrompt = false;
  /** kill() was called (the server is exiting, #62): a load that has not begun never begins. */
  killed = false;
  device: string | null = null;
  fallback: string | null = null;
  config: OfflineRecognizerConfig;
  create: CreateRecognizer | undefined;
  recognizer: Recognizer | null = null;

  constructor({ modelDir, sherpa, threads, create }: { modelDir: string; sherpa: SherpaSpec; threads: number; create?: CreateRecognizer }) {
    const file = (name: string) => path.join(modelDir, name);
    this.config = {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, // NeMo's 80 mel bands
      modelConfig: {
        transducer: { encoder: file(sherpa.encoder), decoder: file(sherpa.decoder), joiner: file(sherpa.joiner) },
        tokens: file(sherpa.tokens),
        modelType: sherpa.modelType,
        numThreads: threads,
        provider: 'cpu',
        debug: 0,
      },
    };
    this.create = create; // tests stand in a fake recognizer
  }

  async load() {
    let create = this.create;
    if (!create) {
      const { OfflineRecognizer } = require('sherpa-onnx-node') as typeof import('sherpa-onnx-node');
      create = (config) => OfflineRecognizer.createAsync(config);
    }
    if (this.killed) throw new Error('The model was not loaded: the server is stopping');
    this.recognizer = await create(this.config); // rejects on a missing or broken file, without taking the server down
    this.device = 'CPU';
  }

  async transcribe(samples: Float32Array): Promise<TranscribeResult> {
    const recognizer = this.recognizer as Recognizer; // transcribe() comes after load()
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    const result = await recognizer.decodeAsync(stream);
    return { text: (result.text ?? '').trim() };
  }

  async unload() {
    this.recognizer = null; // the native memory is freed when the handle is garbage-collected
  }

  /**
   * Synchronous cleanup for process exit: nothing runs outside this process. A load in progress cannot be stopped; the
   * transcriber waits for it and unload()s the model.
   */
  kill() {
    this.killed = true;
    this.recognizer = null;
  }
}
