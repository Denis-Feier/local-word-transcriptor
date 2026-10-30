import path from 'node:path';
import { ROOT } from '../config.js';
import { PYTHON_BIN } from '../python-env.js';
import { HOST, SidecarEngine } from './sidecar.js';

/** Runs an NVIDIA NeMo model (e.g. Jackrabbit) in python/nemo_server.py, a small local HTTP server. */
export class PythonNemoEngine extends SidecarEngine {
  supportsPrompt = false;

  constructor({ modelDir, nemo, threads, onCrash }) {
    super({ onCrash });
    Object.assign(this, { modelDir, nemo, threads });
  }

  command(port) {
    const args = [
      path.join(ROOT, 'python', 'nemo_server.py'),
      '--host', HOST,
      '--port', String(port),
      '--model', path.join(this.modelDir, this.nemo.model),
      '--decoder', this.nemo.decoder,
      '--threads', String(this.threads),
    ];
    if (this.nemo.lm) args.push('--lm', path.join(this.modelDir, this.nemo.lm));
    return {
      name: 'nemo',
      bin: PYTHON_BIN,
      args,
      env: { PYTHONUNBUFFERED: '1' },
      missing: 'The Python environment is missing. Run: npm run setup -- jackrabbit-110m-ro',
    };
  }

  async transcribe(samples) {
    const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength); // float32 PCM, 16 kHz mono
    const res = await fetch(`${this.url}/inference`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`nemo server: ${json.error ?? res.status}`);
    return { text: json.text ?? '' };
  }
}
