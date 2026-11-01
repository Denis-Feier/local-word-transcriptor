// The stress tier, server side (TESTING.md §14): hours-long synthetic meetings and what goes wrong in long meetings,
// against real servers. Groups run separately so run-all.js can put them in parallel lanes.
//
//   node test/stress.js --group meet [--short] [--hours 4] [--speed 8] [--recordings a.wav,b.wav]
//   node test/stress.js --group mic3 | load | cap [--models a,b] | eng | conn,conc,tune,disk
// Reports (per block and per 10 minutes) go to STRESS_OUT (run-all.js: test-results/<run>/stress/).
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { config } from '../lib/config.js';
import { MODELS, isInstalled, isAvailable } from '../lib/models.js';
import { TUNING, sanitizeTuning } from '../lib/tuning.js';
import { sharedWords } from '../lib/wer.js';
import { SR, startServer, scratch, sleep, suite } from './helpers.js';
import { CHUNK, SCRIPTS, Room, contentWords, hoursScript, judge, meeting, meetingFrom, quantile, sessionBlocks, table, truth, voices, windows } from './meeting.js';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const groups = option('--group', 'meet').split(',');
const short = args.includes('--short');
const hours = Number(option('--hours', 4));
const speed = Number(option('--speed', 8));
const recordings = option('--recordings', null);
const MODEL = option('--model', process.env.TEST_MODEL ?? 'parakeet-ro-110m');
const OUT = process.env.STRESS_OUT ?? scratch('stress-out');
fs.mkdirSync(OUT, { recursive: true });
const t = suite(`stress (${groups.join(', ')}${short ? ', short' : ''})`);
const run = promisify(execFile);
const STEP = CHUNK / SR;

// ---------- the server, from outside ----------

const rss = async (pid) => Math.round(Number((await run('ps', ['-o', 'rss=', '-p', String(pid)])).stdout) / 1024);
const openFiles = async (pid) => (await run('lsof', ['-p', String(pid)], { maxBuffer: 1 << 24 })).stdout.trim().split('\n').length - 1;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const usable = (id) => {
  const m = MODELS.find((x) => x.id === id);
  return m && isInstalled(m) && isAvailable(m, { whisperBin: config.whisper.bin });
};

/** A child process of the server (a model's own process: whisper-server, Python), or null. */
function engineProcess(serverPid, skip = new Set()) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command=']).toString().trim().split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map(([, pid, ppid, cmd]) => ({ pid: +pid, ppid: +ppid, cmd }));
  const family = new Set([serverPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (family.has(r.ppid) && !family.has(r.pid)) family.add(r.pid), (grew = true);
  }
  return rows.find((r) => r.pid !== serverPid && family.has(r.pid) && !skip.has(r.pid) && /whisper-server|python/i.test(r.cmd))?.pid ?? null;
}

// ---------- the client ----------

/**
 * Stream a meeting to a server as the page does (/ws?mics, 100 ms frames), at `speed` × real time (Infinity: as fast
 * as the server reads), with the script's events (settings, Clear) at their time. Every message is recorded with the
 * audio sent when it arrived (sentSec: the session's clock). Every 2 s the server is probed (a page file and a
 * WebSocket ping), every 10 s its memory is read. onChunk(i, r, ws) runs after each frame (async allowed);
 * cutAt (meeting seconds) drops the connection there without Stop; startAt (epoch ms) delays the first frame.
 */
