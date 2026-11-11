// The stress tier, in the page (TESTING.md §14): Chromium (Electron) with the fake mics of preload.cjs.
//   page: thousands of lines from a fake server: speed, memory, Copy/Download, reading back, projector, Clear
//   soak: a long meeting recorded in real time through the page, on the default model
//   net:  the server killed and restarted while the page records
//
//   npx electron test/ui/stress.ts --group page|soak|net [--short] [--soak-minutes 120]   (ELECTRON_RUN_AS_NODE unset)
import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../lib/config.ts';
import { MODELS, isInstalled, isAvailable } from '../../lib/models.ts';
import { TUNING, tuningFrom } from '../../lib/tuning.ts';
import { ROOT, SR, coolDown, cooledWords, fakeServer, freePort, outOfPlace, saveWav, scratch, serverMemory, silence, sleep, startServer, suite, thermalPressure } from '../helpers.ts';
import { SCRIPTS, Room, contentWords, heatIn, heatWords, heavy, judge, loopOffset, loopTruth, loopTruthByWindow, meeting, memoryCheck, memoryWords, quantile, serverMemoryOk, table, voices, windowOffsets, windows } from '../meeting.ts';

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

const pageErrors: string[] = [];
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

/** The nodes of the page's transcript (itself and everything in it) and the lines it shows (#48). */
const transcriptDom = (w) => js(w, `(() => {
  const t = document.getElementById('transcript');
  const walk = document.createTreeWalker(t, NodeFilter.SHOW_ALL);
  let nodes = 1;
  while (walk.nextNode()) nodes++;
  return { transcript: nodes, lines: t.querySelectorAll('.line:not(.partial)').length };
})()`);

/** Fake mics that play the meeting `m` (a.wav, b.wav); the loop length in seconds. */
function speakFor(m) {
  const [m1, m2] = Room.render(m);
  saveWav(path.join(SPEAKERS, 'a.wav'), m1);
  saveWav(path.join(SPEAKERS, 'b.wav'), m2);
  saveWav(path.join(SPEAKERS, 'c.wav'), silence(1));
  return m1.length / SR;
}

// ---------- PAGE: a page holding hours of transcript ----------

