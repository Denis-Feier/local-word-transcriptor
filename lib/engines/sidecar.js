import { spawn } from 'node:child_process';
import net from 'node:net';

export const HOST = '127.0.0.1';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function freePort() {
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
 * A model served by a local HTTP process (whisper-server, the Python NeMo server, ...).
 * Subclasses provide command(port) -> { bin, args, name, missing } and transcribe().
 * onCrash(message) is called if the process dies after it loaded.
 */
export class SidecarEngine {
  constructor({ port = 0, onCrash } = {}) {
    this.port = port;
    this.onCrash = onCrash;
    this.child = null;
    this.logTail = [];
  }

  async load() {
    if (!this.port) this.port = await freePort();
    this.url = `http://${HOST}:${this.port}`;
    const { bin, args, name, missing, env } = this.command(this.port);
    let failure = null;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    this.child = child;
    const onLog = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        this.logTail.push(line);
        if (this.logTail.length > 40) this.logTail.shift();
        if (process.env.DEBUG) console.log(`[${name}] ${line}`);
      }
    };
    child.stdout.on('data', onLog);
    child.stderr.on('data', onLog);
    child.on('error', (err) => {
      failure = err.code === 'ENOENT' ? missing : `Could not start ${name}: ${err.message}`;
    });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // unloaded on purpose
      this.child = null;
      failure ??= `${name} exited (${signal ?? `code ${code}`}).\n${this.logTail.slice(-8).join('\n')}`;
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
