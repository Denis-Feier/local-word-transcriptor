// Shared by the test scripts (see TESTING.md): an isolated server per test, the streaming client,
// two "speakers" cut from the fixture, a room simulator for two-mic tests, and pass/fail bookkeeping.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeWav, encodeWav } from '../lib/wav.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SR = 16000;
export const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'ro.wav');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Inside Electron (the UI tests) process.execPath is Electron itself; servers and tools need Node.
const NODE = process.versions.electron ? process.env.NODE_BIN ?? 'node' : process.execPath;

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** A scratch folder for one test run; removed by cleanup(). */
export function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `transcriber-${name}-`));
}

/**
 * Start server.js on a free port with its own settings and transcripts folders, so a test never touches the
 * user's files or a copy of the app that is already running. Models come from ./models (MODELS_DIR overrides).
 * model: null starts without MODEL (the saved or default model); env values of undefined are removed.
 * maxFileBlocks: no file the server writes can grow past this many blocks, like a disk that fills up (sh's ulimit -f:
 * blocks of 1,024 bytes on macOS, 512 on Linux; not on Windows).
 */
export async function startServer({ model = process.env.TEST_MODEL ?? 'parakeet-ro-110m', env = {}, timeoutMs = 120000, maxFileBlocks = null } = {}) {
  const port = Number(env.PORT ?? (await freePort())); // env.PORT: restart on the same port (reconnect tests)
  const dir = scratch('server');
  let log = '';
  const childEnv = {
    ...process.env,
    PORT: String(port),
    MODEL: model ?? undefined,
    DEBUG: '1',
    SETTINGS_FILE: path.join(dir, 'settings.json'),
    TRANSCRIPTS_DIR: path.join(dir, 'transcripts'),
    ...env,
  };
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const script = path.join(ROOT, 'server.js');
  // Past the limit a write is cut short, then fails with EFBIG (Node ignores SIGXFSZ): what a full disk does.
  // exec keeps the pid.
  const [cmd, args] = maxFileBlocks
    ? ['/bin/sh', ['-c', `ulimit -f ${maxFileBlocks} && exec "$0" "$@"`, NODE, script]]
    : [NODE, [script]];
  const child = spawn(cmd, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  while (!/ready \(|✖/.test(log)) {
    if (child.exitCode !== null || Date.now() - t0 > timeoutMs) throw new Error(`server did not start:\n${log}`);
    await sleep(100);
  }
  if (log.includes('✖')) throw new Error(`server failed:\n${log}`);
  return {
    port,
    pid: child.pid,
    dir,
    url: `http://127.0.0.1:${port}`,
    ws: (query = '') => `ws://127.0.0.1:${port}/ws${query}`,
    log: () => log,
    transcripts: path.join(dir, 'transcripts'),
    settingsFile: path.join(dir, 'settings.json'),
    async stop() {
      const running = () => child.exitCode === null && child.signalCode === null; // a killed server has only a signal
      if (running()) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(8000)]);
        if (running()) child.kill('SIGKILL');
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run test/stream-wav.js against a server; returns its sentences ({ id, mic, start, end, text }), live guesses and exit code. */
export function streamWav(port, args, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [path.join(ROOT, 'test', 'stream-wav.js'), ...args], { env: { ...process.env, PORT: String(port) } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const t0 = Date.now();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      const finals = [...out.matchAll(/✔ #(\d+)(?: mic (\d))? \[([\d.]+)–([\d.]+)s\] \((\d+) ms\) (.*)/g)]
        .map(([, id, mic, start, end, ms, text]) => ({ id: +id, mic: mic ? +mic : 1, start: +start, end: +end, ms: +ms, text }));
      const partials = [...out.matchAll(/… #\d+(?: mic (\d))?/g)].map((m) => +(m[1] ?? 1));
      resolve({ finals, partials, code, out, timedOut: Date.now() - t0 >= timeoutMs, seconds: (Date.now() - t0) / 1000 });
    });
  });
}

export const loadWav = (file) => decodeWav(fs.readFileSync(file)).samples;
export const saveWav = (file, samples) => fs.writeFileSync(file, encodeWav(samples));

/** Two "speakers" cut from the fixture: A says the first sentence (6.8 s), B the other two (8.6 s). */
export function speakers() {
  const all = loadWav(FIXTURE);
  return { A: all.subarray(0, Math.round(6.8 * SR)), B: all.subarray(Math.round(7.3 * SR)) };
}

export const silence = (sec) => new Float32Array(Math.round(sec * SR));
export function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** What a mic across the room hears: a few early reflections and duller sound (one-pole low-pass). */
export function room(x) {
  const taps = [[0, 1], [0.011, 0.5], [0.023, 0.35], [0.041, 0.25], [0.067, 0.15]].map(([t, g]) => [Math.round(t * SR), g]);
  const out = new Float32Array(x.length + taps.at(-1)[0]);
  for (const [delay, gain] of taps) for (let i = 0; i < x.length; i++) out[i + delay] += gain * x[i];
  let y = 0;
  for (let i = 0; i < out.length; i++) out[i] = y = y + 0.35 * (out[i] - y);
  return out;
}

/**
 * Two mics in one room: each hears its own speaker plus the other one bleedDb quieter (with room sound), its own
 * noise (dBFS); mic 2 can arrive lagMs late (Bluetooth) and be gain2Db louder. Returns [mic1, mic2]. Seeded, so
 * every run gets the same audio.
 */
export function twoMics(a, b, { bleedDb = 12, lagMs = 0, gain2Db = 0, noise1 = -58, noise2 = -58, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const noise = (db) => {
    const amp = 10 ** (db / 20) * Math.sqrt(3); // uniform noise with this RMS
    return () => rnd() * amp;
  };
  const g = 10 ** (-bleedDb / 20);
  const lag = Math.round((lagMs / 1000) * SR);
  const v2 = 10 ** (gain2Db / 20);
  const ra = room(a);
  const rb = room(b);
  const n = Math.max(a.length, b.length) + SR + lag;
  const m1 = new Float32Array(n);
  const m2 = new Float32Array(n);
  const n1 = noise(noise1);
  const n2 = noise(noise2);
  for (let i = 0; i < n; i++) {
    m1[i] = (a[i] ?? 0) + g * (rb[i] ?? 0) + n1();
    if (i >= lag) m2[i] = v2 * ((b[i - lag] ?? 0) + g * (ra[i - lag] ?? 0) + n2());
  }
  return [m1, m2];
}

/**
 * Pass/fail bookkeeping. check() prints one line per case; finish() prints the tally, writes a JSON result when
 * TEST_RESULT is set (run-all.js collects them) and sets the exit code.
 */
export function suite(name) {
  const cases = [];
  return {
    check(id, title, ok, detail = '', { known = false } = {}) {
      const status = ok ? 'pass' : known ? 'known' : 'fail';
      cases.push({ id, title, status, detail });
      const mark = { pass: '✔', known: '◌', fail: '✖' }[status];
      console.log(`${mark} ${id} ${title}${detail ? ` — ${detail}` : ''}`);
      return ok;
    },
    skip(id, title, reason) {
      cases.push({ id, title, status: 'skip', detail: reason });
      console.log(`– ${id} ${title} — skipped: ${reason}`);
    },
    finish() {
      const count = (s) => cases.filter((c) => c.status === s).length;
      console.log(`\n${name}: ${count('pass')} passed, ${count('fail')} failed, ${count('known')} known limits, ${count('skip')} skipped`);
      if (process.env.TEST_RESULT) fs.writeFileSync(process.env.TEST_RESULT, JSON.stringify({ name, cases }, null, 2));
      process.exitCode = count('fail') ? 1 : 0;
    },
  };
}
