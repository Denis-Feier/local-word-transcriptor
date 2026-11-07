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
/** @import { FakeConnection, FakeElevenLabs, FakeElevenLabsOptions, FakeServer, FakeServerOptions, ServerMemory, StartServerOptions, StreamResult, Suite, TestCase, TestServer, TwoMicsOptions } from '../types/test.ts' */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SR = 16000;
export const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'ro.wav');
/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Inside Electron (the UI tests) process.execPath is Electron itself; servers and tools need Node.
const NODE = process.versions.electron ? process.env.NODE_BIN ?? 'node' : process.execPath;

/** @returns {Promise<number>} */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address()); // listening on a TCP port
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A scratch folder for one test run; removed by cleanup().
 * @param {string} name
 */
export function scratch(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `transcriber-${name}-`));
}

/**
 * Start server.ts on a free port with its own settings and transcripts folders, so a test never touches the
 * user's files or a copy of the app that is already running. Models come from ./models (MODELS_DIR overrides).
 * model: null starts without MODEL (the saved or default model); env values of undefined are removed.
 * Never the user's .env.local or ElevenLabs key: an ElevenLabs key is allowed only with the stand-in (fakeElevenLabs).
 * maxFileBlocks: no file the server writes can grow past this many blocks, like a disk that fills up (sh's ulimit -f:
 * blocks of 1,024 bytes on macOS, 512 on Linux; not on Windows).
 * @param {StartServerOptions} [opts]
 * @returns {Promise<TestServer>}
 */
