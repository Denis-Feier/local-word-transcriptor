/**
 * Runs a GGUF speech model (Canary, Parakeet, ...) in-process with transcribe.cpp. GPU first (Metal on a Mac): the
 * library's "auto" backend picks the best accelerator. If the model cannot be loaded there, it is loaded on the CPU.
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

  async load() {
    const loadModel = this.loadModel ?? (async (file, options) => (await import('transcribe-cpp')).TranscribeModel.load(file, options));
    try {
      this.model = await loadModel(this.modelPath, { backend: 'auto' });
    } catch (err) {
      // The GPU could not take the model (a driver or memory problem): the CPU is slower but still works.
      this.fallback = err.message;
      this.model = await loadModel(this.modelPath, { backend: 'cpu' });
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
    const result = await this.model.transcribe(samples, options);
    return { text: result.text ?? '' };
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
