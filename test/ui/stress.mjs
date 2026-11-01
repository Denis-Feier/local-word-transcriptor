// The stress tier, in the page (TESTING.md §14): Chromium (Electron) with the fake mics of preload.cjs.
//   page: thousands of lines from a fake server: speed, memory, Copy/Download, reading back, projector, Clear
//   soak: a long meeting recorded in real time through the page, on the default model
//   net:  the server killed and restarted while the page records
//
//   npx electron test/ui/stress.mjs --group page|soak|net [--short] [--soak-minutes 120]   (ELECTRON_RUN_AS_NODE unset)
import { app, BrowserWindow, session } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from '../../lib/config.js';
import { MODELS, isInstalled, isAvailable } from '../../lib/models.js';
import { TUNING, tuningFrom } from '../../lib/tuning.js';
import { ROOT, SR, freePort, saveWav, scratch, silence, sleep, startServer, suite } from '../helpers.js';
import { SCRIPTS, Room, contentWords, judge, loopOffset, loopTruth, meeting, quantile, table, voices, windows } from '../meeting.js';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const group = option('--group', 'page');
const short = args.includes('--short');
const MODEL = option('--model', process.env.TEST_MODEL ?? 'parakeet-ro-110m');
const OUT = process.env.STRESS_OUT ?? scratch('stress-out');
fs.mkdirSync(OUT, { recursive: true });
const SPEAKERS = scratch('stress-speakers');
const t = suite(`stress-${group}${short ? ' (short)' : ''}`);
const usable = (id) => {
  const m = MODELS.find((x) => x.id === id);
  return m && isInstalled(m) && isAvailable(m, { whisperBin: config.whisper.bin });
};
const p = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {}); // closing the test's windows must not quit before its servers are stopped

// ---------- the page ----------