export async function startServer({ model = process.env.TEST_MODEL ?? 'parakeet-ro-110m', env = {}, timeoutMs = 120000, maxFileBlocks = null } = {}) {
  const port = Number(env.PORT ?? (await freePort())); // env.PORT: restart on the same port (reconnect tests)
  const dir = scratch('server');
  let log = '';
  /** @type {Record<string, string | undefined>} */
  const childEnv = {
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
  const [cmd, args] = /** @type {[string, string[]]} */ (maxFileBlocks
    ? ['/bin/sh', ['-c', `ulimit -f ${maxFileBlocks} && exec "$0" "$@"`, NODE, script]]
    : [NODE, [script]]);
  const child = spawn(cmd, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const t0 = Date.now();
  // The ready line: "<model> ready on GPU (Metal) (0.2 s)" since the GPU work (#38), "<model> ready (0.2 s)" before it.
  while (!/ ready\b.*\(\d+\.\d s\)|✖/.test(log)) {
    if (child.exitCode !== null || Date.now() - t0 > timeoutMs) {
      child.kill('SIGKILL'); // never leave a test server running (TESTING.md §2 rule 5)
      throw new Error(`server did not start:\n${log}`);
    }
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
/**
 * A test server's memory in MB (#48): all of it as the system counts it (`ps`: resident), and what it is made of as the
 * server reports it (/debug/memory, with DEBUG): V8's heap, the memory V8 tracks outside it (audio buffers), and the
 * native rest (an in-process model and its GPU buffers, the voice detectors). Only `mb` when the server does not answer.
 * @param {TestServer} server
 * @returns {Promise<ServerMemory>}
 */
export async function serverMemory(server) {
  const { stdout } = await promisify(execFile)('ps', ['-o', 'rss=', '-p', String(server.pid)]);
  const mb = Math.round(Number(stdout) / 1024);
  try {
    const m = /** @type {{ heapTotal: number, external: number }} */ (await (await fetch(`${server.url}/debug/memory`, { signal: AbortSignal.timeout(5000) })).json());
    return { mb, heap: m.heapTotal, external: m.external, native: mb - m.heapTotal - m.external };
  } catch {
    return { mb };
  }
}

/**
 * @param {number} port
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<StreamResult>}
 */
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

/**
 * A stand-in for ElevenLabs' realtime speech-to-text (wss://api.elevenlabs.io/v1/speech-to-text/realtime), speaking
 * its protocol as @elevenlabs/elevenlabs-js does, so no test sends audio to the real service or needs a real key.
 * Pass ELEVENLABS_BASE_URL: fake.url (with any key) to a server. Each connection is recorded:
 *   { index, key, query, audio (Int16Array of everything received), chunks (samples per message), previousText (per
 *   message), commits, committed, closed }.
 * text(conn) answers a commit (default "propoziția <index>"), partial(conn) each chunk (null: none);
 * fail(conn) returns a server error type (e.g. 'quota_exceeded') to answer the commit with instead.
 * @param {FakeElevenLabsOptions} [opts]
 * @returns {Promise<FakeElevenLabs>}
 */
export async function fakeElevenLabs({ key = 'test-key', text = (c) => `propoziția ${c.index}`, partial = (c) => `ascult ${c.index}`, fail = () => null } = {}) {
  const port = await freePort();
  const wss = new WebSocketServer({ host: '127.0.0.1', port, path: '/v1/speech-to-text/realtime' });
  /** @type {FakeConnection[]} */
  const connections = [];
  wss.on('connection', (ws, req) => {
    /** @type {FakeConnection} */
    const c = { index: connections.length, key: req.headers['xi-api-key'], query: Object.fromEntries(new URL(/** @type {string} */ (req.url), 'http://x').searchParams), audio: new Int16Array(0), chunks: [], previousText: [], commits: 0, committed: false, closed: false };
    connections.push(c);
    /** @param {object} msg */
    const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
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
  await new Promise((resolve) => wss.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    connections,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(resolve);
    }),
  };
}

/**
 * A stand-in for server.ts, for tests of the page alone: serves the page's files (the routes server.ts lists) and
 * sends the page whatever the test wants. On connecting the page gets a ready fake model, then `greet` (e.g. the
 * tuning message), then a limit of two mics. send() goes to the newest connection.
 * @param {FakeServerOptions} [opts]
 * @returns {Promise<FakeServer>}
 */
export async function fakeServer({ greet = [] } = {}) {
  const routes = Object.fromEntries([...fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8').matchAll(/'(\/[\w.-]*)': \['([\w.-]+)', '([^']+)'\]/g)].map(([, route, file, type]) => /** @type {[string, [string, string]]} */ ([route, [file, type]])));
  const server = http.createServer((req, res) => {
    const entry = routes[new URL(/** @type {string} */ (req.url), 'http://x').pathname];
    if (!entry) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': entry[1] }).end(fs.readFileSync(path.join(ROOT, 'public', entry[0])));
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  /** @type {import('ws').WebSocket | null} */
  let client = null;
  wss.on('connection', (ws) => {
    client = ws;
    /** @param {object} msg */
    const send = (msg) => ws.send(JSON.stringify(msg));
    send({ type: 'models', active: 'fake', models: [{ id: 'fake', label: 'Fake model', engine: 'fake', size: '0 MB', download: '0 MB', notes: 'Stand-in for the tests.', installed: true, progress: null }] });
    send({ type: 'status', state: 'ready', message: 'Fake model ready', model: 'fake', detector: 'silero', language: 'ro' });
    for (const msg of greet) send(msg);
    send({ type: 'mics', max: 2 });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  return {
    url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/`,
    send: (msg) => /** @type {import('ws').WebSocket} */ (client).send(JSON.stringify(msg)), // the page has connected
    close: () => new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close(resolve);
    }),
  };
}

/**
 * How many lines of `a` are out of order against `b`, which has the same lines: the fewest lines that must move for
 * `a` to read as `b` does (`a`'s lines minus the most of them already in `b`'s order). One line in the wrong place
 * counts 1, however many lines it is away. Lines that only one of the two has are not counted.
 * @param {string[]} a
 * @param {string[]} b
 */
export function outOfPlace(a, b) {
  /** @type {Map<string, number[]>} */
  const places = new Map(); // line -> its indexes in b, first first (a line can be there twice)
  b.forEach((line, i) => /** @type {number[]} */ (places.get(line) ?? places.set(line, []).get(line)).push(i));
  /** @type {Map<string, number>} */
  const taken = new Map();
  /** @type {number[]} */
  const where = [];
  for (const line of a) {
    const n = taken.get(line) ?? 0;
    const i = places.get(line)?.[n];
    if (i === undefined) continue;
    taken.set(line, n + 1);
    where.push(i);
  }
  // The longest run of them already in b's order: the longest increasing subsequence of their places in b.
  /** @type {number[]} */
  const tails = []; // tails[k]: the smallest last place of an increasing run of k + 1
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

/** @param {string} file */
export const loadWav = (file) => decodeWav(fs.readFileSync(file)).samples;
/**
 * @param {string} file
 * @param {Float32Array} samples
 */
export const saveWav = (file, samples) => fs.writeFileSync(file, encodeWav(samples));

/** Two "speakers" cut from the fixture: A says the first sentence (6.8 s), B the other two (8.6 s). */
export function speakers() {
  const all = loadWav(FIXTURE);
  return { A: all.subarray(0, Math.round(6.8 * SR)), B: all.subarray(Math.round(7.3 * SR)) };
}

/** @param {number} sec */
export const silence = (sec) => new Float32Array(Math.round(sec * SR));
/** @param {...Float32Array} parts */
export function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * What a mic across the room hears: a few early reflections and duller sound (one-pole low-pass).
 * @param {Float32Array} x
 */
export function room(x) {
  /** @type {[number, number][]} */
  const taps = [[0, 1], [0.011, 0.5], [0.023, 0.35], [0.041, 0.25], [0.067, 0.15]].map(([t, g]) => [Math.round(t * SR), g]);
  const out = new Float32Array(x.length + /** @type {[number, number]} */ (taps.at(-1))[0]);
  for (const [delay, gain] of taps) for (let i = 0; i < x.length; i++) out[i + delay] += gain * x[i];
  let y = 0;
  for (let i = 0; i < out.length; i++) out[i] = y = y + 0.35 * (out[i] - y);
  return out;
}

/**
 * Two mics in one room: each hears its own speaker plus the other one bleedDb quieter (with room sound), its own
 * noise (dBFS); mic 2 can arrive lagMs late (Bluetooth) and be gain2Db louder. Returns [mic1, mic2]. Seeded, so
 * every run gets the same audio.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @param {TwoMicsOptions} [opts]
 * @returns {[Float32Array, Float32Array]}
 */
export function twoMics(a, b, { bleedDb = 12, lagMs = 0, gain2Db = 0, noise1 = -58, noise2 = -58, seed = 7 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  /** @param {number} db */
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
 * @param {string} name
 * @returns {Suite}
 */
export function suite(name) {
  /** @type {TestCase[]} */
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
      /** @param {TestCase['status']} s */
      const count = (s) => cases.filter((c) => c.status === s).length;
      console.log(`\n${name}: ${count('pass')} passed, ${count('fail')} failed, ${count('known')} known limits, ${count('skip')} skipped`);
      if (process.env.TEST_RESULT) fs.writeFileSync(process.env.TEST_RESULT, JSON.stringify({ name, cases }, null, 2));
      process.exitCode = count('fail') ? 1 : 0;
    },
  };
}
