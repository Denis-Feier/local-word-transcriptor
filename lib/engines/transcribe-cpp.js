/** Runs a GGUF speech model (Canary, Parakeet, ...) in-process with transcribe.cpp on the GPU (Metal). */
export class TranscribeCppEngine {
  supportsPrompt = false;

  constructor({ modelPath, language }) {
    this.modelPath = modelPath;
    this.language = language;
    this.model = null;
  }

  async load() {
    const { TranscribeModel } = await import('transcribe-cpp');
    this.model = await TranscribeModel.load(this.modelPath);
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
