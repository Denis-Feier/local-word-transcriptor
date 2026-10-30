import { encodeWav } from '../wav.js';
import { HOST, SidecarEngine } from './sidecar.js';

/** Runs whisper.cpp's `whisper-server` as a child process; the model stays loaded on the GPU (Metal). */
export class WhisperCppEngine extends SidecarEngine {
  supportsPrompt = true;

  constructor({ bin, modelPath, port, language, threads, onCrash }) {
    super({ port, onCrash });
    Object.assign(this, { bin, modelPath, language, threads });
  }

  command(port) {
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
      ],
      missing: `"${this.bin}" not found. Install whisper.cpp with: brew install whisper-cpp`,
    };
  }

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

    const res = await fetch(`${this.url}/inference`, { method: 'POST', body: form });
    const body = await res.text();
    if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}: ${body.slice(0, 200)}`);
    const json = JSON.parse(body);
    if (json.error) throw new Error(`whisper-server: ${json.error}`);
    // Segments are joined with "\n" and can split mid-word ("cab\nană"); new words carry their own space.
    return { text: (json.text ?? '').replace(/\n/g, '') };
  }
}
