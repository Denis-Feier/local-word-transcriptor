// Shared by the test scripts (see TESTING.md): an isolated server per test, the streaming client,
// two "speakers" cut from the fixture, a room simulator for two-mic tests, and pass/fail bookkeeping.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { decodeWav, encodeWav } from '../lib/wav.ts';
import type { FakeConnection, FakeElevenLabs, FakeServer, StartServerOptions, StreamResult, Suite, TestCase, TestServer } from '../types/test.ts';
import type { ServerMessage } from '../types/protocol.ts';

/** serverMemory(): MB, as the system charges it (and its resident size) and as the server reports its parts (#48). */
export interface ServerMemory {
  mb: number;
  rss: number;
  /** mb is the physical footprint (macOS), not the resident size. */
  footprint: boolean;
  heap?: number;
  used?: number;
  external?: number;
  native?: number;
}

export interface FakeElevenLabsOptions {
  key?: string;
  /** The text that answers a commit. */
  text?(c: FakeConnection): string;
  /** The live text that answers each chunk; null for none. */
  partial?(c: FakeConnection): string | null;
  /** A server error type to answer the commit with instead, e.g. 'quota_exceeded'; null for none. */
  fail?(c: FakeConnection): string | null;
}

export interface FakeServerOptions {
  /** Sent to the page after the ready status, before the mics limit. */
  greet?: ServerMessage[];
}

export interface TwoMicsOptions {
  bleedDb?: number;
  lagMs?: number;
  gain2Db?: number;
  /** dBFS. */
  noise1?: number;
  noise2?: number;
  seed?: number;
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SR = 16000;
export const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'ro.wav');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Inside Electron (the UI tests) process.execPath is Electron itself; servers and tools need Node.
const NODE = process.versions.electron ? process.env.NODE_BIN ?? 'node' : process.execPath;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as import('node:net').AddressInfo; // listening on a TCP port
      probe.close(() => resolve(port));
    });
  });
}

/** A scratch folder for one test run; removed by cleanup(). */
export function scratch(name: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `transcriber-${name}-`));
}

/**
 * Start server.ts on a free port with its own settings and transcripts folders, so a test never touches the
 * user's files or a copy of the app that is already running. Models come from ./models (MODELS_DIR overrides).
 * model: null starts without MODEL (the saved or default model); env values of undefined are removed.
 * Never the user's .env.local or ElevenLabs key: an ElevenLabs key is allowed only with the stand-in (fakeElevenLabs).
 * maxFileBlocks: no file the server writes can grow past this many blocks, like a disk that fills up (sh's ulimit -f:
 * blocks of 1,024 bytes on macOS, 512 on Linux; not on Windows).
 */