async function play(server, m, { speed: pace = speed, saveAudio = true, onChunk, cutAt = Infinity, startAt = 0, probe = true, waitMs = 300000, room = new Room(m) } = {}) {
  const r = { finals: [], allFinals: [], partials: [], starts: new Set(), errors: [], files: [], statuses: [], tuning: [], unknown: [], sentSec: 0, sentPerMic: [0, 0, 0], probes: [], memory: [], backlog: [], closed: false };
  const ws = new WebSocket(server.ws('?mics'));
  r.ws = ws;
  const finalIds = new Set();
  ws.on('message', (data) => {
    const msg = JSON.parse(data);
    const now = Date.now();
    if (msg.type === 'final') {
      finalIds.add(msg.id);
      const f = { ...msg, mic: msg.mic ?? 0, sentSec: r.sentSec, wall: now };
      r.allFinals.push(f);
      if (msg.text) r.finals.push(f);
      r.backlog.push({ sentSec: r.sentSec, waiting: r.starts.size - finalIds.size, behind: r.sentSec - msg.end });
    } else if (msg.type === 'partial') r.partials.push({ mic: msg.mic, sentSec: r.sentSec });
    else if (msg.type === 'vad') msg.speaking && r.starts.add(msg.id);
    else if (msg.type === 'error') r.errors.push({ message: msg.message, sentSec: r.sentSec });
    else if (msg.type === 'file') r.files.push(msg);
    else if (msg.type === 'status') r.statuses.push({ ...msg, wall: now });
    else if (msg.type === 'tuning') r.tuning.push(msg);
    else if (!['models', 'mics', 'progress'].includes(msg.type)) r.unknown.push(msg);
  });
  ws.on('close', () => (r.closed = true));
  ws.on('error', () => (r.closed = true));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  for (let t0 = Date.now(); !r.statuses.some((s) => s.state === 'ready');) {
    if (Date.now() - t0 > 600000) throw new Error('server not ready');
    await sleep(50);
  }
  ws.send(JSON.stringify({ type: 'options', saveAudio }));
  const timers = [];
  if (probe) {
    let pinged = 0;
    ws.on('pong', () => pinged && r.probes.push({ kind: 'ping', ms: Date.now() - pinged, sentSec: r.sentSec }));
    timers.push(setInterval(async () => {
      const t0 = Date.now();
      try {
        await (await fetch(`${server.url}/`)).text();
        r.probes.push({ kind: 'http', ms: Date.now() - t0, sentSec: r.sentSec });
      } catch {
        r.probes.push({ kind: 'http', ms: Infinity, sentSec: r.sentSec });
      }
      if (ws.readyState === WebSocket.OPEN) (pinged = Date.now()), ws.ping();
    }, 2000));
    timers.push(setInterval(() => rss(server.pid).then((mb) => r.memory.push({ sentSec: r.sentSec, mb, wall: Date.now() })).catch(() => {}), 10000));
  }
  while (Date.now() < startAt) await sleep(2);
  const events = new Map(m.events.filter((e) => e.type !== 'layout').map((e) => [Math.round(e.t / STEP), e]));
  const t0 = performance.now();
  for (let i = 0; i < m.chunks && !r.closed; i++) {
    if (i * STEP >= cutAt) {
      ws.terminate();
      break;
    }
    const e = events.get(i);
    if (e?.type === 'tuning') ws.send(JSON.stringify(e.reset ? { type: 'tuning', reset: true } : { type: 'tuning', values: e.values }));
    if (e?.type === 'clear') ws.send(JSON.stringify({ type: 'reset' }));
    const frame = room.frame(i);
    if (frame) {
      ws.send(frame);
      const count = new Uint32Array(frame, 0, 1)[0];
      for (let mic = 0; mic < count; mic++) r.sentPerMic[mic] += CHUNK;
      r.sentSec += STEP;
    }
    await onChunk?.(i, r, ws);
    if (pace === Infinity) {
      while (ws.bufferedAmount > 4e6 && !r.closed) await sleep(5);
      if (i % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
    } else {
      const wait = t0 + ((i + 1) * 100) / pace - performance.now();
      if (wait > 3) await sleep(wait);
    }
  }
  r.wallSec = (performance.now() - t0) / 1000;
  if (!r.closed && cutAt === Infinity) {
    ws.send(JSON.stringify({ type: 'flush' }));
    const t1 = Date.now();
    while (!r.closed && Date.now() - t1 < waitMs && [...r.starts].some((id) => !finalIds.has(id))) await sleep(50);
    await sleep(300);
  }
  r.missingFinals = [...r.starts].filter((id) => !finalIds.has(id)).length;
  timers.forEach(clearInterval);
  return r;
}

const close = (ws) => new Promise((resolve) => (ws.readyState === WebSocket.CLOSED ? resolve() : (ws.once('close', resolve), ws.close())));

/** Text for clips without one (real recordings): each transcribed alone, as the scenarios' references. */
async function fillTexts(server, voice) {
  for (const clips of voice.people) {
    for (const c of clips.filter((x) => x.text === null)) {
      const r = await play(server, meetingFrom([{ person: 0, start: 1, clip: c }], { mics: 1 }), { speed: Infinity, probe: false, saveAudio: false });
      await close(r.ws);
      c.text = r.finals.map((f) => f.text).join(' ');
      c.short = contentWords(c.text) < 3;
    }
  }
}

/** Two sentences on two mics, so the model has transcribed before a baseline is measured (its first runs allocate). */
async function warmUp(server, v) {
  const [a, b] = [v.people[0], v.people[1]].map((clips) => clips.find((c) => !c.short));
  await close((await play(server, meetingFrom([{ person: 0, start: 1, clip: a }, { person: 1, start: 2 + a.samples.length / SR, clip: b }]), { probe: false, saveAudio: false })).ws);
  await sleep(2000);
  fs.rmSync(server.transcripts, { recursive: true, force: true }); // its lines are not the test's
}

const voicesFor = async (server, opts) => {
  const v = await voices({ people: 3, recordings, ...opts });
  if (recordings) await fillTexts(server, v);
  return v;
};

/** Memory after warm-up: total growth and the trend in MB per hour of meeting (least squares). */
function memoryTrend(samples, warmSec) {
  const s = samples.filter((x) => x.sentSec >= warmSec);
  if (s.length < 3) return { growth: NaN, perHour: NaN, from: NaN, to: NaN, span: 0 };
  const xs = s.map((x) => x.sentSec / 3600);
  const mx = xs.reduce((a, b) => a + b) / xs.length;
  const my = s.reduce((a, b) => a + b.mb, 0) / s.length;
  const slope = xs.reduce((sum, x, i) => sum + (x - mx) * (s[i].mb - my), 0) / xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return { growth: s.at(-1).mb - s[0].mb, perHour: slope, from: s[0].mb, to: s.at(-1).mb, span: xs.at(-1) - xs[0] };
}

const lineList = (r) => r.finals.map((f) => ({ id: f.id, mic: f.mic, start: f.start, end: f.end, text: f.text, ms: f.ms, sentSec: f.sentSec }));
const p = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const pc = (a, b) => (b ? `${((100 * a) / b).toFixed(1)} %` : '—');

/** Judge a played meeting and write its report: per block and per 10-minute window, with the server's memory. */
function report(name, title, m, r, extra = '') {
  const items = truth(m);
  const blocks = sessionBlocks(m);
  const length = m.toSession(m.length);
  const j = judge(items, lineList(r), { groups: [...blocks, ...windows(length).map((w) => ({ ...w, window: true }))], partials: r.partials });
  const mem = (g) => {
    const s = r.memory.filter((x) => x.sentSec >= g.start && x.sentSec < g.end);
    return { 'Server MB': s.length ? s.at(-1).mb : '—' };
  };
  const md = [
    `# ${title}`, '', `Voices: ${m.voice}. ${(length / 3600).toFixed(2)} h of meeting, ${m.utterances.length} utterances, ${r.finals.length} lines, streamed in ${(r.wallSec / 60).toFixed(1)} min.`, extra, '',
    '## Blocks', '', table(j.groups.filter((g) => !g.window), mem), '', '## Every 10 minutes', '', table(j.groups.filter((g) => g.window), mem), '',
    '## Lines that are wrong', '',
    ...j.lines.filter((l) => l.kind !== 'ok').slice(0, 50).map((l) => `- ${l.kind} · mic ${l.mic + 1} · ${p(l.start, 1)}–${p(l.end, 1)} s · ${l.text.slice(0, 90)}`),
    ...j.both.slice(0, 20).map(([a, b]) => `- both mics · ${p(a.start, 1)} s · mic ${a.mic + 1}: ${a.text.slice(0, 60)} · mic ${b.mic + 1}: ${b.text.slice(0, 60)}`),
  ];
  fs.writeFileSync(path.join(OUT, `${name}.md`), `${md.join('\n')}\n`);
  // Everything judged, for tracing a failure (TESTING.md §10): lines with their verdict, utterances caught or not.
  const plain = ({ clip, ...u }) => u;
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify({ lines: j.lines, utterances: j.utterances.map(plain), events: m.events, dropouts: m.dropouts, blocks: sessionBlocks(m) }));
  console.log(`report: ${path.join(OUT, `${name}.md`)}`);
  return j;
}