const pageErrors = [];
function newWindow({ loop = false, width = 1100, height = 900 } = {}) {
  const w = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'test', 'ui', 'preload.cjs'),
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false, // a long run behaves like a window on screen
      additionalArguments: [`--ui-speakers=${SPEAKERS}`, ...(loop ? ['--ui-loop'] : [])],
    },
  });
  w.webContents.on('console-message', (e) => e.level === 'error' && pageErrors.push(e.message));
  return w;
}
const js = (w, code) => w.webContents.executeJavaScript(code);
const click = (w, id) => js(w, `document.getElementById('${id}').click()`);
const finalTexts = (w) => js(w, `[...document.querySelectorAll('#transcript .line:not(.partial) .text')].map((e) => e.textContent)`);
const status = (w) => js(w, `document.getElementById('status').dataset.state`);
async function waitFor(fn, ms = 15000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await fn()) return true;
  return false;
}
/** Load the page fresh and pick the second fake mic (AirPods), so lines are labelled per mic. */
async function open(w, url) {
  await w.loadURL(url);
  await js(w, 'localStorage.clear(); sessionStorage.clear()');
  await w.loadURL(url);
  await waitFor(async () => (await status(w)) === 'ready' && (await js(w, `document.querySelectorAll('#mics select').length`)) >= 2);
  await js(w, `(() => { const s = document.querySelectorAll('#mics select')[1]; s.value = 'mic-b'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(300);
}

/** Chrome's own counters (main-thread time, JS heap) and its WebSocket frames, through the DevTools protocol. */
async function devtools(w) {
  if (!w.webContents.getURL()) {
    // The protocol needs a page; it stays attached across loads. The fake mics can't load into a blank page: not an error.
    const errors = pageErrors.length;
    await w.loadURL('about:blank');
    pageErrors.length = errors;
  }
  const d = w.webContents.debugger;
  d.attach('1.3');
  await d.sendCommand('Performance.enable');
  await d.sendCommand('HeapProfiler.enable');
  return {
    metrics: async () => Object.fromEntries((await d.sendCommand('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])),
    gc: () => d.sendCommand('HeapProfiler.collectGarbage'),
    /** Every WebSocket the page opened: frames sent (audio, wall time) and finals received (with wall time). */
    async sockets() {
      const conns = new Map(); // requestId -> { sent: [wall], finals: [], opened }; failed retries never open
      let opened = 0;
      d.on('message', (e, method, params) => {
        if (method === 'Network.webSocketCreated') conns.set(params.requestId, { sent: [], finals: [], opened: false });
        const c = conns.get(params.requestId);
        if (c && method === 'Network.webSocketHandshakeResponseReceived') Object.assign(c, { opened: true, index: opened++ });
        if (!c) return;
        if (method === 'Network.webSocketFrameSent' && params.response.opcode === 2) c.sent.push(Date.now());
        if (method === 'Network.webSocketFrameReceived' && params.response.opcode === 1) {
          const msg = JSON.parse(params.response.payloadData);
          if (msg.type === 'final' && msg.text) c.finals.push({ ...msg, mic: msg.mic ?? 0, arrival: Date.now() });
        }
      });
      await d.sendCommand('Network.enable');
      return () => [...conns.values()].filter((c) => c.opened).sort((a, b) => a.index - b.index);
    },
  };
}
const processMb = (w) => {
  const pid = w.webContents.getOSProcessId();
  const m = app.getAppMetrics().find((x) => x.pid === pid);
  return m ? Math.round(m.memory.workingSetSize / 1024) : NaN;
};

/** Growth after warm-up and the trend in MB per hour (least squares); samples: [{ sec, mb }]. */
function trend(samples, warm) {
  const s = samples.filter((x) => x.sec >= warm && Number.isFinite(x.mb));
  if (s.length < 3) return { growth: NaN, perHour: NaN, from: NaN, to: NaN };
  const xs = s.map((x) => x.sec / 3600);
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = s.reduce((a, b) => a + b.mb, 0) / s.length;
  const slope = xs.reduce((sum, x, i) => sum + (x - mx) * (s[i].mb - my), 0) / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return { growth: s.at(-1).mb - s[0].mb, perHour: slope, from: s[0].mb, to: s.at(-1).mb };
}

/** Fake mics that play the meeting `m` (a.wav, b.wav); the loop length in seconds. */
function speakFor(m) {
  const [m1, m2] = Room.render(m);
  saveWav(path.join(SPEAKERS, 'a.wav'), m1);
  saveWav(path.join(SPEAKERS, 'b.wav'), m2);
  saveWav(path.join(SPEAKERS, 'c.wav'), silence(1));
  return m1.length / SR;
}

// ---------- PAGE: a page holding hours of transcript ----------

/** A stand-in for server.js: serves the page and sends it whatever the test wants. */
async function fakeServer() {
  const routes = Object.fromEntries([...fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').matchAll(/'(\/[\w.-]*)': \['([\w.-]+)', '([^']+)'\]/g)].map(([, route, file, type]) => [route, [file, type]]));
  const server = http.createServer((req, res) => {
    const entry = routes[new URL(req.url, 'http://x').pathname];
    if (!entry) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': entry[1] }).end(fs.readFileSync(path.join(ROOT, 'public', entry[0])));
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  let client = null;
  wss.on('connection', (ws) => {
    client = ws;
    const send = (msg) => ws.send(JSON.stringify(msg));
    send({ type: 'models', active: 'fake', models: [{ id: 'fake', label: 'Fake model', engine: 'fake', size: '0 MB', download: '0 MB', notes: 'Stand-in for the stress test.', installed: true, progress: null }] });
    send({ type: 'status', state: 'ready', message: 'Fake model ready', model: 'fake', detector: 'silero', language: 'ro' });
    send({ type: 'tuning', values: tuningFrom(config), defaults: tuningFrom(config), ranges: TUNING });
    send({ type: 'mics', max: 2 });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    send: (msg) => client.send(JSON.stringify(msg)),
    close: () => new Promise((resolve) => (wss.close(), server.close(resolve))),
  };
}

/** n lines of a two-mic meeting from line `from` on, ~4.3 s each, a quarter overlapping the line before. */
function fakeLines(from, n) {
  const bank = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'meeting-ro.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && contentWords(l) >= 3);
  const out = [];
  let end = 0;
  for (let i = 0; i < from + n; i++) {
    const text = bank[(i * 7) % bank.length];
    const start = i % 4 === 3 ? end - 1 : end + 0.5 + (i % 3) * 0.4;
    end = start + 2.5 + (i % 5);
    if (i >= from) out.push({ id: i + 1, mic: i % 2, start, end, text });
  }
  return out;
}
const messages = (l) => {
  const w = l.text.split(' ');
  return [
    { type: 'vad', mic: l.mic, speaking: true, id: l.id },
    { type: 'partial', mic: l.mic, id: l.id, start: l.start, text: w.slice(0, Math.ceil(w.length / 3)).join(' ') },
    { type: 'partial', mic: l.mic, id: l.id, start: l.start, text: w.slice(0, Math.ceil((2 * w.length) / 3)).join(' ') },
    { type: 'final', mic: l.mic, id: l.id, start: l.start, end: l.end, text: l.text, model: 'fake', ms: 30 },
    { type: 'vad', mic: l.mic, speaking: false, id: l.id },
  ];
};

async function pageGroup() {
  const N = short ? 1000 : 5000;
  for (const f of ['a', 'b', 'c']) saveWav(path.join(SPEAKERS, `${f}.wav`), silence(1));
  const fake = await fakeServer();
  const win = newWindow();
  try {
    await open(win, fake.url);
    await click(win, 'toggle'); // recording, as in a meeting (the fake mics are silent)
    const dt = await devtools(win);
    await js(win, `window.__long = []; new PerformanceObserver((l) => window.__long.push(...l.getEntries().map((e) => e.duration))).observe({ entryTypes: ['longtask'] }); true`);
    await dt.gc();
    const heap0 = (await dt.metrics()).JSHeapUsedSize;
    let shown = 0;
    const count = () => js(win, `document.querySelectorAll('#transcript .line:not(.partial)').length`);
    /** Send lines at `perSec` lines a second (Infinity: all at once) and wait until the page shows them. */
    const feed = async (list, perSec = 25) => {
      for (let i = 0; i < list.length; i++) {
        for (const msg of messages(list[i])) fake.send(msg);
        if (perSec !== Infinity) await sleep(1000 / perSec);
      }
      shown += list.length;
      return waitFor(async () => (await count()) >= shown, 120000);
    };

    // PAGE-01, 02: the lines of a long meeting, in batches of 500 to see whether each costs more as the page fills.
    const all = fakeLines(0, N);
    const batches = [];
    for (let b = 0; b < N; b += 500) {
      const before = await dt.metrics();
      await feed(all.slice(b, b + 500));
      const after = await dt.metrics();
      batches.push(((after.TaskDuration - before.TaskDuration) * 1000) / (Math.min(500, N - b) * 5));
    }
    const longest = Math.max(0, ...(await js(win, 'window.__long')));
    t.check('STRESS-PAGE-01', `${N} lines with their live guesses: each message costs no more at the end than at the start (≤ 2×), no task over 200 ms`,
      batches.at(-1) <= 2 * batches[0] && longest <= 200, `main-thread time per message: ${batches.map((x) => p(x, 2)).join(', ')} ms; longest task ${p(longest, 0)} ms`);
    const dom = await js(win, `[...document.querySelectorAll('#transcript .line')].map((l) => ({ text: l.querySelector('.text').textContent, time: l.querySelector('time').textContent, overlap: l.classList.contains('overlap'), mic: l.dataset.mic, partial: l.classList.contains('partial') }))`);
    const expectOverlap = all.map((l) => all.some((o) => o.mic !== l.mic && Math.min(l.end, o.end) - Math.max(l.start, o.start) >= 0.5));
    const inOrder = dom.length === N && dom.every((d, i) => d.text === all[i].text && !d.partial && d.mic === String(all[i].mic + 1));
    const hourTimes = all.every((l, i) => l.start < 3600 || /^\d+:\d\d:\d\d$/.test(dom[i]?.time));
    const marks = dom.filter((d, i) => d.overlap !== expectOverlap[i]).length;
    t.check('STRESS-PAGE-02', `all ${N} lines shown in order, with hour times and ⇄ marks`, inOrder && hourTimes && marks === 0,
      `${dom.length} lines, in order ${inOrder}, last time ${dom.at(-1)?.time}, hour format ${hourTimes}, ${marks} wrong ⇄ marks`);

    // PAGE-03: Copy and Download.
    const ms = await js(win, `(() => { const t0 = performance.now(); document.getElementById('copy').click(); document.getElementById('download').click(); return performance.now() - t0; })()`);
    await sleep(800);
    const clip = (await js(win, 'window.__clipboard ?? ""')).split('\n');
    const down = (await js(win, 'window.__download ?? ""')).trim().split('\n');
    const hourLines = down.filter((l) => /^\[\d+:\d\d:\d\d\] /.test(l)).length;
    t.check('STRESS-PAGE-03', `Copy and Download with ${N} lines: within 1 s, every line, [h:mm:ss]`, ms <= 1000 && clip.length === N && down.length === N && hourLines === all.filter((l) => l.start >= 3600).length,
      `${p(ms, 0)} ms; Copy ${clip.length} lines, Download ${down.length} lines, ${hourLines} with hours`);

    // PAGE-04: someone reads back an hour while the meeting goes on.
    const scroll = () => js(win, `(() => { const t = document.getElementById('transcript'); return { top: t.scrollTop, height: t.scrollHeight, client: t.clientHeight }; })()`);
    await js(win, `(() => { const t = document.getElementById('transcript'); t.scrollTop = Math.round(t.scrollHeight / 2); })()`);
    const back = await scroll();
    await feed(fakeLines(N, 300));
    const stayed = await scroll();
    await js(win, `(() => { const t = document.getElementById('transcript'); t.scrollTop = t.scrollHeight; })()`);
    await feed(fakeLines(N + 300, 50));
    const follow = await scroll();
    const atBottom = follow.height - follow.top - follow.client < 80;
    t.check('STRESS-PAGE-04', 'reading back: the view stays put while 300 lines arrive; at the bottom it follows', back.height > back.client && Math.abs(stayed.top - back.top) <= 2 && atBottom,
      `scrolled to ${back.top} of ${back.height} px; after 300 lines ${stayed.top}; at the bottom after 50 more: ${atBottom}`);

    // PAGE-05: the projector view and a caption window keep up at line ~5,000.
    await click(win, 'projector');
    const captions = newWindow({ width: 1000, height: 600 });
    await captions.loadURL(`${fake.url}?display`);
    await sleep(800);
    const watch = `(() => { window.__seen = {}; new MutationObserver(() => { for (const el of document.querySelectorAll('.stage-line')) if (!(el.textContent in window.__seen)) window.__seen[el.textContent] = Date.now(); }).observe(document.getElementById('stage'), { subtree: true, childList: true, characterData: true }); return true; })()`;
    await js(win, watch);
    await js(captions, watch);
    const probes = fakeLines(N + 350, 5).map((l, i) => ({ ...l, text: `${l.text} (proba ${i + 1})` }));
    const sentAt = [];
    for (const l of probes) {
      sentAt.push(Date.now());
      for (const msg of messages(l)) fake.send(msg);
      await sleep(500);
    }
    shown += probes.length;
    await sleep(500);
    const lag = async (w) => {
      const seen = await js(w, 'window.__seen');
      return probes.map((l, i) => (Object.entries(seen).find(([text]) => text.includes(l.text))?.[1] ?? Infinity) - sentAt[i]);
    };
    const [onStage, onCaptions] = [await lag(win), await lag(captions)];
    t.check('STRESS-PAGE-05', `at line ~${N} the projector and the caption window show a new line within 300 ms`, [...onStage, ...onCaptions].every((x) => x <= 300),
      `projector ${onStage.map((x) => p(x, 0)).join(', ')} ms; caption window ${onCaptions.map((x) => p(x, 0)).join(', ')} ms`);
    await js(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

    // PAGE-06: the server catching up after a backlog sends 500 lines at once.
    await js(win, 'window.__long = []');
    await feed(fakeLines(N + 355, 500), Infinity);
    const burst = Math.max(0, ...(await js(win, 'window.__long')));
    const t0 = Date.now();
    await js(win, `document.getElementById('openSettings').click(); document.getElementById('settingsClose').click(); 1`);
    const answer = Date.now() - t0;
    t.check('STRESS-PAGE-06', 'a burst of 500 lines: no task over 500 ms, a click answered within 200 ms after it', burst <= 500 && answer <= 200, `longest task ${p(burst, 0)} ms; click answered in ${answer} ms`);

    // PAGE-07: Clear with the whole meeting on the page; its memory must come back.
    await dt.gc();
    const heapFull = (await dt.metrics()).JSHeapUsedSize;
    const clearMs = await js(win, `(() => { const t0 = performance.now(); document.getElementById('clear').click(); return performance.now() - t0; })()`);
    await sleep(500);
    await dt.gc();
    const heap1 = (await dt.metrics()).JSHeapUsedSize;
    const mb = (x) => p(x / 1048576, 1);
    t.check('STRESS-PAGE-07', `Clear with ${shown} lines: within 300 ms, page memory back within 20 MB of the start`, clearMs <= 300 && heap1 - heap0 <= 20 * 1048576,
      `Clear took ${p(clearMs, 0)} ms; JS heap ${mb(heap0)} MB at the start, ${mb(heapFull)} MB full, ${mb(heap1)} MB after Clear; page process ${processMb(win)} MB`);
    t.check('STRESS-PAGE-08', 'no errors in the page console during the whole run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    captions.destroy();
  } finally {
    win.destroy();
    await fake.close();
  }
}

// ---------- SOAK: a long meeting in real time through the page ----------

async function soak() {
  const minutes = Number(option('--soak-minutes', 120));
  const model = usable(config.defaultModel) ? config.defaultModel : MODEL;
  const v = await voices({ people: 3 });
  const m = meeting(v, { minutes: SCRIPTS.soak });
  const period = speakFor(m);
  const server = await startServer({ model, timeoutMs: 900000 });
  const win = newWindow({ loop: true });
  const captions = newWindow({ width: 1000, height: 600 });
  try {
    const dt = await devtools(win);
    const sockets = await dt.sockets();
    console.log(`soak: ${model} ready on port ${server.port}`);
    await open(win, server.url);
    await js(win, `(() => { const c = document.getElementById('saveAudio'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
    await captions.loadURL(`${server.url}/?display`);
    await click(win, 'toggle');
    const start = Date.now();
    const live = sockets().length - 1; // the page loads twice in open(): its first connection is gone
    console.log(`soak: recording (page ${await status(win)})`);
    console.log(`soak: ${minutes} min in real time on ${model}, the page playing a ${p(period / 60, 0)}-minute meeting in a loop`);
    const samples = [];
    let banner = 0;
    while (Date.now() - start < minutes * 60000) {
      await sleep(60000);
      const sec = (Date.now() - start) / 1000;
      const error = await js(win, `document.getElementById('error').hidden ? '' : document.getElementById('error').textContent`);
      if (error) banner++, console.log(`  ${p(sec / 60, 0)} min: error banner: ${error}`);
      const page = processMb(win);
      const heap = (await dt.metrics()).JSHeapUsedSize / 1048576;
      const srv = await new Promise((resolve) => execFile('ps', ['-o', 'rss=', '-p', String(server.pid)], (e, out) => resolve(Math.round(Number(out) / 1024))));
      samples.push({ sec, page, heap, server: srv });
      if (Math.round(sec / 60) % 10 === 0) console.log(`  ${p(sec / 60, 0)} min: page ${page} MB (heap ${p(heap, 0)} MB), server ${srv} MB, ${sockets()[live]?.finals.length ?? 0} lines`);
    }
    // SOAK-05: the caption window shows what the page shows.
    const newest = (await finalTexts(win)).at(-1);
    const onCaptions = await waitFor(async () => (await js(captions, `[...document.querySelectorAll('.stage-line')].map((e) => e.textContent).join('\\n')`)).includes(newest), 1000);
    await click(win, 'toggle');
    const stop = Date.now();
    await sleep(8000);
    await click(win, 'download');
    await sleep(800);
    const download = (await js(win, 'window.__download ?? ""')).trim().split('\n');
    const conn = sockets()[live];
    const lines = conn.finals.map((f) => ({ mic: f.mic, start: f.start, end: f.end, text: f.text, ms: f.ms, arrival: f.arrival }));
    const length = conn.sent.length * 0.1;
    const offsets = [0, 1].map((mic) => loopOffset(m, lines, mic, period));
    const truthItems = loopTruth(m, offsets.map((o) => o ?? 0), length, period);
    // The delay people see: from when the audio at a line's end was sent, to when the line arrived.
    const seen = lines.map((l) => ({ ...l, sentSec: undefined, delay: (l.arrival - conn.sent[Math.min(conn.sent.length - 1, Math.max(0, Math.ceil(l.end * 10) - 1))]) / 1000 }));
    const j = judge(truthItems, seen, { groups: windows(length) });
    for (const g of j.groups) g.delays = seen.filter((l) => (l.start + l.end) / 2 >= g.start && (l.start + l.end) / 2 < g.end).map((l) => l.delay);
    const full = j.groups.filter((g) => Math.min(g.end, length) - g.start >= 120); // at least 2 minutes of meeting
    const windowsOk = full.every((g) => (g.solo.n + g.overlapped.n ? (g.solo.caught + g.overlapped.caught) / (g.solo.n + g.overlapped.n) : 1) >= 0.95 && g.wrong === 0);
    const p95 = full.map((g) => quantile(g.delays, 0.95));
    fs.writeFileSync(path.join(OUT, 'soak.md'), [`# Soak: ${minutes} min in real time through the page (${model})`, '', `Mic offsets in the loop: ${offsets.map((o) => p(o, 2)).join(', ')} s.`, '',
      table(j.groups, (g) => ({ 'Seen delay p95 (s)': p(quantile(g.delays, 0.95)), 'Page MB': samples.filter((s) => s.sec <= g.end).at(-1)?.page ?? '—', 'Server MB': samples.filter((s) => s.sec <= g.end).at(-1)?.server ?? '—' })), ''].join('\n'));

    const wavs = fs.readdirSync(server.transcripts).filter((n) => n.endsWith('.wav')).map((n) => ({ n, sec: (fs.statSync(path.join(server.transcripts, n)).size - 44) / 2 / SR }));
    const recorded = (stop - start) / 1000;
    t.check('STRESS-SOAK-01', `${minutes} min through the page: no audio lost between page and server`, wavs.length === 2 && wavs.every((w) => Math.abs(w.sec - recorded) <= 2),
      `recorded ${p(recorded, 1)} s; ${wavs.map((w) => `${w.n.slice(-8)} ${p(w.sec, 1)} s`).join(', ')}`);
    t.check('STRESS-SOAK-02', 'lines keep coming: every 10 minutes ≥ 95 % of utterances caught, none on the wrong mic', windowsOk && offsets.every((o) => o !== null),
      full.map((g) => `${g.name}: ${g.solo.caught + g.overlapped.caught}/${g.solo.n + g.overlapped.n}, wrong ${g.wrong}`).join('; '));
    t.check('STRESS-SOAK-03', 'the delay people see: p95 ≤ 2 s in every 10 minutes, the last no more than 0.5 s above the first', p95.every((x) => x <= 2) && p95.at(-1) <= p95[0] + 0.5,
      `p95 per 10 min: ${p95.map((x) => p(x, 1)).join(', ')} s`);
    const warm = Math.min(1800, (minutes * 60) / 4);
    const page = trend(samples.map((s) => ({ sec: s.sec, mb: s.page })), warm);
    t.check('STRESS-SOAK-04', 'page memory: ≤ 30 MB more per hour after warm-up', minutes < 90 ? page.growth <= 30 : page.perHour <= 30,
      `page process ${page.from} → ${page.to} MB, trend ${p(page.perHour, 1)} MB/h; JS heap ${p(samples[0]?.heap, 0)} → ${p(samples.at(-1)?.heap, 0)} MB`);
    t.check('STRESS-SOAK-05', 'the caption window shows the newest line', onCaptions, JSON.stringify(newest?.slice(0, 60)));
    const srv = trend(samples.map((s) => ({ sec: s.sec, mb: s.server })), warm);
    t.check('STRESS-SOAK-06', 'server memory flat in real time (≤ +50 MB, ≤ 10 MB per hour)', srv.growth <= 50 && (minutes < 90 || srv.perHour <= 10), `${srv.from} → ${srv.to} MB, trend ${p(srv.perHour, 1)} MB/h`);
    const txt = fs.readdirSync(server.transcripts).filter((n) => n.endsWith('.txt')).flatMap((n) => fs.readFileSync(path.join(server.transcripts, n), 'utf8').split('\n').filter(Boolean));
    const lastIn = txt.some((l) => l.endsWith(lines.at(-1)?.text ?? '\u0000'));
    const differs = download.findIndex((l, i) => l !== txt[i]);
    const sorted = (x) => [...x].sort().join('\n');
    const same = sorted(download) === sorted(txt); // the .txt is in the order lines were finished (§14.5 #9)
    t.check('STRESS-SOAK-07', 'after Stop: the last sentence is in the .txt, Download has the same lines, no error in the console or on the page', lastIn && same && pageErrors.length === 0 && banner === 0,
      `last line saved ${lastIn}; Download ${download.length} lines, .txt ${txt.length}, same lines ${same}, same order ${differs < 0}${differs < 0 ? '' : ` (from line ${differs + 1}: ${JSON.stringify(download[differs]?.slice(0, 40))} vs ${JSON.stringify(txt[differs]?.slice(0, 40))})`}; `
      + `${pageErrors.length} console errors${pageErrors.length ? ` (${pageErrors.slice(0, 2).join(' | ').slice(0, 160)})` : ''}; error banner seen ${banner}×`);
  } finally {
    win.destroy();
    captions.destroy();
    await server.stop();
  }
}

// ---------- NET: the server dies and comes back while the page records ----------

async function net() {
  const v = await voices({ people: 3 });
  const m = meeting(v, { minutes: SCRIPTS.soak });
  const period = speakFor(m);
  const dir = scratch('net');
  const env = { PORT: String(await freePort()), TRANSCRIPTS_DIR: path.join(dir, 'transcripts'), SETTINGS_FILE: path.join(dir, 'settings.json') };
  // [minute, outage in seconds]; the last full-length one is longer than the page's 5-minute buffer (NET-02).
  const plan = short ? [[2, 5], [4, 30]] : [[10, 5], [25, 60], [40, 240], [58, 420]];
  const end = short ? 6 : 72;
  let server = await startServer({ model: MODEL, env });
  const servers = [server];
  const win = newWindow({ loop: true });
  try {
    const dt = await devtools(win);
    const sockets = await dt.sockets();
    await open(win, server.url);
    await js(win, `(() => { const c = document.getElementById('saveAudio'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
    await click(win, 'toggle');
    const start = Date.now();
    const outages = [];
    for (const [minute, outage] of plan) {
      await sleep(start + minute * 60000 - Date.now());
      const shown = await finalTexts(win);
      process.kill(server.pid, 'SIGKILL');
      const before = sockets().length;
      await sleep(outage * 1000);
      server = await startServer({ model: MODEL, env });
      servers.push(server);
      const t0 = Date.now();
      const back = await waitFor(async () => (await status(win)) === 'ready' && sockets().length > before, 60000);
      await sleep(1000);
      const told = await js(win, `document.getElementById('error').textContent + ' ' + document.getElementById('statusText').textContent`);
      outages.push({ minute, outage, shown, reconnect: back ? (Date.now() - t0) / 1000 : Infinity, conn: before, told });
      console.log(`net: killed at ${minute} min for ${outage} s; page back after ${p(outages.at(-1).reconnect, 1)} s`);
    }
    await sleep(start + end * 60000 - Date.now());
    await click(win, 'toggle');
    await sleep(8000);
    const conns = sockets();
    const txt = fs.readdirSync(env.TRANSCRIPTS_DIR).filter((n) => n.endsWith('.txt')).sort().map((n) => fs.readFileSync(path.join(env.TRANSCRIPTS_DIR, n), 'utf8').split('\n').filter(Boolean));
    const saved = txt.flat();
    const lost = outages.flatMap((o) => o.shown.filter((text) => !saved.some((l) => l.endsWith(text))));
    // The buffered audio: what the page recorded while the server was down is transcribed on the next connection.
    const buffered = (o) => {
      const c = conns[o.conn];
      const lines = (c?.finals ?? []).map((f) => ({ mic: f.mic, start: f.start, end: f.end, text: f.text }));
      const offsets = [0, 1].map((mic) => loopOffset(m, lines, mic, period));
      if (offsets.some((x) => x === null)) return { caught: 0, n: 1, offsets };
      const window = Math.min(o.outage, 300);
      const j = judge(loopTruth(m, offsets, window, period), lines.filter((l) => l.start < window + 5), { groups: [{ name: 'backlog', start: 0.5, end: window - 0.5 }] });
      const g = j.groups[0];
      return { caught: g.solo.caught + g.overlapped.caught, n: g.solo.n + g.overlapped.n, offsets, burst: c.sent.filter((w) => w - c.sent[0] < 2000).length };
    };
    const regular = outages.filter((o) => o.outage <= 300);
    const b = regular.map(buffered);
    const caught = b.reduce((s, x) => s + x.caught, 0);
    const n = b.reduce((s, x) => s + x.n, 0);
    const wavs = fs.readdirSync(env.TRANSCRIPTS_DIR).filter((f) => f.endsWith('.wav')).map((f) => {
      const file = path.join(env.TRANSCRIPTS_DIR, f);
      const size = fs.statSync(file).size - 44;
      const said = fs.readFileSync(file).subarray(0, 44).readUInt32LE(40);
      return said <= size && size - said <= 2 * 3200;
    });
    t.check('STRESS-NET-01', `(D2) the server killed ${regular.length}× while the page records: it reconnects, buffered audio transcribed, nothing shown is lost`,
      regular.every((o) => o.reconnect <= 30) && !lost.length && (n ? caught / n : 1) >= 0.9 && wavs.every(Boolean),
      `back after ${regular.map((o) => p(o.reconnect, 1)).join(', ')} s; ${lost.length} shown lines missing from the .txt; buffered audio caught ${caught}/${n}; ${wavs.filter(Boolean).length}/${wavs.length} WAVs playable; `
      + `${txt.length} transcript files, each starting at ${txt.map((f) => f[0]?.slice(0, 7) ?? '—').join(', ')} (D2: a new file and clock per reconnect)`);
    const long = outages.find((o) => o.outage > 300);
    if (long) {
      const x = buffered(long);
      const before = conns[long.conn - 1];
      const prevLines = (before?.finals ?? []).map((f) => ({ mic: f.mic, start: f.start, end: f.end, text: f.text }));
      const prevOffset = loopOffset(m, prevLines, 0, period);
      const dropAt = ((before.sent.length * 0.1 + prevOffset) % period + period) % period;
      const keptFrom = x.offsets[0] === null ? NaN : (((x.offsets[0] - dropAt) % period) + period) % period;
      const newest = Math.abs(keptFrom - (long.outage - 300)) < 20;
      const shownLoss = /lost|missing|pierd/i.test(long.told);
      t.check('STRESS-NET-02', `(D3) a ${long.outage / 60}-minute outage: the newest 5 minutes kept and the loss shown`, newest && shownLoss,
        `the page sent ${p((x.burst ?? 0) / 600, 1)} min of buffered audio, from ${p(keptFrom / 60, 1)} min after the drop (${newest ? 'the newest' : 'not the newest'} part); loss shown: ${shownLoss} (${JSON.stringify(long.told.trim().slice(0, 80))})`, { known: true });
    } else t.skip('STRESS-NET-02', 'an outage longer than the page buffer', 'not in --short');
  } finally {
    win.destroy();
    for (const s of servers) await s.stop().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);
  try {
    await { page: pageGroup, soak, net }[group]();
  } catch (err) {
    t.check(`STRESS-${group.toUpperCase()}-RUN`, `the ${group} group ran to the end`, false, err.stack);
  } finally {
    fs.rmSync(SPEAKERS, { recursive: true, force: true });
    t.finish();
    app.exit(process.exitCode ?? 0);
  }
});
