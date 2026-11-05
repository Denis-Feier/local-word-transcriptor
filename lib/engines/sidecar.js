import { spawn } from 'node:child_process';
import net from 'node:net';

export const HOST = '127.0.0.1';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A request whose connection broke waits this long for the process to be seen exiting, so a crash is reported first.
const EXIT_WAIT_MS = 3000;

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
 * Subclasses provide command(port, { cpu }) -> { bin, args, name, missing } and transcribe(); with cpuFallback set,
 * a process that fails to start on the GPU is started again with cpu: true. deviceFromLog(line), if given, names the
 * device from the process's start-up log. Subclasses send their requests with post().
 * onCrash(message) is called if the process dies after it loaded; a request it was serving fails after that call.
 */
export class SidecarEngine {
  constructor({ port = 0, onCrash } = {}) {
    this.port = port;
    this.onCrash = onCrash;
    this.child = null;
    this.logTail = [];
  }

  /**
   * Starts the process on the GPU when it has one (cpu: false), and once more on the CPU if that fails: a model the
   * GPU cannot take is slower on the CPU but still works. A missing program is not retried.
   */
  async load() {
    try {
      await this.#start({ cpu: false });
    } catch (err) {
      if (!this.cpuFallback || err.missing) throw err;
      this.fallback = err.message;
      if (process.env.DEBUG) console.log(`[sidecar] GPU start failed, retrying on the CPU: ${err.message}`);
      await this.unload();
      await this.#start({ cpu: true });
    }
  }

  async #start({ cpu }) {
    if (!this.port) this.port = await freePort();
    this.url = `http://${HOST}:${this.port}`;
    const { bin, args, name, missing, env } = this.command(this.port, { cpu });
    let failure = null;
    let isMissing = false;
    this.ready = false;
    this.device = cpu ? 'CPU' : null;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    this.child = child;
    const onLog = (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        this.logTail.push(line);
        if (this.logTail.length > 40) this.logTail.shift();
        const device = this.ready ? null : this.deviceFromLog?.(line);
        if (device) this.device = device; // the last word wins ("failed to initialize" after "using MTL0 backend")
        if (process.env.DEBUG) console.log(`[${name}] ${line}`);
      }
    };
    child.stdout.on('data', onLog);
    child.stderr.on('data', onLog);
    child.on('error', (err) => {
      isMissing = err.code === 'ENOENT';
      failure = isMissing ? missing : `Could not start ${name}: ${err.message}`;
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
          // The NeMo server says where it put the model; whisper-server says it in its log.
          const health = await res.json().catch(() => ({}));
          if (health.device) this.device = health.device;
          if (health.fallback) this.fallback = health.fallback; // it moved to the CPU while it started
          this.device ??= cpu ? 'CPU' : this.defaultDevice ?? 'CPU';
          this.ready = true;
          return;
        }
      } catch {
        // not listening yet
      }
      await sleep(250);
    }
    throw Object.assign(new Error(failure), { missing: isMissing });
  }

  /**
   * POST to the process; resolves to { ok, status, text }. When the connection breaks because the process died (it is
   * killed, or crashes on the GPU), the request fails only once its exit is seen and onCrash has been called, so the
   * transcriber knows to send the sentence again when the model is back (#45).
   */
  async post(path, init) {
    try {
      const res = await fetch(`${this.url}${path}`, { method: 'POST', ...init });
      return { ok: res.ok, status: res.status, text: await res.text() };
    } catch (err) {
      await this.#exited(EXIT_WAIT_MS);
      throw err;
    }
  }

  /** Resolves when the process has exited (and its exit was handled), or after ms if it is still running. */
  async #exited(ms) {
    const { child } = this;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    let timer;
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
    clearTimeout(timer);
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
