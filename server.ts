import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config, ROOT, MODELS_DIR } from './lib/config.ts';
import { MODELS, SILERO_VAD, isInstalled, isAvailable, installModel, download } from './lib/models.ts';
import { Transcriber } from './lib/transcriber.ts';
import { Session } from './lib/session.ts';
import { TUNING, tuningFrom, sanitizeTuning, applyTuning } from './lib/tuning.ts';
import type { Settings, TuningPatch } from './types/config.ts';
import type { ClientMessage, ModelsMessage, ServerMessage, StatusMessage, TuningMessage } from './types/protocol.ts';

const PUBLIC = path.join(ROOT, 'public');
const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/stage.js': ['stage.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
  '/mics.js': ['mics.js', 'text/javascript; charset=utf-8'],
  '/speaker.js': ['speaker.js', 'text/javascript; charset=utf-8'],
  '/backlog.js': ['backlog.js', 'text/javascript; charset=utf-8'],
  '/order.js': ['order.js', 'text/javascript; charset=utf-8'],
  '/pcm-worklet.js': ['pcm-worklet.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const readSettings = (): Settings => {
  try {
    return JSON.parse(fs.readFileSync(config.settingsFile, 'utf8'));
  } catch {
    return {};
  }
};
/** Each key of patch replaces the saved one; a key set to undefined is removed from the file (Reset in the Settings panel). */
const writeSettings = (patch: { [K in keyof Settings]?: Settings[K] | undefined }) => {
  try {
    fs.mkdirSync(path.dirname(config.settingsFile), { recursive: true });
    fs.writeFileSync(config.settingsFile, JSON.stringify({ ...readSettings(), ...patch }, null, 2));
  } catch (err: any) {
    console.error(`Could not save settings: ${err.message}`);
  }
};

// Speech-detection tuning: environment variables give the defaults, the Settings panel overrides them.
const DEFAULT_TUNING = tuningFrom(config);
applyTuning(config, sanitizeTuning(readSettings().tuning));

// Models this computer can run; the rest are left out of the menu.
const AVAILABLE = MODELS.filter((m) => isAvailable(m, { whisperBin: config.whisper.bin }));
const findAvailable = (id: string) => AVAILABLE.find((m) => m.id === id);

const transcriber = new Transcriber(config);
const progress = new Map<string, number>(); // model id -> download fraction
const clients = new Set<(msg: ServerMessage) => void>();
const sessions = new Set<Session>();

const broadcast = (msg: ServerMessage) => {
  for (const send of clients) send(msg);
};

const modelsMessage = (): ModelsMessage => ({
  type: 'models',
  active: transcriber.model?.id ?? null,
  models: AVAILABLE.map((m) => ({
    id: m.id,
    label: config.inDocker && m.dockerSlow ? `${m.label} (slow in Docker)` : m.label,
    engine: m.engine,
    tier: m.tier, // 'recommended' | 'other': the menu's two groups (#28)
    reason: m.reason, // one line on why it is where it is in the ranking
    size: m.size,
    download: m.downloadSize ?? m.size,
    notes: config.inDocker && m.dockerSlow ? `${m.notes} Too slow for live use in Docker: no GPU there.` : m.notes,
    cloud: Boolean(m.cloud), // the page says that the audio leaves the computer
    installed: isInstalled(m),
    progress: progress.get(m.id) ?? null,
  })),
});

const statusMessage = (): StatusMessage => ({ type: 'status', ...transcriber.status(), language: config.language });

const tuningMessage = (): TuningMessage => ({ type: 'tuning', values: tuningFrom(config), defaults: DEFAULT_TUNING, ranges: TUNING });

function updateTuning({ values, reset }: { values?: TuningPatch; reset?: boolean }) {
  applyTuning(config, reset ? DEFAULT_TUNING : sanitizeTuning(values));
  writeSettings({ tuning: reset ? undefined : tuningFrom(config) });
  for (const session of sessions) session.retune();
  broadcast(tuningMessage());
}

function selectModel(id: string) {
  if (!findAvailable(id)) return;
  writeSettings({ model: id });
  transcriber.select(id);
  broadcast(modelsMessage());
}

async function install(id: string) {
  const model = findAvailable(id);
  if (!model || isInstalled(model) || progress.has(id)) return;
  progress.set(id, 0);
  broadcast(modelsMessage());
  let lastPct = 0;
  try {
    await installModel(model, (fraction) => {
      progress.set(id, fraction);
      const pct = Math.floor(fraction * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        broadcast({ type: 'progress', id, progress: fraction });
      }
    });
    progress.delete(id);
    console.log(`  ✔ downloaded ${model.label}`);
    selectModel(id);
  } catch (err: any) {
    progress.delete(id);
    broadcast({ type: 'error', message: `Download of ${model.label} failed: ${err.message}` });
    broadcast(modelsMessage());
  }
}

const MB = 1024 * 1024;

const server = http.createServer((req, res) => {
  const url = new URL(req.url as string, 'http://localhost'); // a request always has one
  // What the server's memory is made of, for the stress tests (#48): V8's heap, the memory V8 tracks outside it (audio
  // buffers), and, from the total, the native rest (an in-process model and its GPU buffers, the voice detectors).
  // Only with DEBUG, which the tests set.
  if (process.env.DEBUG && req.method === 'GET' && url.pathname === '/debug/memory') {
    const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage();
    const mb = (x: number) => Math.round(x / MB);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' })
      .end(JSON.stringify({ rss: mb(rss), heapTotal: mb(heapTotal), heapUsed: mb(heapUsed), external: mb(external), arrayBuffers: mb(arrayBuffers) }));
    return;
  }
  const entry = STATIC[url.pathname];
  if (req.method !== 'GET' || !entry) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(path.join(PUBLIC, entry[0]), (err, data) => {
    if (err) return res.writeHead(500).end(err.message);
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' }).end(data);
  });
});