/** The transcript and audio files of a played meeting (STRESS-MEET-09). */
function checkFiles(dir, r, clears, length) {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const txt = names.filter((n) => n.endsWith('.txt')).flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split('\n').filter(Boolean));
  const problems = [];
  if (txt.length !== r.finals.length) problems.push(`${txt.length} lines in .txt for ${r.finals.length} lines sent`);
  const bad = txt.filter((l) => !/^\[(\d+:)?\d\d:\d\d\] (Mic \d: )?\S/.test(l));
  if (bad.length) problems.push(`${bad.length} lines not "[time] (Mic N: )text", e.g. ${JSON.stringify(bad[0])}`);
  const hourly = txt.filter((l) => /^\[\d+:\d\d:\d\d\]/.test(l)).length;
  const late = r.finals.filter((f) => f.start >= 3600).length;
  if (hourly !== late) problems.push(`${hourly} lines with [h:mm:ss], ${late} lines after the first hour`);
  const last = {};
  let back = 0;
  for (const l of txt) {
    const [, h, mm, ss, mic] = l.match(/^\[(?:(\d+):)?(\d\d):(\d\d)\] (?:Mic (\d): )?/) ?? [];
    const sec = Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
    const k = mic ?? '1';
    if (sec < (last[k] ?? 0)) back++;
    last[k] = sec;
  }
  if (back) problems.push(`times go back ${back}× on a mic`);
  const wavs = names.filter((n) => n.endsWith('.wav'));
  for (let mic = 0; mic < r.sentPerMic.filter(Boolean).length; mic++) {
    const files = wavs.filter((n) => Number(n.match(/-mic(\d)\.wav$/)?.[1] ?? 1) === mic + 1); // <stamp>.wav: one mic
    let bytes = 0;
    for (const n of files) {
      const buf = fs.readFileSync(path.join(dir, n)).subarray(0, 44);
      const size = fs.statSync(path.join(dir, n)).size;
      if (buf.readUInt32LE(4) !== size - 8 || buf.readUInt32LE(40) !== size - 44) problems.push(`${n}: header says ${buf.readUInt32LE(40)} bytes, file has ${size - 44}`);
      bytes += size - 44;
    }
    if (files.length !== clears + 1) problems.push(`mic ${mic + 1}: ${files.length} WAV files for ${clears + 1} transcripts`);
    if (Math.abs(bytes / 2 - r.sentPerMic[mic]) > CHUNK) problems.push(`mic ${mic + 1}: WAVs hold ${(bytes / 2 / SR).toFixed(1)} s, ${(r.sentPerMic[mic] / SR).toFixed(1)} s sent`);
  }
  return { ok: !problems.length, detail: problems.join('; ') || `${txt.length} lines in ${names.filter((n) => n.endsWith('.txt')).length} .txt, ${wavs.length} WAVs (${(length / 3600).toFixed(1)} h per mic) with correct headers` };
}

const probeMax = (r) => Math.max(0, ...r.probes.map((x) => x.ms));
/** The server's DEBUG log next to the reports: [final #n mic m] lines, drops, [mics] gate reports (TESTING.md §10). */
const keepLog = (server, name) => server?.log && fs.writeFileSync(path.join(OUT, `${name}-server.log`), server.log());
const rate = (x) => (x.n ? x.caught / x.n : 1);

// ---------- MEET and MIC3: hours-long meetings ----------