/** n lines of a two-mic meeting from line `from` on, ~4.3 s each, a quarter overlapping the line before. */
function fakeLines(from, n) {
  const bank = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'meeting-ro.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && contentWords(l) >= 3);
  const out: { id: number; mic: number; start: number; end: number; text: string }[] = [];
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
  // Its speed is judged, so it starts on a Mac that is not hot from the group before it, and the checks that time the
  // page are known limits where macOS reported heavy thermal pressure while they ran (§14.5 #24).
  console.log(`page: ${cooledWords(await coolDown())}`);
  const heatLog: { at: number, level: number | null }[] = [];
  const readHeat = async () => heatLog.push({ at: Date.now(), level: await thermalPressure() });
  const heatTimer = setInterval(readHeat, 5000);
  heatTimer.unref();
  /** The worst thermal pressure from `t0` (Date.now()) until now, with a reading now. */
  const heatSince = async (t0: number) => (await readHeat(), heatIn(heatLog, t0, Infinity));
  for (const f of ['a', 'b', 'c']) saveWav(path.join(SPEAKERS, `${f}.wav`), silence(1));
  const fake = await fakeServer({ greet: [{ type: 'tuning', values: tuningFrom(config), defaults: tuningFrom(config), ranges: TUNING }] });
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
    const fedFrom = Date.now();
    const batches: number[] = [];
    for (let b = 0; b < N; b += 500) {
      const before = await dt.metrics();
      await feed(all.slice(b, b + 500));
      const after = await dt.metrics();
      batches.push(((after.TaskDuration - before.TaskDuration) * 1000) / (Math.min(500, N - b) * 5));
    }
    const longest = Math.max(0, ...(await js(win, 'window.__long')));
    const heat1 = await heatSince(fedFrom);
    t.check('STRESS-PAGE-01', `${N} lines with their live guesses: each message costs no more at the end than at the start (≤ 2×), no task over 200 ms`,
      (batches.at(-1) as number) <= 2 * batches[0] && longest <= 200, `main-thread time per message: ${batches.map((x) => p(x, 2)).join(', ')} ms; longest task ${p(longest, 0)} ms${heatWords(heat1)}`, { known: heavy(heat1) });
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
    const probedFrom = Date.now();
    const sentAt: number[] = [];
    for (const l of probes) {
      sentAt.push(Date.now());
      for (const msg of messages(l)) fake.send(msg);
      await sleep(500);
    }
    shown += probes.length;
    await sleep(500);
    const lag = async (w) => {
      const seen = await js(w, 'window.__seen');
      return probes.map((l, i) => (Object.entries(seen as Record<string, number>).find(([text]) => text.includes(l.text))?.[1] ?? Infinity) - sentAt[i]);
    };
    const [onStage, onCaptions] = [await lag(win), await lag(captions)];
    const heat5 = await heatSince(probedFrom);
    t.check('STRESS-PAGE-05', `at line ~${N} the projector and the caption window show a new line within 300 ms`, [...onStage, ...onCaptions].every((x) => x <= 300),
      `projector ${onStage.map((x) => p(x, 0)).join(', ')} ms; caption window ${onCaptions.map((x) => p(x, 0)).join(', ')} ms${heatWords(heat5)}`, { known: heavy(heat5) });
    await js(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

    // PAGE-06: the server catching up after a backlog sends 500 lines at once.
    await js(win, 'window.__long = []');
    const burstFrom = Date.now();
    await readHeat();
    await feed(fakeLines(N + 355, 500), Infinity);
    const burst = Math.max(0, ...(await js(win, 'window.__long')));
    const t0 = Date.now();
    await js(win, `document.getElementById('openSettings').click(); document.getElementById('settingsClose').click(); 1`);
    const answer = Date.now() - t0;
    const heat6 = await heatSince(burstFrom);
    t.check('STRESS-PAGE-06', 'a burst of 500 lines: no task over 500 ms, a click answered within 200 ms after it', burst <= 500 && answer <= 200,
      `longest task ${p(burst, 0)} ms; click answered in ${answer} ms${heatWords(heat6)}`, { known: heavy(heat6) });

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
    clearInterval(heatTimer);
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
    const samples: any[] = []; // { sec, page, heap, nodes, ...dom, server, serverParts }
    let banner = 0;
    while (Date.now() - start < minutes * 60000) {
      await sleep(60000);
      const sec = (Date.now() - start) / 1000;
      const error = await js(win, `document.getElementById('error').hidden ? '' : document.getElementById('error').textContent`);
      if (error) banner++, console.log(`  ${p(sec / 60, 0)} min: error banner: ${error}`);
      const page = processMb(win);
      const metrics = await dt.metrics();
      const heap = metrics.JSHeapUsedSize / 1048576;
      // #48: the page's own memory (JS heap, DOM nodes: all of them, and the transcript's with its lines) and the
      // server's, with what it is made of.
      const dom = await transcriptDom(win);
      const srv = await serverMemory(server);
      samples.push({ sec, page, heap, nodes: metrics.Nodes, ...dom, server: srv.mb, serverParts: srv });
      if (Math.round(sec / 60) % 10 === 0) console.log(`  ${p(sec / 60, 0)} min: page ${page} MB (heap ${p(heap, 0)} MB, ${metrics.Nodes} DOM nodes, ${dom.transcript} in the transcript), server ${srv.mb} MB, ${sockets()[live]?.finals.length ?? 0} lines`);
    }
    // SOAK-05: the caption window shows what the page shows.
    const newest = (await finalTexts(win)).at(-1);
    const onCaptions = await waitFor(async () => (await js(captions, `[...document.querySelectorAll('.stage-line')].map((e) => e.textContent).join('\\n')`)).includes(newest), 1000);
    // SOAK-08: where the model runs after the hours, as the page says it (#39): still the GPU, never moved to the CPU.
    const where = await js(win, `({ text: document.getElementById('statusText').textContent, title: document.getElementById('status').title })`);
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
    // The alignment is taken every 10 minutes (§14.5 #24): the page can lose audio under load (~1 s in the first hour
    // on 2026-11-11), and one alignment for the whole soak then puts the short replies of the passes before it on the
    // other mic. Lost audio is STRESS-SOAK-01's to judge; the detail of SOAK-02 says how far the alignment moved.
    const perWindow = windowOffsets(m, lines, offsets, length, period);
    const truthItems = loopTruthByWindow(m, offsets.map((o) => o ?? 0), perWindow, length, period);
    const alignMoved = (mic: number) => {
      const xs = perWindow.map((w) => w.offsets[mic]).filter((x): x is number => x !== null);
      return xs.length ? Math.max(...xs) - Math.min(...xs) : NaN;
    };
    // The delay people see: from when the audio at a line's end was sent, to when the line arrived.
    const seen = lines.map((l) => ({ ...l, sentSec: undefined, delay: (l.arrival - conn.sent[Math.min(conn.sent.length - 1, Math.max(0, Math.ceil(l.end * 10) - 1))]) / 1000 }));
    const j = judge(truthItems, seen, { groups: windows(length) });
    // A line said over someone else's speech waits for the other mic's sentence (decision #6), so it is held to a
    // looser limit; solo lines, most of a meeting where people take turns, must come within 2 s.
    const inWindow = (g) => (l) => (l.start + l.end) / 2 >= g.start && (l.start + l.end) / 2 < g.end;
    const groups = j.groups as ((typeof j.groups)[number] & { delays?: number[], overlapDelays?: number[] })[]; // the two lists are added here
    for (const g of groups) {
      g.delays = j.lines.filter(inWindow(g)).filter((l) => l.solo).map((l) => l.delay);
      g.overlapDelays = j.lines.filter(inWindow(g)).filter((l) => !l.solo).map((l) => l.delay);
    }
    const full = groups.filter((g) => Math.min(g.end, length) - g.start >= 120); // at least 2 minutes of meeting
    const windowsOk = full.every((g) => (g.solo.n + g.overlapped.n ? (g.solo.caught + g.overlapped.caught) / (g.solo.n + g.overlapped.n) : 1) >= 0.95 && g.wrong === 0);
    const p95 = full.map((g) => quantile(g.delays, 0.95));
    const overlapP95 = full.map((g) => quantile(g.overlapDelays, 0.95)).filter(Number.isFinite);
    fs.writeFileSync(path.join(OUT, 'soak.md'), [`# Soak: ${minutes} min in real time through the page (${model})`, '', `Mic offsets in the loop: ${offsets.map((o) => p(o, 2)).join(', ')} s; every 10 minutes (mic 1): ${perWindow.map((w) => p(w.offsets[0], 2)).join(', ')} s.`, '',
      table(j.groups, (g) => ({ 'Seen delay p95, solo (s)': p(quantile(g.delays, 0.95)), 'Overlapping (s)': p(quantile(g.overlapDelays, 0.95)), 'Page MB': samples.filter((s) => s.sec <= g.end).at(-1)?.page ?? '—', 'Server MB': samples.filter((s) => s.sec <= g.end).at(-1)?.server ?? '—' })), '',
      // As in meeting.md and mic3.md (test/stress.ts): what SOAK-02 counts as wrong, to trace it (issue #46).
      '## Lines that are wrong', '',
      ...j.lines.filter((l) => l.kind !== 'ok').slice(0, 50).map((l) => `- ${l.kind} · mic ${l.mic + 1} · ${p(l.start, 1)}–${p(l.end, 1)} s · ${l.text.slice(0, 90)}`),
      ...j.both.slice(0, 20).map(([a, b]) => `- both mics · ${p(a.start, 1)} s · mic ${a.mic + 1}: ${a.text.slice(0, 60)} · mic ${b.mic + 1}: ${b.text.slice(0, 60)}`), ''].join('\n'));

    const wavs = fs.readdirSync(server.transcripts).filter((n) => n.endsWith('.wav')).map((n) => ({ n, sec: (fs.statSync(path.join(server.transcripts, n)).size - 44) / 2 / SR }));
    const recorded = (stop - start) / 1000;
    t.check('STRESS-SOAK-01', `${minutes} min through the page: no audio lost between page and server`, wavs.length === 2 && wavs.every((w) => Math.abs(w.sec - recorded) <= 2),
      `recorded ${p(recorded, 1)} s; ${wavs.map((w) => `${w.n.slice(-8)} ${p(w.sec, 1)} s`).join(', ')}`);
    t.check('STRESS-SOAK-02', 'lines keep coming: every 10 minutes ≥ 95 % of utterances caught, none on the wrong mic', windowsOk && offsets.every((o) => o !== null),
      `${full.map((g) => `${g.name}: ${g.solo.caught + g.overlapped.caught}/${g.solo.n + g.overlapped.n}, wrong ${g.wrong}`).join('; ')}; aligned every 10 minutes, moved ${p(alignMoved(0), 2)} s (mic 1), ${p(alignMoved(1), 2)} s (mic 2)`);
    t.check('STRESS-SOAK-03', 'the delay people see: solo lines p95 ≤ 2 s in every 10 minutes, the last no more than 0.5 s above the first; lines over other speech p95 ≤ 10 s',
      p95.every((x) => x <= 2) && p95.at(-1) <= p95[0] + 0.5 && overlapP95.every((x) => x <= 10),
      `solo p95 per 10 min: ${p95.map((x) => p(x, 1)).join(', ')} s; overlapping: ${overlapP95.map((x) => p(x, 1)).join(', ') || '—'} s`);
    // Every sample, to trace a failure (#48).
    fs.writeFileSync(path.join(OUT, 'soak.json'), JSON.stringify({ samples }));
    const warm = Math.min(1800, (minutes * 60) / 4);
    const series = (value) => samples.map((s) => ({ at: s.sec, value: value(s) }));
    // SOAK-04 (#48): judged on what the page's code controls. The process's own memory (its caches, fonts and drawing)
    // swings by 100 MB and more from minute to minute while the JS heap stays at a few MB, so it only has a ceiling.
    const heap = memoryCheck(series((s) => s.heap), warm);
    const beyond = memoryCheck(series((s) => s.nodes - s.transcript), warm); // nodes that are not the transcript's
    const shown = samples.filter((s) => s.sec >= warm && s.lines > 0);
    const [perLine0, perLine1] = [shown[0], shown.at(-1)].map((s) => (s ? s.transcript / s.lines : NaN));
    const pagePeak = Math.max(...samples.map((s) => s.page).filter(Number.isFinite));
    t.check('STRESS-SOAK-04', 'page memory after warm-up: JS heap low point rises ≤ 10 MB; DOM nodes grow only with the lines shown; the page process ≤ 500 MB',
      heap.growth <= 10 && beyond.growth <= 1000 && perLine1 <= 1.1 * perLine0 && pagePeak <= 500,
      `JS heap low point ${p(heap.from, 1)} → ${p(heap.to, 1)} MB; DOM nodes outside the transcript, low point ${p(beyond.from, 0)} → ${p(beyond.to, 0)}; `
      + `transcript nodes per line ${p(perLine0, 1)} (${shown[0]?.lines ?? '—'} lines) → ${p(perLine1, 1)} (${shown.at(-1)?.lines ?? '—'} lines); page process peak ${p(pagePeak, 0)} MB, end ${samples.at(-1)?.page ?? '—'} MB`);
    t.check('STRESS-SOAK-05', 'the caption window shows the newest line', onCaptions, JSON.stringify(newest?.slice(0, 60)));
    const srv = memoryCheck(series((s) => s.server), warm);
    const parts = (s) => (Number.isFinite(s?.serverParts?.heap) ? ` (heap ${s.serverParts.heap} with ${s.serverParts.used} in use, outside the heap ${s.serverParts.external}, native ${s.serverParts.native} MB)` : '');
    const end = samples.at(-1);
    t.check('STRESS-SOAK-06', 'server memory in real time, as STRESS-MEET-08: after warm-up its low point and median rise ≤ 50 MB and ≤ 10 MB per hour, its peak ≤ 200 MB above the first 30 min',
      serverMemoryOk(srv),
      `${end?.serverParts?.footprint ? 'footprint' : 'resident'}: ${memoryWords(srv)}${parts(samples.find((s) => s.sec >= warm && s.server === srv.peak))}; end ${end?.server ?? '—'} MB${parts(end)}, resident ${end?.serverParts?.rss ?? '—'} MB`);
    const txt = fs.readdirSync(server.transcripts).filter((n) => n.endsWith('.txt')).flatMap((n) => fs.readFileSync(path.join(server.transcripts, n), 'utf8').split('\n').filter(Boolean));
    const lastIn = txt.some((l) => l.endsWith(lines.at(-1)?.text ?? '\u0000'));
    const differs = download.findIndex((l, i) => l !== txt[i]);
    const sorted = (x) => [...x].sort().join('\n');
    const same = sorted(download) === sorted(txt);
    const moved = outOfPlace(download, txt); // both in speaking order since #7 and #50
    t.check('STRESS-SOAK-07', 'after Stop: the last sentence is in the .txt, Download has the same lines in the same order, no error in the console or on the page',
      lastIn && same && moved === 0 && pageErrors.length === 0 && banner === 0,
      `last line saved ${lastIn}; Download ${download.length} lines, .txt ${txt.length}, same lines ${same}, ${moved} out of order${differs < 0 ? '' : ` (the first at line ${differs + 1}: ${JSON.stringify(download[differs]?.slice(0, 40))} vs ${JSON.stringify(txt[differs]?.slice(0, 40))})`}; `
      + `${pageErrors.length} console errors${pageErrors.length ? ` (${pageErrors.slice(0, 2).join(' | ').slice(0, 160)})` : ''}; error banner seen ${banner}×`);
    t.check('STRESS-SOAK-08', 'after the hours the page still says the model runs on the GPU (it never moved to the CPU)',
      /· ready on GPU$/.test(where.text) && /^Runs on GPU/.test(where.title) && !/could not/i.test(where.title), `status ${JSON.stringify(where.text)}, tooltip ${JSON.stringify(where.title)}`);
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
    const outages: any[] = []; // { minute, outage, shown, reconnect, conn, told }
    for (const [minute, outage] of plan) {
      await sleep(start + minute * 60000 - Date.now());
      const shown = await finalTexts(win);
      process.kill(server.pid as number, 'SIGKILL'); // a started server has a pid
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
    // A reconnect carries the clock on (D2, #10): a connection's times start where the audio sent before it ended
    // (0.1 s a chunk). Counted from the connection's own start here, as the meeting's loop is matched per connection.
    const since = (k) => conns.slice(0, k).reduce((sum, c) => sum + c.sent.length * 0.1, 0);
    const own = (k) => (conns[k]?.finals ?? []).map((f) => ({ mic: f.mic, start: f.start - since(k), end: f.end - since(k), text: f.text }));
    // The buffered audio: what the page recorded while the server was down is transcribed on the next connection.
    const buffered = (o) => {
      const c = conns[o.conn];
      const lines = own(o.conn);
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
    // One transcript for the whole recording, its times never going back on a mic.
    const times = ((txt[0] ?? []).map((l) => l.match(/^\[([\d:]+)\] (?:(Mic \d+): )?/)).filter(Boolean) as RegExpMatchArray[])
      .map(([, at, mic]) => ({ mic, sec: at.split(':').reduce((sum, x) => sum * 60 + Number(x), 0) }));
    const latest: Record<number, number> = {};
    const backwards = times.filter(({ mic, sec }) => {
      const earlier = sec + 1 < (latest[mic] ?? -Infinity);
      latest[mic] = Math.max(latest[mic] ?? -Infinity, sec);
      return earlier;
    }).length;
    t.check('STRESS-NET-01', `(D2) the server killed ${regular.length}× while the page records: it reconnects, buffered audio transcribed, nothing shown is lost, one transcript with the clock going on`,
      regular.every((o) => o.reconnect <= 30) && !lost.length && (n ? caught / n : 1) >= 0.9 && wavs.every(Boolean) && txt.length === 1 && !backwards,
      `back after ${regular.map((o) => p(o.reconnect, 1)).join(', ')} s; ${lost.length} shown lines missing from the .txt; buffered audio caught ${caught}/${n}; ${wavs.filter(Boolean).length}/${wavs.length} WAVs playable; `
      + `${txt.length} transcript file(s), starting at ${txt.map((f) => f[0]?.slice(0, 7) ?? '—').join(', ')}, last line at ${txt[0]?.at(-1)?.slice(0, 9) ?? '—'}; ${backwards} line(s) earlier than one before it on the same mic`);
    const long = outages.find((o) => o.outage > 300);
    if (long) {
      const x = buffered(long);
      const before = conns[long.conn - 1];
      const prevLines = own(long.conn - 1);
      const prevOffset = loopOffset(m, prevLines, 0, period);
      const dropAt = ((before.sent.length * 0.1 + prevOffset) % period + period) % period;
      const keptFrom = x.offsets[0] === null ? NaN : (((x.offsets[0] - dropAt) % period) + period) % period;
      const newest = Math.abs(keptFrom - (long.outage - 300)) < 20;
      const shownLoss = /lost|missing|pierd/i.test(long.told);
      t.check('STRESS-NET-02', `(D3) a ${long.outage / 60}-minute outage: the newest 5 minutes kept and the loss shown`, newest && shownLoss,
        `the page sent ${p((x.burst ?? 0) / 600, 1)} min of buffered audio, from ${p(keptFrom / 60, 1)} min after the drop (${newest ? 'the newest' : 'not the newest'} part); loss shown: ${shownLoss} (${JSON.stringify(long.told.trim().slice(0, 80))})`);
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
  } catch (err: any) {
    t.check(`STRESS-${group.toUpperCase()}-RUN`, `the ${group} group ran to the end`, false, err.stack);
  } finally {
    fs.rmSync(SPEAKERS, { recursive: true, force: true });
    t.finish();
    app.exit((process.exitCode ?? 0) as number); // a number here, or unset
  }
});
