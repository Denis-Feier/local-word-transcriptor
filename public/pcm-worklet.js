// Runs on the audio thread: converts mic input to 16 kHz mono Float32 and posts ~100 ms chunks.
const TARGET_RATE = 16000;
const CHUNK = 1600;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // sampleRate is a global in AudioWorkletGlobalScope
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.chunk = new Float32Array(CHUNK);
    this.length = 0;
  }

  emit(sample) {
    this.chunk[this.length++] = sample;
    if (this.length === CHUNK) {
      this.port.postMessage(this.chunk, [this.chunk.buffer]);
      this.chunk = new Float32Array(CHUNK);
      this.length = 0;
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < input.length; i++) this.emit(input[i]);
      return true;
    }
    // Downsample by averaging the source samples that fall into each output sample (box low-pass).
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        this.emit(this.sum / this.count);
        this.sum = 0;
        this.count = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
