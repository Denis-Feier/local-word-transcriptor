import { spawn } from 'node:child_process';
import net from 'node:net';
import { encodeWav } from '../wav.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const HOST = '127.0.0.1';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, HOST, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Runs whisper.cpp's `whisper-server` as a child process; the model stays loaded on the GPU (Metal).
 * onCrash(message) is called if the process dies after it loaded.
 */
export class WhisperCppEngine {
  supportsPrompt = true;

  constructor({ bin, modelPath, port, language, threads, onCrash }) {
    Object.assign(this, { bin, modelPath, port, language, threads, onCrash });
    this.child = null;
    this.logTail = [];
  }

  async load() {
    if (!this.port) this.port = await freePort();
    this.url = `http://${HOST}:${this.port}`;
    const args = [
      '-m', this.modelPath,
      '--host', HOST,
      '--port', String(this.port),
      '-l', this.language,
      '-t', String(this.threads),
      '--suppress-nst', // drop non-speech tokens like [Muzică]
    ];
    let failure = null;
    const child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const onLog = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        this.logTail.push(line);
        if (this.logTail.length > 40) this.logTail.shift();
        if (process.env.DEBUG) console.log(`[whisper] ${line}`);
      }
    };
    child.stdout.on('data', onLog);
    child.stderr.on('data', onLog);
    child.on('error', (err) => {
      failure = err.code === 'ENOENT'
        ? `"${this.bin}" not found. Install whisper.cpp with: brew install whisper-cpp`
        : `Could not start whisper-server: ${err.message}`;
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // unloaded on purpose
      this.child = null;
      failure ??= `whisper-server exited (${signal ?? `code ${code}`}).\n${this.logTail.slice(-8).join('\n')}`;
      if (this.ready) this.onCrash?.(failure);
    });

    while (!failure) {
      try {
        const res = await fetch(`${this.url}/health`);
        if (res.ok) {
          this.ready = true;
          return;
        }
      } catch {
        // not listening yet
      }
      await sleep(250);
    }
    throw new Error(failure);
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

  async unload() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, sleep(3000)]);
  }

  /** Synchronous last-resort cleanup for process exit. */
  kill() {
    this.child?.kill('SIGTERM');
  }
}