export async function startServer({ model = process.env.TEST_MODEL ?? 'parakeet-ro-110m', env = {}, timeoutMs = 120000, maxFileBlocks = null, until = 'ready' }: StartServerOptions = {}): Promise<TestServer> {
  const port = Number(env.PORT ?? (await freePort())); // env.PORT: restart on the same port (reconnect tests)
  const dir = scratch('server');
  let log = '';
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    MODEL: model ?? undefined,
    DEBUG: '1',
    SETTINGS_FILE: path.join(dir, 'settings.json'),
    TRANSCRIPTS_DIR: path.join(dir, 'transcripts'),
    ENV_FILE: os.devNull,
    ELEVENLABS_API_KEY: undefined,
    ELEVENLABS_BASE_URL: undefined,
    ...env,
  };
  if (childEnv.ELEVENLABS_API_KEY && !/^http:\/\/127\.0\.0\.1:/.test(childEnv.ELEVENLABS_BASE_URL ?? '')) {
    throw new Error('A test server may use an ElevenLabs key only with the stand-in (fakeElevenLabs): ElevenLabs bills real audio.');
  }
  for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const script = path.join(ROOT, 'server.ts');
  // Past the limit a write is cut short, then fails with EFBIG (Node ignores SIGXFSZ): what a full disk does.
  // exec keeps the pid.
  const [cmd, args] = (maxFileBlocks
    ? ['/bin/sh', ['-c', `ulimit -f ${maxFileBlocks} && exec "$0" "$@"`, NODE, script]]
    : [NODE, [script]]) as [string, string[]];
  const child = spawn(cmd, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const t0 = Date.now();
  // The ready line: "<model> ready on GPU (Metal) (0.2 s)" since the GPU work (#38), "<model> ready (0.2 s)" before it;
  // until: 'listening' stops at the line before it, "Live transcriber (ro) → http://…", while the model still loads.
  const started = until === 'listening' ? /Live transcriber \(|✖/ : / ready\b.*\(\d+\.\d s\)|✖/;
  while (!started.test(log)) {
    if (child.exitCode !== null || Date.now() - t0 > timeoutMs) {
      child.kill('SIGKILL'); // never leave a test server running (TESTING.md §2 rule 5)
      throw new Error(`server did not start:\n${log}`);
    }
    await sleep(until === 'listening' ? 5 : 100);
  }
  if (log.includes('✖')) throw new Error(`server failed:\n${log}`);
  return {
    port,
    pid: child.pid,
    exited,
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

const UNITS: Record<string, number> = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024, T: 1048576 };

/**
 * A process's MEM in MB from `top -l 1 -pid <pid> -stats pid,mem` (macOS: its physical footprint), or null when the
 * output has no row for it: "12345  210M", "2048K", "1.2G", a trailing + or - when it changed.
 */
export function parseTopMem(out: string, pid: number): number | null {
  const row = out.split('\n').map((l) => l.trim().match(/^(\d+)\s+([\d.]+)([BKMGT])[+-]?$/)).find((m) => m && Number(m[1]) === pid);
  return row ? Math.round(Number(row[2]) * (UNITS[row[3]] as number)) : null;
}

const resident = async (pid: number | undefined) => Math.round(Number((await promisify(execFile)('ps', ['-o', 'rss=', '-p', String(pid)])).stdout) / 1024);

/**
 * A process's memory in MB, as the system charges it to the process. On macOS that is its physical footprint (what
 * Activity Monitor shows), not its resident size: V8 and malloc hand freed memory back to macOS as "reusable"
 * (MADV_FREE_REUSABLE), which stays resident, and counted by `ps`, until the system needs it. So the resident size
 * stayed up after the server's heap shrank by 124 MB, and fell by 80 MB whenever another process needed memory
 * (the stress run of 2026-11-08: STRESS-MEET-08 and -SOAK-06 failed on that alone). Elsewhere, and if `top` gives no
 * answer, the resident size. `rss` is the resident size, for comparison.
 */
export async function processMemory(pid: number | undefined): Promise<{ mb: number, rss: number, footprint: boolean }> {
  const rss = await resident(pid);
  if (process.platform !== 'darwin') return { mb: rss, rss, footprint: false };
  try {
    const { stdout } = await promisify(execFile)('top', ['-l', '1', '-pid', String(pid), '-stats', 'pid,mem'], { timeout: 10000 });
    const mb = parseTopMem(stdout, pid as number);
    return mb === null ? { mb: rss, rss, footprint: false } : { mb, rss, footprint: true };
  } catch {
    return { mb: rss, rss, footprint: false };
  }
}

/**
 * One reading of a process's memory (processMemory) for a check that compares two moments: the median of `n`
 * readings `gapMs` apart, since single readings of a busy server swing by 30 MB from one to the next.
 */
export async function settledMemory(pid: number | undefined, { n = 5, gapMs = 400 }: { n?: number, gapMs?: number } = {}): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i) await sleep(gapMs);
    xs.push((await processMemory(pid)).mb);
  }
  return xs.sort((a, b) => a - b)[Math.floor((n - 1) / 2)] as number;
}

/**
 * A test server's memory in MB (#48): all of it as the system charges it (processMemory: the physical footprint on
 * macOS; `rss`, the resident size, beside it), and what it is made of as the server reports it (/debug/memory, with
 * DEBUG): V8's heap (`heap`, with `used` of it in use), the memory V8 tracks outside it (audio buffers), and the
 * native rest (an in-process model and its GPU buffers, the voice detectors). Only `mb`, `rss` and `footprint` when the
 * server does not answer.
 */