// Only this server's own page may connect. Any website open in the browser could otherwise reach ws://localhost,
// switch to the cloud model and so send the room's audio off the computer. Tools that are not browsers send no Origin.
const sameOrigin = ({ origin, req }: { origin: string; req: http.IncomingMessage }) => {
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
};

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20, verifyClient: sameOrigin });

wss.on('connection', (ws, req) => {
  // The page connects to /ws?mics and prefixes every audio frame with its number of mics;
  // other clients (test/stream-wav.ts) send plain mono audio.
  const framed = new URL(req.url as string, 'http://localhost').searchParams.has('mics');
  const send = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const session = new Session({ send, transcriber, config });
  clients.add(send);
  sessions.add(session);
  send(modelsMessage());
  send({ ...statusMessage(), detector: session.detector });
  send(tuningMessage());
  send({ type: 'mics', max: config.maxMics });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Float32 PCM, 16 kHz. Copy out so the view is 4-byte aligned.
      const buf = data as Buffer; // ws hands binary frames over as one Buffer
      const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength - (buf.byteLength % 4));
      if (!framed) {
        session.audio(new Float32Array(bytes));
        return;
      }
      // Uint32 number of mics, then each mic's samples in turn.
      if (bytes.byteLength < 8) return;
      const count = new Uint32Array(bytes, 0, 1)[0];
      const samples = new Float32Array(bytes, 4);
      if (count < 1 || samples.length % count) return;
      const used = Math.min(count, config.maxMics);
      session.audio(samples.subarray(0, (samples.length / count) * used), used);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'flush') session.flush();
    else if (msg.type === 'reset') session.reset();
    else if (msg.type === 'resume') session.resume(msg, [...sessions]);
    else if (msg.type === 'options') session.setOptions(msg);
    else if (msg.type === 'select') selectModel(msg.id);
    else if (msg.type === 'install') install(msg.id);
    else if (msg.type === 'tuning') updateTuning(msg);
  });

  ws.on('close', () => {
    clients.delete(send);
    sessions.delete(session);
    session.close();
  });
});

transcriber.on('state', () => broadcast(statusMessage()));

const onListenError = (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE'
    ? `\n✖ Port ${config.port} is already in use. Is the transcriber already running in another terminal?\n  Stop it, or pick another port: PORT=${config.port + 1} npm start\n`
    : `\n✖ ${err.message}\n`);
  transcriber.kill();
  process.exit(1);
};
server.on('error', onListenError);
wss.on('error', onListenError); // ws re-emits the HTTP server's errors here and would crash without a listener

server.listen(config.port, config.host, async () => {
  console.log(`\n  Live transcriber (${config.language}) → http://localhost:${config.publicPort}\n`);

  if (config.vad.engine === 'silero' && !fs.existsSync(config.vad.sileroModel)) {
    console.log('  Downloading Silero VAD (0.6 MB) …');
    await download(SILERO_VAD.url, path.join(MODELS_DIR, SILERO_VAD.file)).catch((err: any) => {
      console.error(`  Could not download Silero VAD, using the loudness detector instead: ${err.message}`);
    });
  }

  const initial = process.env.MODEL ?? readSettings().model ?? config.defaultModel;
  const model = findAvailable(initial) ?? findAvailable(config.defaultModel) ?? AVAILABLE[0];
  if (!isInstalled(model)) {
    if (config.autoInstall) {
      console.log(`  Downloading ${model.label} (${model.downloadSize ?? model.size}) …`);
      install(model.id); // selects the model when done; the page shows the progress
      return;
    }
    console.log(`  ${model.label} is not downloaded. Run "npm run setup", or pick a model in the page.\n`);
    transcriber.select(model.id); // reports "not downloaded" to the page
    return;
  }
  console.log(`  Loading ${model.label} …`);
  await transcriber.select(model.id);
  if (transcriber.state === 'ready') console.log(`  ✔ ${transcriber.message}. Open the page and press Start.\n`);
});

// A model loading in this process (transcribe.cpp) cannot be interrupted, and exit() under it never returns: the load's
// thread calls back into JavaScript while exit() waits for that thread (#62). So the load gets this long to end; the
// desktop app and Docker give the server 10 and 15 s.
const LOAD_WAIT_MS = 5000;
/** Ends the process; killed outright when a model is still loading in it (see above). */
const quit = () => {
  if (transcriber.loading) process.kill(process.pid, 'SIGKILL');
  process.exit(0);
};
let stopping = false;
const shutdown = async () => {
  if (stopping) return quit(); // second Ctrl+C: quit immediately
  stopping = true;
  // Finish and save the sentence that was being spoken when the server was stopped.
  for (const session of sessions) session.close();
  if (transcriber.busy) {
    console.log('\n  Saving the last sentence… (Ctrl+C again to quit now)');
    await transcriber.drain(8000);
  }
  // Also the model being loaded (#62): its process is killed, which ends its load; a load in this process is waited for.
  transcriber.kill();
  if (transcriber.loading) {
    console.log(`\n  Stopping while ${transcriber.model?.label} loads… (Ctrl+C again to quit now)`);
    await transcriber.loadEnded(LOAD_WAIT_MS);
  }
  quit();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Inside the desktop app this runs as an Electron utility process; the app asks for a clean stop by message
// (signals don't reach it reliably on Windows).
process.parentPort?.on('message', (e) => e.data === 'shutdown' && shutdown());
process.on('exit', () => transcriber.kill());