async function longMeeting(three) {
  const minutes = three ? SCRIPTS.mic3 : short ? SCRIPTS.short : hours === 4 ? SCRIPTS.full : hoursScript(hours);
  const server = await startServer({ model: MODEL, env: three ? { MAX_MICS: '3' } : {} });
  try {
    const v = await voicesFor(server);
    const m = meeting(v, { minutes, mics: three ? 3 : 2 });
    const length = m.toSession(m.length);
    console.log(`${three ? 'three mics' : 'meeting'}: ${(length / 3600).toFixed(2)} h, ${m.utterances.length} utterances, ${v.source}, ${speed}× → ~${(length / speed / 60).toFixed(0)} min`);
    await warmUp(server, v);
    const filesBefore = await openFiles(server.pid);
    const r = await play(server, m);
    await close(r.ws);
    await sleep(3000);
    const filesAfter = await openFiles(server.pid);
    const name = three ? 'mic3' : 'meeting';
    const j = report(name, three ? 'Three mics, 2 hours' : `Meeting, ${(length / 3600).toFixed(1)} hours`, m, r);
    const B = Object.fromEntries(j.groups.filter((g) => !g.window).map((g) => [g.name, g]));
    const blocks = Object.values(B);
    const easy = blocks.filter((g) => ['R', 'presentation', 'break', 'R2'].includes(g.name));
    const hard = blocks.filter((g) => !easy.includes(g));
    const attribution = easy.every((g) => g.wrong + g.both === 0) && hard.every((g) => (g.wrong + g.both) <= 0.01 * Math.max(1, g.lines));
    const attrDetail = blocks.map((g) => `${g.name} ${g.wrong}+${g.both}/${g.lines}`).join(', ');
    const caught = rate(j.all.solo) >= 0.98 && rate(j.all.overlapped) >= 0.9;
    const caughtDetail = `solo ${pc(j.all.solo.caught, j.all.solo.n)}, overlapped ${pc(j.all.overlapped.caught, j.all.overlapped.n)}`;
    const drift = blocks.filter((g) => Number.isFinite(g.offset)).map((g) => ({ name: g.name, d: g.offset - B.R.offset }));
    const keepsUp = B.R2.delayP95 <= 1.25 * B.R.delayP95 + 0.3 && B.R2.modelMs <= 1.25 * B.R.modelMs;
    const keepsDetail = `delay p95 R ${p(B.R.delayP95)} s → R′ ${p(B.R2.delayP95)} s; model ${p(B.R.modelMs, 0)} → ${p(B.R2.modelMs, 0)} ms`;
    const mem = memoryTrend(r.memory, Math.min(1800, 0.25 * length));
    const memOk = mem.growth <= 50 && (mem.span < 1 || mem.perHour <= 10);
    const memDetail = `${mem.from} → ${mem.to} MB after warm-up (+${mem.growth} MB), trend ${p(mem.perHour, 1)} MB/h over ${p(mem.span, 1)} h`;
    if (three) {
      t.check('STRESS-MIC3-01', 'three mics for 2 hours: lines on the right mic, nothing lost, no phantom lines',
        attribution && caught && j.all.phantom === 0, `wrong+both/lines: ${attrDetail}; ${caughtDetail}; phantom ${j.all.phantom}`);
      t.check('STRESS-MIC3-02', 'three mics: no clock drift, keeps up, memory flat',
        drift.every((x) => Math.abs(x.d) <= 0.1) && keepsUp && memOk, `drift ${drift.map((x) => `${x.name} ${p(x.d)}`).join(', ')}; ${keepsDetail}; ${memDetail}`);
      return;
    }
    t.check('STRESS-MEET-01', 'every line on the right mic (none in the easy blocks, ≤ 1 % in the hard ones)', attribution, `wrong+both/lines: ${attrDetail}`);
    t.check('STRESS-MEET-02', 'nothing lost: ≥ 98 % of solo and ≥ 90 % of overlapped utterances caught', caught, caughtDetail);
    t.check('STRESS-MEET-03', 'no phantom lines (silence, the break, door slams and typing)', j.all.phantom === 0, `${j.all.phantom} phantom lines; break block: ${B.break?.lines ?? '—'} lines`);
    const wer = B.R.wer.map((w, mic) => ({ mic, r: w, r2: B.R2.wer[mic] }));
    t.check('STRESS-MEET-04', 'accuracy holds: WER in R′ at most 2 points above R', wer.every((w) => w.r2 <= w.r + 0.02), wer.map((w) => `mic ${w.mic + 1} ${pc(w.r, 1)} → ${pc(w.r2, 1)}`).join(', '));
    t.check('STRESS-MEET-05', 'no clock drift: every block within 0.1 s of R', drift.every((x) => Math.abs(x.d) <= 0.1), drift.map((x) => `${x.name} ${p(x.d)}`).join(', '));
    t.check('STRESS-MEET-06', 'keeps up: delay and model time in R′ as in R', keepsUp, keepsDetail);
    t.check('STRESS-MEET-07', 'live text to the end: live guesses in R′ ≥ 80 % of R', B.R2.partials >= 0.8 * B.R.partials, `${B.R.partials} → ${B.R2.partials}`);
    t.check('STRESS-MEET-08', 'server memory flat after warm-up (≤ +50 MB, ≤ 10 MB per hour)', memOk, memDetail);
    const files = checkFiles(server.transcripts, r, m.events.filter((e) => e.type === 'clear').length, length);
    t.check('STRESS-MEET-09', 'files: every line in the .txt with hour times, WAVs as long as the audio sent', files.ok, files.detail);
    t.check('STRESS-MEET-10', 'the server answers within 500 ms throughout', probeMax(r) <= 500, `slowest of ${r.probes.length} probes: ${probeMax(r)} ms`);
    const pres = B.presentation;
    const presLines = j.lines.filter((l) => { const mid = (l.start + l.end) / 2; return pres && mid >= pres.start && mid < pres.end; });
    const longest = Math.max(0, ...presLines.filter((l) => l.mic === 0).map((l) => l.end - l.start));
    const strays = presLines.filter((l) => l.mic === 1 && l.kind !== 'ok').length;
    t.check('STRESS-MEET-11', 'the presentation: pieces ≤ 20 s, nothing on mic 2 but its questions, accuracy kept',
      pres && longest <= 20.5 && strays === 0 && pres.wer[0] <= B.R.wer[0] + 0.03, `longest piece ${p(longest, 1)} s, ${strays} stray lines on mic 2, WER ${pc(pres?.wer[0] ?? NaN, 1)} vs R ${pc(B.R.wer[0], 1)}`);
    t.check('STRESS-MEET-12', 'open files back to the baseline after the client leaves', filesAfter <= filesBefore + 2, `${filesBefore} → ${filesAfter}`);
  } finally {
    keepLog(server, three ? 'mic3' : 'meeting');
    await server.stop();
  }
}

