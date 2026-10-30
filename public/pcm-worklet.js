// Runs on the audio thread: converts each mic (one input per mic) to 16 kHz mono Float32 and posts ~100 ms chunks.
// A chunk is an ArrayBuffer: a Uint32 mic count, then each mic's 1600 samples in turn, all from the same moment.
const TARGET_RATE = 16000;
const CHUNK = 1600;

class PcmCapture extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.mics = processorOptions.mics;
    this.ratio = sampleRate / TARGET_RATE; // sampleRate is a global in AudioWorkletGlobalScope
    this.phase = 0;
    this.sums = new Float32Array(this.mics);
    this.count = 0;
    this.length = 0;
    this.newChunk();
  }

  newChunk() {
    this.buffer = new ArrayBuffer(4 + this.mics * CHUNK * 4);
    new Uint32Array(this.buffer, 0, 1)[0] = this.mics;
    this.chunk = new Float32Array(this.buffer, 4);
  }

  process(inputs) {
    // A mic that is not connected (yet, or any more) has no channels: it records silence, so the others stay in step.
    const channels = inputs.map((input) => input[0]);
    const frames = channels.find(Boolean)?.length ?? 128;
    // Downsample by averaging the source samples that fall into each output sample (box low-pass).
    for (let i = 0; i < frames; i++) {
      for (let m = 0; m < this.mics; m++) this.sums[m] += channels[m]?.[i] ?? 0;
      this.count++;
      this.phase += 1;
      if (this.phase < this.ratio) continue;
      this.phase -= this.ratio;
      for (let m = 0; m < this.mics; m++) {
        this.chunk[m * CHUNK + this.length] = this.sums[m] / this.count;
        this.sums[m] = 0;
      }
      this.count = 0;
      if (++this.length === CHUNK) {
        this.port.postMessage(this.buffer, [this.buffer]);
        this.newChunk();
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