export async function serverMemory(server: TestServer): Promise<ServerMemory> {
  const { mb, rss, footprint } = await processMemory(server.pid);
  try {
    const m = await (await fetch(`${server.url}/debug/memory`, { signal: AbortSignal.timeout(5000) })).json() as { heapTotal: number, heapUsed: number, external: number };
    return { mb, rss, footprint, heap: m.heapTotal, used: m.heapUsed, external: m.external, native: mb - m.heapTotal - m.external };
  } catch {
    return { mb, rss, footprint };
  }
}

/** Run test/stream-wav.ts against a server; returns its sentences ({ id, mic, start, end, text }), live guesses and exit code. */
export function streamWav(port: number, args: string[], { timeoutMs = 300000 }: { timeoutMs?: number } = {}): Promise<StreamResult> {
  return new Promise((resolve) => {
    const child = spawn(NODE, [path.join(ROOT, 'test', 'stream-wav.ts'), ...args], { env: { ...process.env, PORT: String(port) } });
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

/**
 * A stand-in for ElevenLabs' realtime speech-to-text (wss://api.elevenlabs.io/v1/speech-to-text/realtime), speaking
 * its protocol as @elevenlabs/elevenlabs-js does, so no test sends audio to the real service or needs a real key.
 * Pass ELEVENLABS_BASE_URL: fake.url (with any key) to a server. Each connection is recorded:
 *   { index, key, query, audio (Int16Array of everything received), chunks (samples per message), previousText (per
 *   message), commits, committed, closed }.
 * text(conn) answers a commit (default "propoziția <index>"), partial(conn) each chunk (null: none);
 * fail(conn) returns a server error type (e.g. 'quota_exceeded') to answer the commit with instead.
 */
export async function fakeElevenLabs({ key = 'test-key', text = (c) => `propoziția ${c.index}`, partial = (c) => `ascult ${c.index}`, fail = () => null }: FakeElevenLabsOptions = {}): Promise<FakeElevenLabs> {
  const port = await freePort();
  const httpServer = http.createServer(); // ours, so close() can end every connection; ws's own server would wait for them
  const wss = new WebSocketServer({ server: httpServer, path: '/v1/speech-to-text/realtime' });
  const connections: FakeConnection[] = [];
  wss.on('connection', (ws, req) => {
    const c: FakeConnection = { index: connections.length, key: req.headers['xi-api-key'], query: Object.fromEntries(new URL(req.url as string, 'http://x').searchParams), audio: new Int16Array(0), chunks: [], previousText: [], commits: 0, committed: false, closed: false };
    connections.push(c);
    const send = (msg: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    ws.on('close', () => (c.closed = true));
    if (c.key !== key) {
      send({ message_type: 'auth_error', error: 'Invalid API key' });
      ws.close();
      return;
    }
    send({ message_type: 'session_started', session_id: `fake-${c.index}`, config: { sample_rate: 16000, model_id: c.query.model_id } });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.message_type !== 'input_audio_chunk') return;
      const bytes = Buffer.from(msg.audio_base_64, 'base64');
      const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (samples.length) {
        const audio = new Int16Array(c.audio.length + samples.length);
        audio.set(c.audio);
        audio.set(samples, c.audio.length);
        c.audio = audio;
        c.chunks.push(samples.length);
        c.previousText.push(msg.previous_text ?? null);
        const live = partial(c);
        if (live) send({ message_type: 'partial_transcript', text: live });
      }
      if (!msg.commit) return;
      c.commits++;
      const error = fail(c);
      if (error) {
        send({ message_type: error, error: `stand-in ${error}` });
        ws.close();
        return;
      }
      c.committed = true;
      send({ message_type: 'committed_transcript', text: text(c) });
    });
  });
  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', () => resolve(undefined)));
  return {
    url: `http://127.0.0.1:${port}`,
    connections,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      httpServer.closeAllConnections(); // a connection still open (a handshake, keep-alive) would keep close() from answering
      httpServer.close(resolve);
    }),
  };
}

/**
 * A stand-in for server.ts, for tests of the page alone: serves the page's files (the routes server.ts lists) and
 * sends the page whatever the test wants. On connecting the page gets a ready fake model, then `greet` (e.g. the
 * tuning message), then a limit of two mics. send() goes to the newest connection.
 */
