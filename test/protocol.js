// The server as the page (and other clients) use it: static files, WebSocket messages, settings, files,
// mic layouts, broken input, startup and shutdown. Starts its own servers (Parakeet 110M by default).
//
//   node test/protocol.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { ROOT, SR, startServer, speakers, sleep, suite } from './helpers.js';

const t = suite('protocol');
const { A, B } = speakers();

/** A page-like client: framed audio (/ws?mics) unless mono, collects every message. */
async function connect(server, { mono = false } = {}) {
  const ws = new WebSocket(server.ws(mono ? '' : '?mics'));
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    msgs,
    json: (msg) => ws.send(JSON.stringify(msg)),
    /** Send `seconds` of audio, one source per mic from its start (null = silence), faster than real time. */
    async audio(sources, seconds) {
      for (let i = 0, at = 0; i < seconds * 10; i++) {
        const n = 1600;
        if (mono) ws.send(sources[0].slice(at, at + n).buffer);
        else {
          const frame = new Float32Array(1 + sources.length * n);
          new Uint32Array(frame.buffer, 0, 1)[0] = sources.length;
          sources.forEach((src, mic) => src && frame.set(src.subarray(at, at + n), 1 + mic * n));
          ws.send(frame.buffer);
        }
        at += n;
        if (i % 8 === 7) await sleep(100);
      }
    },
    finals: () => msgs.filter((m) => m.type === 'final' && m.text),
    last: (type) => msgs.filter((m) => m.type === type).at(-1),
    close: () => new Promise((r) => (ws.readyState === WebSocket.CLOSED ? r() : (ws.once('close', r), ws.close()))),
  };
}

