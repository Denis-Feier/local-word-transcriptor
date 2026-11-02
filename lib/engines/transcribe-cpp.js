/**
 * Runs a GGUF speech model (Canary, Parakeet, ...) in-process with transcribe.cpp. GPU first (Metal on a Mac, Vulkan on
 * Windows and Linux): the library's "auto" backend picks the best accelerator. If the model cannot be loaded there, it
 * is loaded on the CPU; if the GPU later fails on a sentence the CPU can transcribe, the model stays on the CPU.
 */
export class TranscribeCppEngine {
  supportsPrompt = false;

  constructor({ modelPath, language, load }) {
    this.modelPath = modelPath;
    this.language = language;
    this.loadModel = load; // tests stand in a fake loader: (path, options) => model
    this.model = null;
    this.device = null; // 'GPU (Metal)', 'CPU', ... once loaded
    this.fallback = null; // why the GPU was not used, when it was not
  }

  #load(backend) {
    const loadModel = this.loadModel ?? (async (file, options) => (await import('transcribe-cpp')).TranscribeModel.load(file, options));
    return loadModel(this.modelPath, { backend });
  }

  async load() {
    try {
      this.model = await this.#load('auto');
    } catch (err) {
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

  async transcribe(samples, { prompt = '' } = {}) {
    const options = {};
    if (this.hint) options.language = this.hint;
    if (this.supportsPrompt && prompt) options.prompt = prompt;
    const run = async (model) => ({ text: (await model.transcribe(samples, options)).text ?? '' });
    try {
      return await run(this.model);
    } catch (err) {
      if (this.device === 'CPU') throw err;
      // The GPU failed on this sentence (e.g. out of video memory on a long one). If the CPU can transcribe it, the
      // GPU is at fault and the rest of the meeting runs on the CPU; if the CPU fails too, the audio is, and the model
      // stays on the GPU.
      let cpu = null;
      let result;
      try {
        cpu = await this.#load('cpu');
        result = await run(cpu);
      } catch {
        cpu?.dispose();
        throw err;
      }
      this.model.dispose();
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

  kill() {
    this.model?.dispose();
  }
}

// ggml names devices 'Metal' or 'MTL0', 'CUDA0', 'ROCm0', 'Vulkan0'...
const GPU_BACKENDS = { metal: 'Metal', mtl: 'Metal', cuda: 'CUDA', rocm: 'ROCm', vulkan: 'Vulkan' };

/** 'GPU (Metal)', 'CPU', ... from the device transcribe.cpp chose. */
export function describeDevice(model) {
  let info = null;
  try {
    info = model.device;
  } catch {
    // a build that does not report its device
  }
  const backend = String(model.backend ?? info?.kind ?? '').toLowerCase();
  const known = Object.keys(GPU_BACKENDS).find((k) => backend.startsWith(k));
  const gpu = known ? GPU_BACKENDS[known] : (['gpu', 'igpu'].includes(info?.deviceType) ? info.name || backend : null);
  return gpu ? `GPU (${gpu})` : 'CPU';
}