export async function fakeServer({ greet = [] }: FakeServerOptions = {}): Promise<FakeServer> {
  const routes = Object.fromEntries([...fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8').matchAll(/'(\/[\w.-]*)': \['([\w.-]+)', '([^']+)'\]/g)].map(([, route, file, type]) => [route, [file, type]] as [string, [string, string]]));
  const server = http.createServer((req, res) => {
    const entry = routes[new URL(req.url as string, 'http://x').pathname];
    if (!entry) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': entry[1] }).end(fs.readFileSync(path.join(ROOT, 'public', entry[0])));
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  let client: import('ws').WebSocket | null = null;
  wss.on('connection', (ws) => {
    client = ws;
    const send = (msg: object) => ws.send(JSON.stringify(msg));
    send({ type: 'models', active: 'fake', models: [{ id: 'fake', label: 'Fake model', engine: 'fake', size: '0 MB', download: '0 MB', notes: 'Stand-in for the tests.', installed: true, progress: null }] });
    send({ type: 'status', state: 'ready', message: 'Fake model ready', model: 'fake', detector: 'silero', language: 'ro' });
    for (const msg of greet) send(msg);
    send({ type: 'mics', max: 2 });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return {
    url: `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`,
    send: (msg) => (client as import('ws').WebSocket).send(JSON.stringify(msg)), // the page has connected
    close: () => new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections(); // the page's keep-alive connections; close() alone waits for them
      server.close(resolve);
    }),
  };
}

/**
 * How many lines of `a` are out of order against `b`, which has the same lines: the fewest lines that must move for
 * `a` to read as `b` does (`a`'s lines minus the most of them already in `b`'s order). One line in the wrong place
 * counts 1, however many lines it is away. Lines that only one of the two has are not counted.
 */
export function outOfPlace(a: string[], b: string[]) {
  const places: Map<string, number[]> = new Map(); // line -> its indexes in b, first first (a line can be there twice)
  b.forEach((line, i) => ((places.get(line) ?? places.set(line, []).get(line)) as number[]).push(i));
  const taken: Map<string, number> = new Map();
  const where: number[] = [];
  for (const line of a) {
    const n = taken.get(line) ?? 0;
    const i = places.get(line)?.[n];
    if (i === undefined) continue;
    taken.set(line, n + 1);
    where.push(i);
  }
  // The longest run of them already in b's order: the longest increasing subsequence of their places in b.
  const tails: number[] = []; // tails[k]: the smallest last place of an increasing run of k + 1
  for (const i of where) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = i;
  }
  return where.length - tails.length;
}

export const loadWav = (file: string) => decodeWav(fs.readFileSync(file)).samples;
export const saveWav = (file: string, samples: Float32Array) => fs.writeFileSync(file, encodeWav(samples));

/** Two "speakers" cut from the fixture: A says the first sentence (6.8 s), B the other two (8.6 s). */
export function speakers() {
  const all = loadWav(FIXTURE);
  return { A: all.subarray(0, Math.round(6.8 * SR)), B: all.subarray(Math.round(7.3 * SR)) };
}

export const silence = (sec: number) => new Float32Array(Math.round(sec * SR));
export function concat(...parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** What a mic across the room hears: a few early reflections and duller sound (one-pole low-pass). */
export function room(x: Float32Array) {
  const taps: [number, number][] = [[0, 1], [0.011, 0.5], [0.023, 0.35], [0.041, 0.25], [0.067, 0.15]].map(([t, g]) => [Math.round(t * SR), g]);
  const out = new Float32Array(x.length + (taps.at(-1) as [number, number])[0]);
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
export function twoMics(a: Float32Array, b: Float32Array, { bleedDb = 12, lagMs = 0, gain2Db = 0, noise1 = -58, noise2 = -58, seed = 7 }: TwoMicsOptions = {}): [Float32Array, Float32Array] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const noise = (db: number) => {
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
 * TEST_RESULT is set (run-all.ts collects them) and sets the exit code.
 */
export function suite(name: string): Suite {
  const cases: TestCase[] = [];
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
      const count = (s: TestCase['status']) => cases.filter((c) => c.status === s).length;
      console.log(`\n${name}: ${count('pass')} passed, ${count('fail')} failed, ${count('known')} known limits, ${count('skip')} skipped`);
      if (process.env.TEST_RESULT) fs.writeFileSync(process.env.TEST_RESULT, JSON.stringify({ name, cases }, null, 2));
      process.exitCode = count('fail') ? 1 : 0;
    },
  };
}