const server = await startServer();
try {
  // ---------- static files ----------
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routes = [...serverSrc.matchAll(/'(\/[\w.-]*)': \['([\w.-]+)', '([^']+)'\]/g)].map(([, route, file, type]) => ({ route, file, type }));
  const results = await Promise.all(routes.map(async (r) => {
    const res = await fetch(server.url + r.route);
    return res.status === 200 && res.headers.get('content-type') === r.type;
  }));
  t.check('PROT-STATIC-01', 'every page file is served with its content type', results.every(Boolean) && routes.length >= 7, `${routes.length} routes`);
  const unserved = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => !routes.some((r) => r.file === f));
  t.check('PROT-STATIC-02', 'every file in public/ has a route in server.js', unserved.length === 0, unserved.join(', '));
  const [missing, post] = await Promise.all([fetch(`${server.url}/nope.js`), fetch(`${server.url}/`, { method: 'POST' })]);
  t.check('PROT-STATIC-03', 'unknown paths and non-GET requests get 404', missing.status === 404 && post.status === 404);

  // ---------- connect ----------
  let c = await connect(server);
  await sleep(300);
  const types = c.msgs.map((m) => m.type);
  const status = c.last('status');
  const tuning = c.last('tuning');
  t.check('PROT-WS-01', 'on connect: models, status (ready, detector, language), tuning, mics',
    ['models', 'status', 'tuning', 'mics'].every((x) => types.includes(x)) && status.state === 'ready' && status.detector && status.language && c.last('mics').max === 2,
    `${types.join(',')}; detector ${status.detector}; max mics ${c.last('mics')?.max}`);
  t.check('PROT-WS-02', 'the models message lists installed/available models and the active one',
    c.last('models').models.length > 0 && c.last('models').active === 'parakeet-ro-110m' && c.last('models').models.every((m) => 'installed' in m && 'download' in m));
  t.check('PROT-WS-03', 'tuning carries values, defaults and ranges for every slider, including Mic separation',
    ['vadThreshold', 'silenceMs', 'minSpeechMs', 'maxSegmentSec', 'partialEverySec', 'crosstalkDb'].every((k) => k in tuning.values && k in tuning.defaults && k in tuning.ranges));

  // ---------- live settings ----------
  c.json({ type: 'tuning', values: { crosstalkDb: 12, silenceMs: 1000 } });
  await sleep(300);
  const saved = JSON.parse(fs.readFileSync(server.settingsFile, 'utf8'));
  t.check('PROT-TUNE-01', 'a slider change is applied, broadcast and saved', c.last('tuning').values.crosstalkDb === 12 && saved.tuning?.silenceMs === 1000, JSON.stringify(saved.tuning));
  c.json({ type: 'tuning', values: { crosstalkDb: 99, vadThreshold: 'x' } });
  await sleep(300);
  t.check('PROT-TUNE-02', 'out-of-range values are clamped, invalid ones ignored', c.last('tuning').values.crosstalkDb === 20 && c.last('tuning').values.vadThreshold === tuning.values.vadThreshold);
  c.json({ type: 'tuning', reset: true });
  await sleep(300);
  t.check('PROT-TUNE-03', 'Reset to defaults restores every value and forgets the saved ones',
    JSON.stringify(c.last('tuning').values) === JSON.stringify(tuning.defaults) && !JSON.parse(fs.readFileSync(server.settingsFile, 'utf8')).tuning);
  c.json({ type: 'select', id: 'no-such-model' });
  c.json({ type: 'install', id: 'parakeet-ro-110m' }); // already installed: nothing to do
  c.json({ type: 'whatever' });
  await sleep(300);
  t.check('PROT-WS-04', 'unknown model ids, installing an installed model and unknown messages change nothing',
    c.last('status').state === 'ready' && c.last('status').model === 'parakeet-ro-110m' && !c.msgs.some((m) => m.type === 'error'));
  await c.close();

  // ---------- mic layouts, Stop, files ----------
  c = await connect(server);
  c.json({ type: 'options', saveAudio: true });
  await c.audio([A], 8); // one mic
  await c.audio([A, B], 8); // a second mic joins mid-sentence
  await c.audio([A], 8); // back to one
  c.json({ type: 'flush' }); // Stop
  await sleep(1500);
  const before = c.finals().length;
  c.json({ type: 'flush' }); // Stop again: harmless
  await c.audio([A, B], 6); // Start with two mics, both talking
  c.json({ type: 'flush' }); // Stop while both are mid-sentence
  await sleep(2500);
  const ids = c.finals().map((m) => m.id);
  t.check('PROT-MIC-01', 'switching between one and two mics mid-recording keeps transcribing', before >= 2 && c.finals().length > before, `${before} then ${c.finals().length} sentences`);
  t.check('PROT-MIC-02', 'sentence ids are unique and follow the order speech started', new Set(ids).size === ids.length && ids.every((id, i) => !i || id > ids[i - 1]), ids.join(','));
  const lastStart = Math.max(...c.finals().map((m) => m.start));
  const tailMics = new Set(c.finals().filter((m) => m.start > lastStart - 4).map((m) => m.mic));
  t.check('PROT-MIC-03', 'Stop while both mics are talking finishes both', tailMics.has(0) && tailMics.has(1), [...tailMics].map((m) => `mic${m + 1}`).join(' '));
  const audioFiles = c.msgs.filter((m) => m.type === 'file' && m.kind === 'audio').map((m) => path.basename(m.path));
  const wavSec = audioFiles.map((f) => (fs.statSync(path.join(server.transcripts, f)).size - 44) / (2 * SR));
  t.check('PROT-MIC-04', 'one WAV per mic, opened once (never overwritten) and as long as the audio sent',
    audioFiles.length === 2 && new Set(audioFiles).size === 2 && Math.abs(wavSec[0] - 30) < 0.2 && Math.abs(wavSec[1] - 14) < 0.2,
    audioFiles.map((f, i) => `${f}: ${wavSec[i].toFixed(1)} s`).join(', '));
  const txt = fs.readdirSync(server.transcripts).filter((f) => f.endsWith('.txt'));
  t.check('PROT-MIC-05', 'the transcript file has a line per sentence', txt.length === 1 && fs.readFileSync(path.join(server.transcripts, txt[0]), 'utf8').trim().split('\n').length === c.finals().length);
  c.json({ type: 'reset' }); // Clear
  await c.audio([A], 7);
  c.json({ type: 'flush' });
  await sleep(1500);
  t.check('PROT-MIC-06', 'Clear starts new transcript and audio files', fs.readdirSync(server.transcripts).filter((f) => f.endsWith('.txt')).length === 2);

  // ---------- broken input ----------
  c.ws.send(new Uint8Array([1, 2]).buffer); // too short
  c.ws.send(new Uint32Array([0, 0, 0]).buffer); // zero mics
  c.ws.send(new Float32Array(1 + 1601).buffer); // samples don't split evenly
  const five = new Float32Array(1 + 5 * 1600);
  new Uint32Array(five.buffer, 0, 1)[0] = 5; // more mics than allowed: the first MAX_MICS are used
  c.ws.send(five.buffer);
  c.ws.send('not json');
  const n = c.msgs.length;
  c.json({ type: 'tuning', values: {} });
  await sleep(400);
  t.check('PROT-ERR-01', 'broken frames and bad JSON neither crash the server nor close the connection', c.ws.readyState === WebSocket.OPEN && c.msgs.length > n);
  await c.close();
  const mono = await connect(server, { mono: true });
  await mono.audio([A], 8);
  mono.json({ type: 'flush' });
  await sleep(1500);
  t.check('PROT-ERR-02', 'a plain mono client (no ?mics) still works', mono.finals().length >= 1 && mono.finals().every((m) => m.mic === 0));
  await mono.close();

  // ---------- startup and shutdown ----------
  const clash = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(server.port), SETTINGS_FILE: path.join(server.dir, 'clash.json') } });
  let clashOut = '';
  clash.stderr.on('data', (d) => (clashOut += d));
  const clashCode = await new Promise((r) => clash.on('exit', r));
  t.check('PROT-RUN-01', 'a port in use gives a clear message and exit code 1', clashCode === 1 && clashOut.includes('already in use'));
} finally {
  await server.stop();
}

