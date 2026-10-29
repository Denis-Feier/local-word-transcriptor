import { createRequire } from 'node:module';
import { SAMPLE_RATE } from '../wav.js';

const require = createRequire(import.meta.url);

/** Runs an ONNX speech model in-process with sherpa-onnx (Parakeet, Canary, Whisper-ONNX, ...). */
export class SherpaEngine {
  supportsPrompt = false;

  constructor({ recognizerConfig, threads }) {
    this.config = recognizerConfig;
    this.config.modelConfig = { numThreads: threads, provider: 'cpu', debug: 0, ...this.config.modelConfig };
    this.recognizer = null;
  }

  async load() {
    const { OfflineRecognizer } = require('sherpa-onnx-node');
    this.recognizer = await OfflineRecognizer.createAsync(this.config);
  }

  async transcribe(samples) {
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
    const result = await this.recognizer.decodeAsync(stream);
    return { text: result.text ?? '' };
  }

  async unload() {
    this.recognizer = null; // native memory is released when the handle is garbage-collected
  }

  kill() {}
}
