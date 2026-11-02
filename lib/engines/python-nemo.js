import path from 'node:path';
import { ROOT } from '../config.js';
import { PYTHON_BIN } from '../python-env.js';
import { HOST, SidecarEngine } from './sidecar.js';

/**
 * Runs an NVIDIA NeMo model (Jackrabbit, the UPB FastConformer) in python/nemo_server.py, a small local HTTP server.
 * The server puts the model on the GPU when PyTorch has one (MPS on a Mac) and on the CPU otherwise; if it cannot
 * start that way it is started again with --device cpu.
 */
export class PythonNemoEngine extends SidecarEngine {
  supportsPrompt = false;
  cpuFallback = true;

  constructor({ id, modelDir, nemo, threads, onCrash }) {
    super({ onCrash });
    Object.assign(this, { id, modelDir, nemo, threads });
  }

  command(port, { cpu = false } = {}) {
    const args = [
      path.join(ROOT, 'python', 'nemo_server.py'),
      '--host', HOST,
      '--port', String(port),
      '--model', path.join(this.modelDir, this.nemo.model),
      '--decoder', this.nemo.decoder,
      '--threads', String(this.threads),
      '--device', cpu ? 'cpu' : process.env.NEMO_DEVICE || 'auto', // NEMO_DEVICE=cpu: to compare with the GPU
    ];
    if (this.nemo.lm) args.push('--lm', path.join(this.modelDir, this.nemo.lm));
    return {
      name: 'nemo',
      bin: PYTHON_BIN,
      args,
      // Operations MPS lacks run on the CPU instead of failing.
      env: { PYTHONUNBUFFERED: '1', PYTORCH_ENABLE_MPS_FALLBACK: '1' },
      missing: `The Python environment is missing. Run: npm run setup -- ${this.id}`,
    };
  }

  async transcribe(samples) {
    const body = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength); // float32 PCM, 16 kHz mono
    const res = await fetch(`${this.url}/inference`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' } });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(`nemo server: ${json.error ?? res.status}`);
    if (json.device) Object.assign(this, { device: json.device, fallback: json.fallback ?? this.fallback }); // moved to the CPU?
    return { text: json.text ?? '' };
  }
}