// ---------- LOAD: more speech than the model can take ----------

async function overload(model, minutes, label) {
  const server = await startServer({ model, timeoutMs: 600000 });
  try {
    const v = await voicesFor(server);
    const m = meeting(v, { minutes: { R: minutes } });
    await warmUp(server, v);
    const before = await rss(server.pid);
    let httpMax = 0;
    let peak = before;
    const prober = setInterval(async () => {
      rss(server.pid).then((mb) => (peak = Math.max(peak, mb))).catch(() => {});
      const t0 = Date.now();
      try {
        await (await fetch(`${server.url}/`)).text();
        httpMax = Math.max(httpMax, Date.now() - t0);
      } catch {
        httpMax = Infinity;
      }
    }, 1000);
    const r = await play(server, m, { speed: Infinity, waitMs: 3600000, saveAudio: false });
    await sleep(15000);
    const after = await rss(server.pid);
    const up = alive(server.pid);
    await close(r.ws);
    // Memory a process has used stays with it, so the question is whether a second overload needs more again.
    const again = await play(server, m, { speed: Infinity, waitMs: 3600000, saveAudio: false, probe: false });
    await close(again.ws);
    await sleep(15000);
    const afterAgain = await rss(server.pid);
    clearInterval(prober);
    const perId = new Map();
    for (const f of r.allFinals) perId.set(f.id, (perId.get(f.id) ?? 0) + 1);
    const once = [...r.starts].every((id) => perId.get(id) === 1);
    const ordered = [0, 1].every((mic) => r.finals.filter((f) => f.mic === mic).every((f, i, a) => !i || f.start > a[i - 1].start));
    await sleep(500);
    const txt = fs.readdirSync(server.transcripts).filter((n) => n.endsWith('.txt')).flatMap((n) => fs.readFileSync(path.join(server.transcripts, n), 'utf8').split('\n').filter(Boolean));
    const expected = r.finals.length + again.finals.length;
    const worst = r.backlog.reduce((w, b) => (b.behind > w.behind ? b : w), { behind: 0, waiting: 0 });
    const told = r.unknown.length || r.errors.some((e) => /behind/i.test(e.message)) || r.statuses.some((s) => /behind/i.test(s.message ?? ''));
    console.log(`${label}: ${minutes} min of meeting sent in ${p(r.wallSec, 0)} s; the last line came ${p(worst.behind, 0)} s of audio behind with ${worst.waiting} sentences waiting`);
    t.check('STRESS-LOAD-01', `overload (${label}): the server stays up and answers within 1 s`, up && httpMax <= 1000, `alive ${up}; slowest page request ${httpMax} ms; ${minutes} min sent in ${p(r.wallSec, 0)} s`);
    t.check('STRESS-LOAD-02', `overload (${label}): every sentence gets exactly one final, in order, all in the .txt`, once && r.missingFinals === 0 && ordered && txt.length === expected,
      `${r.starts.size} sentences, ${r.missingFinals} without a final, ${[...perId.values()].filter((n) => n > 1).length} with several; in order per mic ${ordered}; ${txt.length} .txt lines for ${expected} (both overloads)`);
    t.check('STRESS-LOAD-03', `overload (${label}): a second overload needs at most 50 MB more than the first`, afterAgain - after <= 50,
      `${before} MB before, peak ${peak} MB, ${after} MB after the first, ${afterAgain} MB after the second`);
    t.check('STRESS-LOAD-04', `(D1) overload (${label}): the page is told that transcription is behind`, told,
      `at worst ${p(worst.behind, 0)} s of audio behind with ${worst.waiting} sentences waiting; ${told ? 'told' : 'nothing told the page'}`, { known: true });
  } finally {
    await server.stop();
  }
}

// ---------- CAP: can each model keep up with a meeting, with room to spare? ----------

async function capacity() {
  const ids = (option('--models', null)?.split(',') ?? MODELS.map((m) => m.id)).filter(usable); // --models a,b: just those
  const v = await voices({ people: 3 });
  const m = meeting(v, { minutes: { R: 15 } });
  const length = m.toSession(m.length);
  const rows = [];
  for (const id of ids) {
    const server = await startServer({ model: id, timeoutMs: 900000 }).catch((err) => ({ error: err }));
    if (server.error) {
      t.check('STRESS-CAP-01', `${id} keeps up with a meeting at 2× real time`, false, `server did not start: ${String(server.error.message).split('\n')[0]}`);
      continue;
    }
    try {
      const r = await play(server, m, { speed: 2, saveAudio: false, waitMs: 1800000 });
      await close(r.ws);
      const delays = (from, to) => r.finals.filter((f) => f.end >= from && f.end < to).map((f) => f.sentSec - f.end);
      // Lines also wait for overlapping speech on the other mic, which spreads the delay's tail by seconds with the
      // conversation; the median and the model's own time show whether the model itself falls behind.
      const first = quantile(delays(0, 300), 0.5);
      const last = quantile(delays(length - 300, Infinity), 0.5);
      const busy = r.finals.reduce((s, f) => s + (f.ms ?? 0), 0) / 1000 / r.wallSec;
      const j = judge(truth(m), lineList(r));
      const ok = last <= first + 2 && busy <= 0.8 && r.missingFinals === 0;
      const required = id === config.defaultModel || id === 'parakeet-ro-110m';
      rows.push(`| ${id} | ${ok ? 'yes' : 'no'} | ${p(first, 1)} → ${p(last, 1)} s (p95 ${p(quantile(delays(0, 300), 0.95), 1)} → ${p(quantile(delays(length - 300, Infinity), 0.95), 1)}) | ${p(quantile(r.finals.map((f) => f.ms), 0.5), 0)} ms | ${(busy * 100).toFixed(0)} % | ${pc(j.all.solo.caught, j.all.solo.n)} | ${j.all.wrong} |`);
      t.check('STRESS-CAP-01', `${id} keeps up with a meeting at 2× real time`, ok,
        `median delay first 5 min ${p(first, 1)} s, last 5 min ${p(last, 1)} s (audio); model busy ${(busy * 100).toFixed(0)} % of the time; ${r.missingFinals} never finished${required ? '' : '; not the default model'}`, { known: !required });
    } finally {
      await server.stop();
    }
  }
  fs.writeFileSync(path.join(OUT, 'capacity.md'), ['# Model capacity: block R (15 min, two people) at 2× real time', '',
    '| Model | Keeps up | Median delay, first → last 5 min | Model time per sentence | Model busy | Solo caught | Wrong mic |', '|---|---|---|---|---|---|---|', ...rows, ''].join('\n'));
}