// Ctrl+C mid-sentence: the sentence being spoken is still transcribed and saved. (Signals: macOS and Linux;
// on Windows the desktop app asks the server to stop by message instead.)
if (process.platform === 'win32') {
  t.skip('PROT-RUN-02', 'stopping the server (Ctrl+C) saves the sentence being spoken', 'no SIGINT on Windows');
} else {
  const s2 = await startServer();
  try {
    const c = await connect(s2);
    await c.audio([A], 4); // mid-sentence, no Stop
    await sleep(300);
    const files = () => (fs.existsSync(s2.transcripts) ? fs.readdirSync(s2.transcripts).filter((f) => f.endsWith('.txt')) : []);
    process.kill(s2.pid, 'SIGINT');
    await waitFor(() => files().length && fs.readFileSync(path.join(s2.transcripts, files()[0]), 'utf8').length > 10, 10000);
    const text = files().length ? fs.readFileSync(path.join(s2.transcripts, files()[0]), 'utf8') : '';
    t.check('PROT-RUN-02', 'stopping the server (Ctrl+C) saves the sentence being spoken', text.length > 10, JSON.stringify(text.slice(0, 60)));
  } finally {
    await s2.stop();
  }
}

// The model choice is remembered: a server restarted without MODEL loads the saved one.
const s3 = await startServer();
let savedSettings = null;
try {
  const c = await connect(s3);
  c.json({ type: 'select', id: 'orukeet' });
  await waitFor(() => c.last('status')?.model === 'orukeet' && c.last('status').state === 'ready', 60000);
  savedSettings = path.join(path.dirname(s3.dir), `${path.basename(s3.dir)}-saved.json`);
  fs.copyFileSync(s3.settingsFile, savedSettings);
  t.check('PROT-MODEL-01', 'choosing a model loads it and reports ready', c.last('status').model === 'orukeet' && c.last('status').state === 'ready', `${c.last('status').state} ${c.last('status').model}`);
  await c.close();
} finally {
  await s3.stop();
}
const s4 = await startServer({ model: null, env: { SETTINGS_FILE: savedSettings } });
try {
  const c = await connect(s4);
  await sleep(300);
  t.check('PROT-MODEL-02', 'after a restart the chosen model is used again', c.last('models').active === 'orukeet', c.last('models').active);
  await c.close();
} finally {
  await s4.stop();
  fs.rmSync(savedSettings, { force: true });
}

async function waitFor(cond, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await sleep(100);
  }
  return false;
}

t.finish();
