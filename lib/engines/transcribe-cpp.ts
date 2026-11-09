/**
 * Runs a GGUF speech model (Canary, Parakeet, ...) in-process with transcribe.cpp. GPU first (Metal on a Mac, Vulkan on
 * Windows and Linux): the library's "auto" backend picks the best accelerator. If the model cannot be loaded there, it
 * is loaded on the CPU; if the GPU later fails on a sentence the CPU can transcribe, the model stays on the CPU. A
 * sentence whose decoding stopped early (its output began repeating, or reached the model's limit) is no failure: its
 * text up to there is the answer, on whichever device.
 */
import path from 'node:path';
import type { TranscribeOptions, TranscribeResult } from '../../types/engine.ts';

/** What this engine needs from a loaded model: transcribe.cpp's TranscribeModel, or a test's stand-in. */
export type LoadedModel = {
  transcribe(samples: Float32Array, options: { language?: string; prompt?: string }): Promise<{ text?: string }>;
  dispose(): void;
  capabilities?: { languages?: readonly string[] };
  supports?(feature: string): boolean;
  device?: DeviceInfo | null;
  backend?: string;
};
/** What transcribe.cpp says about the device a model runs on. */
export type DeviceInfo = { kind?: string; deviceType?: string; name?: string };
export type LoadModel = (file: string, options: { backend: 'auto' | 'cpu' }) => Promise<LoadedModel>;

/**
 * transcribe.cpp's errors for a decoding it stopped early, with the text so far in `partialResult` (repeats dropped):
 * OutputRepetition ("run stopped: output began repeating") and OutputTruncated (the generation limit). They say what
 * the model wrote for this audio, not that the device failed.
 */
const STOPPED_EARLY = new Set(['OutputRepetition', 'OutputTruncated']);
const partialText = (err: any): string | null => (STOPPED_EARLY.has(err?.name) && typeof err.partialResult?.text === 'string' ? err.partialResult.text : null);

export class TranscribeCppEngine {
  supportsPrompt = false;
  /** kill() was called (the server is exiting, #62): a load that fails is not tried again on the CPU. */
  killed = false;
  modelPath: string;
  language: string;
  loadModel: LoadModel | undefined;
  model: LoadedModel | null;
  device: string | null;
  fallback: string | null;
  declare hint: string | undefined; // the language hint the model takes; load() sets it

  constructor({ modelPath, language, load }: { modelPath: string; language: string; load?: LoadModel }) {
    this.modelPath = modelPath;
    this.language = language;
    this.loadModel = load; // tests stand in a fake loader: (path, options) => model
    this.model = null;
    this.device = null; // 'GPU (Metal)', 'CPU', ... once loaded
    this.fallback = null; // why the GPU was not used, when it was not
  }

  async #load(backend: 'auto' | 'cpu') {
    let loadModel: LoadModel | undefined = this.loadModel;
    if (!loadModel) {
      const { TranscribeModel } = await import('transcribe-cpp');
      loadModel = (file, options) => TranscribeModel.load(file, options);
    }
    if (this.killed) throw new Error('The model was not loaded: the server is stopping'); // killed while the library loaded
    // The native load starts right after this line; PROT-RUN-03 times its signal by it.
    if (process.env.DEBUG) console.log(`[transcribe.cpp] loading ${path.basename(this.modelPath)} on ${backend}`);
    return loadModel(this.modelPath, { backend });
  }

  async load() {
    try {
      this.model = await this.#load('auto');
    } catch (err: any) {
      if (this.killed) throw err; // the server is exiting (#62): no second load to wait for
      // The GPU could not take the model (a driver or memory problem): the CPU is slower but still works.
      this.fallback = err.message;
      this.model = await this.#load('cpu');
    }
    this.device = describeDevice(this.model);
    const { languages = [] } = this.model.capabilities ?? {};
    // Only pass a language hint the model knows; auto-detecting models (Parakeet) take none.
    this.hint = languages.includes(this.language) ? this.language : undefined;
    this.supportsPrompt = this.model.supports?.('context_prompt') === true;
  }

  async transcribe(samples: Float32Array, { prompt = '' }: TranscribeOptions = {}): Promise<TranscribeResult> {
    const options: { language?: string; prompt?: string } = {};
    if (this.hint) options.language = this.hint;
    if (this.supportsPrompt && prompt) options.prompt = prompt;
    const run = async (model: LoadedModel) => {
      try {
        return { text: (await model.transcribe(samples, options)).text ?? '' };
      } catch (err: any) {
        // Decoding stopped early: keep the text before it, on this device. Moving to the CPU for it cost a 2-hour
        // soak its GPU: the CPU, decoding the same audio a little differently, did not repeat, so the GPU was taken
        // to be at fault (STRESS-SOAK-08, 2026-11-09).
        const text = partialText(err);
        if (text === null) throw err;
        if (process.env.DEBUG) console.log(`[transcribe.cpp] ${err.message}: kept the text before it`);
        return { text: text.trim() };
      }
    };
    const loaded = this.model as LoadedModel; // transcribe() comes after load()
    try {
      return await run(loaded);
    } catch (err: any) {
      if (this.device === 'CPU') throw err;
      // The GPU failed on this sentence (e.g. out of video memory on a long one). If the CPU can transcribe it, the
      // GPU is at fault and the rest of the meeting runs on the CPU; if the CPU fails too, the audio is, and the model
      // stays on the GPU.
      let cpu: LoadedModel | null = null;
      let result;
      try {
        cpu = await this.#load('cpu');
        result = await run(cpu);
      } catch {
        cpu?.dispose();
        throw err;
      }
      loaded.dispose();
      this.model = cpu;
      this.device = 'CPU';
      this.fallback = err.message;
      return result;
    }
  }

  async unload() {
    this.model?.dispose();
    this.model = null;
  }

  /**
   * Synchronous cleanup for process exit. A load in progress cannot be stopped, and exiting under it hangs (#62): the
   * transcriber waits for it and then unload()s the model.
   */
  kill() {
    this.killed = true;
    this.model?.dispose();
  }
}

// ggml names devices 'Metal' or 'MTL0', 'CUDA0', 'ROCm0', 'Vulkan0'...
const GPU_BACKENDS: Record<string, string> = { metal: 'Metal', mtl: 'Metal', cuda: 'CUDA', rocm: 'ROCm', vulkan: 'Vulkan' };

/** 'GPU (Metal)', 'CPU', ... from the device transcribe.cpp chose. */
export function describeDevice(model: LoadedModel) {
  let info: DeviceInfo | null | undefined = null;
  try {
    info = model.device;
  } catch {
    // a build that does not report its device
  }
  const backend = String(model.backend ?? info?.kind ?? '').toLowerCase();
  const known = Object.keys(GPU_BACKENDS).find((k) => backend.startsWith(k));
  const gpu = known ? GPU_BACKENDS[known] : (['gpu', 'igpu'].includes(info?.deviceType as string) ? (info as DeviceInfo).name || backend : null);
  return gpu ? `GPU (${gpu})` : 'CPU';
}