// ---------- CONN, CONC, TUNE, DISK: connections, several clients, settings, files ----------

async function connections() {
  const server = await startServer({ model: MODEL });
  try {
    const v = await voices({ people: 3 });
    const clips = v.people[0].filter((c) => !c.short);
    const cycles = short ? 30 : 200;
    const warm = Math.max(5, cycles / 10); // the baseline once the model has transcribed a few sentences
    let files0;
    let mem0;
    let normal = 0;
    let cut = 0;
    for (let i = 0; i < cycles; i++) {
      if (i === warm) {
        await sleep(2000);
        [files0, mem0] = [await openFiles(server.pid), await rss(server.pid)];
      }
      const c = clips[i % clips.length];
      const m = meetingFrom([{ person: 0, start: 1, clip: c }]);
      const cutting = i % 4 === 3;
      const r = await play(server, m, { probe: false, saveAudio: i % 3 === 0, cutAt: cutting ? 1 + 0.6 * (c.samples.length / SR) : Infinity, waitMs: 30000 });
      if (cutting) cut++;
      else {
        normal += r.finals.length;
        await close(r.ws);
      }
    }
    await sleep(4000);
    const [files1, mem1] = [await openFiles(server.pid), await rss(server.pid)];
    const answers = (await fetch(`${server.url}/`)).status === 200;
    const txt = fs.readdirSync(server.transcripts).filter((n) => n.endsWith('.txt')).flatMap((n) => fs.readFileSync(path.join(server.transcripts, n), 'utf8').split('\n').filter(Boolean));
    t.check('STRESS-CONN-01', `${cycles} connections opened and closed: open files and memory back, the server answers`, files1 <= files0 + 2 && mem1 - mem0 <= 30 && answers,
      `after ${warm} connections → after ${cycles}: open files ${files0} → ${files1}; memory ${mem0} → ${mem1} MB; answers ${answers}`);
    t.check('STRESS-CONN-02', 'every sentence cut off by a closing connection is in a transcript file', txt.length - normal >= cut,
      `${txt.length} .txt lines: ${normal} from finished connections, ${txt.length - normal} from ${cut} cut off`);
  } finally {
    await server.stop();
  }
}

async function concurrent() {
  const server = await startServer({ model: MODEL });
  try {
    const sets = await Promise.all([0, 1, 2].map((k) => voices({ people: 3, keep: (i) => i % 3 === k })));
    const bank = sets.map((v) => v.people[0].filter((c) => !c.short).map((c) => c.text));
    const alone = await play(server, meeting(sets[0], { minutes: { R: short ? 2 : 5 } }), { speed: 4, saveAudio: false });
    await close(alone.ws);
    const base = quantile(alone.finals.map((f) => f.sentSec - f.end), 0.95);
    const minutes = short ? 4 : 20;
    const runs = await Promise.all(sets.map((v, k) => play(server, meeting(v, { minutes: { R: minutes }, seed: k + 1 }), { speed: 4, saveAudio: false })));
    await Promise.all(runs.map((r) => close(r.ws)));
    const foreign = runs.map((r, k) => r.finals.filter((f) => {
      const best = (texts) => Math.max(0, ...texts.map((x) => sharedWords(f.text, x).count));
      const own = best(bank[k]);
      return bank.some((texts, o) => o !== k && best(texts) >= 3 && best(texts) > own);
    }).length);
    const delays = runs.map((r) => quantile(r.finals.map((f) => f.sentSec - f.end), 0.95));
    t.check('STRESS-CONC-01', `three recording clients at once for ${minutes} min: own lines only, delay ≤ 2× one client's`, foreign.every((n) => n === 0) && delays.every((d) => d <= 2 * base),
      `other clients' lines: ${foreign.join(', ')}; delay p95 ${delays.map((d) => p(d)).join(', ')} s vs ${p(base)} s alone`);

    // Two recordings that start within the same second (two tabs, or the desktop app plus a browser tab).
    const c = sets[0].people[0].filter((x) => !x.short);
    const startAt = Math.ceil(Date.now() / 1000) * 1000 + 1500;
    const pair = await Promise.all([0, 1].map((k) => play(server, meetingFrom([{ person: 0, start: 1, clip: c[k] }, { person: 1, start: 2, clip: c[k + 2] }]), { speed: 4, startAt, probe: false })));
    await Promise.all(pair.map((r) => close(r.ws)));
    const paths = (r, kind) => r.files.filter((f) => f.kind === kind).map((f) => f.path);
    const sharedText = paths(pair[0], 'text').filter((x) => paths(pair[1], 'text').includes(x));
    const sharedAudio = paths(pair[0], 'audio').filter((x) => paths(pair[1], 'audio').includes(x));
    t.check('STRESS-CONC-02', 'two recordings starting in the same second get their own .txt and WAV files', !sharedText.length && !sharedAudio.length,
      sharedText.length || sharedAudio.length ? `both write to ${[...sharedText, ...sharedAudio].map((x) => path.basename(x)).join(', ')}` : `${paths(pair[0], 'text').map((x) => path.basename(x))} and ${paths(pair[1], 'text').map((x) => path.basename(x))}`);
  } finally {
    await server.stop();
  }
}

