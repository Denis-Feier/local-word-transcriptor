import { encodeWav } from '../wav.js';
import { HOST, SidecarEngine } from './sidecar.js';
/** @import { OnCrash, SidecarCommand, TranscribeOptions, TranscribeResult } from '../../types/engine.ts' */

/**
 * Runs whisper.cpp's `whisper-server` as a child process; the model stays loaded on the GPU (Metal). If the server
 * cannot start on the GPU it is started again without it (`--no-gpu`).
 */
export class WhisperCppEngine extends SidecarEngine {
  supportsPrompt = true;
  cpuFallback = true;
  defaultDevice = 'GPU'; // started without --no-gpu and no "no GPU found" in the log: it uses the GPU it found

  /** @param {{ bin: string, modelPath: string, port: number, language: string, threads: number, onCrash?: OnCrash }} opts */
  constructor({ bin, modelPath, port, language, threads, onCrash }) {
    super({ port, onCrash });
    this.bin = bin;
    this.modelPath = modelPath;
    this.language = language;
    this.threads = threads;
  }

  /**
   * @param {number} port
   * @param {{ cpu?: boolean }} [opts]
   * @returns {SidecarCommand}
   */
  command(port, { cpu = false } = {}) {
    return {
      name: 'whisper',
      bin: this.bin,
      args: [
        '-m', this.modelPath,
        '--host', HOST,
        '--port', String(port),
        '-l', this.language,
        '-t', String(this.threads),
        '--suppress-nst', // drop non-speech tokens like [Muzică]
        ...(cpu ? ['--no-gpu'] : []),
      ],
      missing: `"${this.bin}" not found. Install whisper.cpp with: brew install whisper-cpp`,
    };
  }

  /**
   * whisper.cpp logs the GPU it picks by its device name ("whisper_backend_init_gpu: using MTL0 backend", CUDA0,
   * Vulkan0; older builds "Metal"), or "no GPU found", or that the GPU failed to start (then it runs on the CPU).
   * Other "using … backend" lines (BLAS, the CPU) come after and say nothing about the GPU.
   * @param {string} line
   * @returns {string | null}
   */
  deviceFromLog(line) {
    if (!line.includes('whisper_backend_init_gpu')) return null;
    if (/no GPU found|failed to initialize/i.test(line)) return 'CPU';
    const name = line.match(/using (\S+) backend/)?.[1];
    if (!name) return null;
    const kind = [['mtl', 'Metal'], ['metal', 'Metal'], ['cuda', 'CUDA'], ['vulkan', 'Vulkan'], ['rocm', 'ROCm'], ['hip', 'ROCm']]
      .find(([prefix]) => name.toLowerCase().startsWith(prefix))?.[1];
    return `GPU (${kind ?? name})`;
  }

  /**
   * @param {Float32Array} samples
   * @param {TranscribeOptions} [opts]
   * @returns {Promise<TranscribeResult>}
   */
  async transcribe(samples, { prompt = '', fallback = true } = {}) {
    const form = new FormData();
    form.append('file', new Blob([encodeWav(samples)], { type: 'audio/wav' }), 'audio.wav');
    // whisper-server keeps request parameters between calls, so every field we care about is sent each time.
    form.append('language', this.language);
    form.append('response_format', 'json'); // verbose_json computes word timings: +0.4 s per request
    form.append('prompt', prompt);
    form.append('temperature', '0.0');
    form.append('temperature_inc', fallback ? '0.2' : '0.0');
    form.append('no_timestamps', 'false');

    const res = await this.post('/inference', { body: form });
    const body = res.text;
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}: ${body.slice(0, 200)}`);
    const json = JSON.parse(body);
    if (json.error) throw new Error(`whisper-server: ${json.error}`);
    // Segments are joined with "\n" and can split mid-word ("cab\nană"); new words carry their own space.
    return { text: (json.text ?? '').replace(/\n/g, '') };
  }
}