async function tuning() {
  const server = await startServer({ model: MODEL });
  try {
    const v = await voices({ people: 3 });
    const m = meeting(v, { minutes: { R: short ? 10 : 30 } });
    const changes = short ? 100 : 500;
    const from = Math.round((0.25 * m.length) / STEP);
    const to = Math.round((0.95 * m.length) / STEP);
    const every = Math.max(1, Math.floor((to - from) / changes));
    let rng = 3;
    const rand = () => (rng = (rng * 16807) % 2147483647) / 2147483647;
    const expected = {};
    let sent = 0;
    let mem0 = null;
    const r = await play(server, m, {
      async onChunk(i, res, ws) {
        if (i === from) mem0 = await rss(server.pid);
        if (i < from || i >= to || (i - from) % every || sent >= changes) return;
        const keys = Object.keys(TUNING).filter(() => rand() < 0.4);
        const values = Object.fromEntries((keys.length ? keys : ['vadThreshold']).map((k) => [k, TUNING[k].min + rand() * (TUNING[k].max - TUNING[k].min)]));
        Object.assign(expected, sanitizeTuning(values));
        ws.send(JSON.stringify({ type: 'tuning', values }));
        sent++;
      },
    });
    await close(r.ws);
    const mem1 = await rss(server.pid);
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(server.settingsFile, 'utf8')).tuning;
    } catch {
      // not valid JSON: reported below
    }
    const last = r.tuning.at(-1)?.values ?? {};
    const applied = Object.entries(expected).every(([k, x]) => last[k] === x && saved?.[k] === x);
    const late = r.finals.filter((f) => f.end > 0.8 * m.length).length;
    t.check('STRESS-TUNE-01', `${sent} setting changes during a meeting: memory flat, the last values applied and saved`, mem1 - mem0 <= 30 && applied && saved !== null && late > 0,
      `memory ${mem0} → ${mem1} MB; last values ${applied ? 'applied and saved' : `differ: sent ${JSON.stringify(expected)}, server ${JSON.stringify(last)}, file ${JSON.stringify(saved)}`}; ${late} lines in the last fifth`);
  } finally {
    await server.stop();
  }
}

async function disk() {
  const v = await voices({ people: 3 });
  if (process.platform !== 'darwin') t.skip('STRESS-DISK-01', 'Save audio on a disk that fills up', 'needs hdiutil (macOS)');
  else {
    const dir = scratch('disk');
    const mnt = path.join(dir, 'mnt');
    fs.mkdirSync(mnt);
    execFileSync('hdiutil', ['create', '-size', '20m', '-fs', 'HFS+', '-volname', 'LTSTRESS', '-o', path.join(dir, 'disk')], { stdio: 'pipe' });
    execFileSync('hdiutil', ['attach', path.join(dir, 'disk.dmg'), '-nobrowse', '-mountpoint', mnt], { stdio: 'pipe' });
    const server = await startServer({ model: MODEL, env: { TRANSCRIPTS_DIR: path.join(mnt, 'transcripts') } });
    try {
      const m = meeting(v, { minutes: { R: 12 } });
      const r = await play(server, m, { saveAudio: true });
      const up = alive(server.pid);
      if (!r.closed) await close(r.ws);
      const after = r.finals.filter((f) => f.start > 0.75 * m.length).length;
      const audioErrors = r.errors.filter((e) => /Could not save audio/.test(e.message)).length;
      const crash = up ? '' : `; the server exited: ${server.log().split('\n').filter((l) => /ENOSPC|Error:|^\s+at /.test(l)).slice(0, 2).join(' / ').slice(0, 200)}`;
      t.check('STRESS-DISK-01', 'Save audio on a disk that fills up: the server keeps transcribing, one "Could not save audio"', up && after >= 3 && audioErrors === 1,
        `alive ${up}; ${after} lines after the disk filled; ${audioErrors} "Could not save audio" errors, ${r.errors.length} errors in all${crash}`);
    } finally {
      keepLog(server, 'disk');
      await server.stop();
      try {
        execFileSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'pipe' });
      } catch {
        // already detached
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const server = await startServer({ model: MODEL });
  try {
    const m = meeting(v, { minutes: { R: 6 } });
    const gone = Math.round(120 / STEP);
    const r = await play(server, m, { onChunk: (i) => i === gone && fs.rmSync(server.transcripts, { recursive: true, force: true }) });
    const up = alive(server.pid);
    if (!r.closed) await close(r.ws);
    const after = r.finals.filter((f) => f.start > 150).length;
    t.check('STRESS-DISK-02', 'the transcripts folder disappears mid-meeting: lines keep coming, the page gets an error', up && after >= 3 && r.errors.some((e) => /Could not save/.test(e.message)),
      `alive ${up}; ${after} lines after; errors: ${[...new Set(r.errors.map((e) => e.message.split(':')[0]))].join(', ') || 'none'}`);
  } finally {
    await server.stop();
  }
}

// ---------- ENG: the model's own process dies, the model is switched ----------

async function engines() {
  const v = await voices({ people: 3 });
  const sidecars = ['whisper-large-v3-turbo', 'jackrabbit-110m-ro'].filter(usable);
  if (!sidecars.length) t.skip('STRESS-ENG-01', 'the model process killed three times', 'no Whisper or NeMo model installed');
  for (const id of sidecars) {
    const server = await startServer({ model: id, timeoutMs: 900000 });
    try {
      const m = meeting(v, { minutes: { R: 20 } });
      const killAt = [4, 9, 14].map((min) => Math.round((min * 60) / STEP));
      const kills = [];
      const r = await play(server, m, {
        speed: 2,
        waitMs: 900000,
        onChunk(i) {
          if (!killAt.includes(i)) return;
          const pid = engineProcess(server.pid);
          if (pid) process.kill(pid, 'SIGKILL'), kills.push(Date.now());
        },
      });
      await close(r.ws);
      const back = kills.map((k) => (r.statuses.find((s) => s.wall > k && s.state === 'ready')?.wall ?? Infinity) - k);
      const j = judge(truth(m), lineList(r));
      t.check('STRESS-ENG-01', `${id}: the model process killed 3 times, back within 30 s, no sentence lost`,
        kills.length === 3 && back.every((ms) => ms <= 30000) && r.errors.length === 0 && rate(j.all.solo) >= 0.98,
        `${kills.length} kills; back after ${back.map((ms) => p(ms / 1000, 1)).join(', ')} s; ${r.errors.length} sentences failed (${r.errors[0]?.message ?? ''}); solo caught ${pc(j.all.solo.caught, j.all.solo.n)}`);
    } finally {
      await server.stop();
    }
  }
  if (sidecars.length) {
    const server = await startServer({ model: sidecars[0], timeoutMs: 900000 });
    try {
      const killed = new Set();
      let gaveUpAt = null;
      const killer = (async () => {
        await sleep(30000);
        for (let k = 0; k < 4; k++) {
          let pid = null;
          for (let t0 = Date.now(); !pid && Date.now() - t0 < 30000; await sleep(200)) pid = engineProcess(server.pid, killed);
          if (!pid) break;
          await sleep(2000);
          process.kill(pid, 'SIGKILL');
          killed.add(pid);
        }
        gaveUpAt = Date.now();
      })();
      const r = await play(server, meeting(v, { minutes: { R: 5 } }), { speed: 1, waitMs: 60000 });
      await killer;
      await close(r.ws);
      const errorAfter = r.statuses.filter((s) => s.wall >= gaveUpAt - 5000).some((s) => s.state === 'error');
      const back = r.statuses.some((s) => s.wall > gaveUpAt && s.state === 'ready');
      t.check('STRESS-ENG-02', `(D4) ${sidecars[0]} killed ${killed.size} times within a minute: transcription comes back`, back,
        `${killed.size} kills; error shown ${errorAfter}; ${back ? 'came back' : `still not working ${p((Date.now() - gaveUpAt) / 1000, 0)} s later`}`, { known: true });
    } finally {
      await server.stop();
    }
  } else t.skip('STRESS-ENG-02', 'the model process killed four times within a minute', 'no Whisper or NeMo model installed');

  const plan = ['canary-1b-v2', MODEL, ['whisper-large-v3-turbo', 'parakeet-tdt-0.6b-v3'].find(usable), MODEL].filter((id) => id && usable(id));
  const server = await startServer({ model: MODEL });
  try {
    const m = meeting(v, { minutes: { R: 20 } });
    const at = [4, 8, 12, 16].map((min) => Math.round((min * 60) / STEP));
    let mem0 = null;
    const r = await play(server, m, {
      speed: 2,
      waitMs: 900000,
      async onChunk(i, res, ws) {
        if (i === at[0] - 50) mem0 = await rss(server.pid);
        const k = at.indexOf(i);
        if (k >= 0 && plan[k]) ws.send(JSON.stringify({ type: 'select', id: plan[k] }));
      },
    });
    await sleep(5000);
    const mem1 = await rss(server.pid);
    await close(r.ws);
    const j = judge(truth(m), lineList(r));
    t.check('STRESS-ENG-03', `model switched ${plan.length} times during a meeting: no line lost, memory back`, r.errors.length === 0 && rate(j.all.solo) >= 0.98 && mem1 - mem0 <= 100,
      `${[MODEL, ...plan].join(' → ')}; ${r.errors.length} failed; solo caught ${pc(j.all.solo.caught, j.all.solo.n)}; memory ${mem0} → ${mem1} MB`);
  } finally {
    await server.stop();
  }
}

// ---------- run ----------

const GROUPS = {
  meet: () => longMeeting(false),
  mic3: () => (short ? t.skip('STRESS-MIC3-01', 'three mics for 2 hours', 'not in --short') : longMeeting(true)),
  load: async () => {
    await overload(MODEL, short ? 10 : 60, MODEL);
    if (!short && usable('canary-1b-v2')) await overload('canary-1b-v2', 20, 'canary-1b-v2');
  },
  cap: () => (short ? t.skip('STRESS-CAP-01', 'each model at 2× real time', 'not in --short') : capacity()),
  conn: connections,
  conc: concurrent,
  tune: tuning,
  disk,
  eng: () => (short ? t.skip('STRESS-ENG-01', 'the model process killed', 'not in --short') : engines()),
};
for (const g of groups) {
  const t0 = Date.now();
  try {
    await GROUPS[g]();
  } catch (err) {
    t.check(`STRESS-${g.toUpperCase()}-RUN`, `the ${g} group ran to the end`, false, err.stack);
  }
  console.log(`(${g}: ${((Date.now() - t0) / 60000).toFixed(1)} min)\n`);
}
t.finish();
