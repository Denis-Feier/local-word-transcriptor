// Two-mic conversations streamed through a real server and model: each mic must get its own speaker's
// sentences, never the other's, and never the same sentence twice. Speakers are cut from the fixture; with
// --recordings two real recordings are used instead (they stay on this computer; never commit them).
//
//   node test/scenarios.js [--model canary-1b-v2] [--speed 2] [--long] [--only SCN-02]
//   node test/scenarios.js --recordings transcripts/a.wav,transcripts/b.wav
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sharedWords, wordErrorRate } from '../lib/wer.js';
import { SR, startServer, streamWav, speakers, loadWav, saveWav, silence, concat, twoMics, scratch, suite } from './helpers.js';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const model = option('--model', process.env.TEST_MODEL ?? 'parakeet-ro-110m');
const speed = option('--speed', model.startsWith('whisper') || model.startsWith('jackrabbit') ? '2' : '4');
const only = option('--only', null);
const recordings = option('--recordings', null);
const t = suite(`scenarios (${model}${recordings ? ', real recordings' : ''})`);

let { A, B } = speakers();
if (recordings) [A, B] = recordings.split(',').map((f) => loadWav(f).subarray(0, 60 * SR));
const lead = (x) => concat(silence(1.5), x); // people start a moment after Start
const len = (x) => x.length / SR;
const dir = scratch('scenarios');
const server = await startServer({ model });
const pid = server.pid;
const memory = () => Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString()) / 1024);

const modelMs = []; // model time per sentence, for the performance line at the end (TESTING.md PERF-01)

/** Stream two mic signals; returns sentences with mic numbers 1/2. */
async function two(name, m1, m2) {
  const f1 = path.join(dir, `${name}-mic1.wav`);
  const f2 = path.join(dir, `${name}-mic2.wav`);
  saveWav(f1, m1);
  saveWav(f2, m2);
  const r = await streamWav(server.port, [f1, '--mic2', f2, '--model', model, '--speed', speed]);
  if (r.timedOut || r.code !== 0) console.log(r.out.split('\n').slice(-12).join('\n'));
  modelMs.push(...r.finals.map((f) => f.ms));
  return r;
}

// One-mic references: what the model writes for each speaker alone.
const refs = {};
for (const [name, x] of Object.entries({ A, B })) {
  const f = path.join(dir, `ref-${name}.wav`);
  saveWav(f, lead(x));
  refs[name] = (await streamWav(server.port, [f, '--model', model, '--speed', speed])).finals.map((s) => s.text).join(' ');
}
console.log(`references: A ${refs.A.split(' ').length} words, B ${refs.B.split(' ').length} words\n`);

/** Whose words a sentence is; '?' when too short to tell (under three content words in common). */
function owner(text) {
  const a = sharedWords(text, refs.A).count;
  const b = sharedWords(text, refs.B).count;
  return Math.max(a, b) < 3 || a === b ? '?' : a > b ? 'A' : 'B';
}

/**
 * expect: { 1: 'A' | 'B' | null | 'any', 2: ... } — null: that mic must stay silent; 'any': either speaker.
 * maxWer: { 1: 0.25 } — the mic's text may differ from its speaker's one-mic reference at most this much.
 */
function judge(id, title, { finals, timedOut, seconds }, expect, { maxWer = {}, known = false, compare = true } = {}) {
  if (timedOut) return t.check(id, title, false, `timed out after ${seconds.toFixed(0)} s`, { known });
  const byMic = [1, 2].map((m) => finals.filter((f) => f.mic === m));
  const wrong = finals.filter((f) => expect[f.mic] !== 'any' && (expect[f.mic] === null || (owner(f.text) !== '?' && owner(f.text) !== expect[f.mic])));
  const both = byMic[0].filter((f) => byMic[1].some((g) => Math.min(f.end, g.end) - Math.max(f.start, g.start) > 0.5
    && sharedWords(f.text, g.text).count >= 2 && sharedWords(f.text, g.text).ratio > 0.5));
  const wer = {};
  for (const m of [1, 2]) if (compare && refs[expect[m]]) wer[m] = wordErrorRate(refs[expect[m]], byMic[m - 1].map((f) => f.text).join(' '));
  const tooDifferent = Object.entries(maxWer).filter(([m, max]) => wer[m] > max);
  const ok = !wrong.length && !both.length && !tooDifferent.length;
  const detail = `mic1 ${byMic[0].length}, mic2 ${byMic[1].length} sentences; wrong mic ${wrong.length}; on both ${both.length}`
    + `; vs reference ${Object.entries(wer).map(([m, w]) => `mic${m} ${(w * 100).toFixed(0)}%`).join(', ') || '—'}`;
  t.check(id, title, ok, detail, { known });
  if (!ok) {
    for (const f of wrong) console.log(`     wrong mic${f.mic} #${f.id} [${f.start}–${f.end}] ${f.text.slice(0, 80)}`);
    for (const f of both) console.log(`     on both mics [${f.start}–${f.end}] ${f.text.slice(0, 80)}`);
  }
  if (known && ok) console.log(`     ↑ a known limit now passes: move ${id} to the regular cases in TESTING.md`);
  return ok;
}

const scenarios = [
  ['SCN-01', 'turn-taking: A talks, then B answers (B on Bluetooth: 150 ms late, 6 dB louder)', () =>
    two('s1', ...twoMics(lead(concat(A, silence(1), silence(len(B)))), lead(concat(silence(len(A) + 1), B)), { bleedDb: 12, lagMs: 150, gain2Db: 6 })),
  { 1: 'A', 2: 'B' }, { maxWer: { 1: 0.25, 2: 0.25 } }],
  ['SCN-02', 'both talk at once (lapel mics: the other person 12 dB quieter; B on Bluetooth)', () =>
    two('s2', ...twoMics(lead(A), lead(B), { bleedDb: 12, lagMs: 150 })), { 1: 'A', 2: 'B' }],
  ['SCN-03', 'both talk at once, table mics (the other person only 6 dB quieter)', () =>
    two('s3', ...twoMics(lead(A), lead(B), { bleedDb: 6 })), { 1: 'A', 2: 'B' }],
  ['SCN-04', 'only A talks; mic 2 is a louder, noisier Bluetooth mic', () =>
    two('s4', ...twoMics(lead(A), silence(1.5 + len(A)), { bleedDb: 6, lagMs: 150, gain2Db: 12, noise2: -50 })), { 1: 'A', 2: null }, { maxWer: { 1: 0.25 } }],
  ['SCN-05', 'the same audio on both mics (the same mic picked twice): every sentence once', async () => {
    const [m] = twoMics(lead(A), silence(1.5 + len(A)), { bleedDb: 60 });
    return two('s5', m, m);
  }, { 1: 'any', 2: 'any' }],
  ['SCN-06', 'mic 2 is not connected (sends silence) while A talks', async () => {
    const [m] = twoMics(lead(A), silence(1.5 + len(A)), { bleedDb: 60 });
    return two('s6', m, new Float32Array(m.length));
  }, { 1: 'A', 2: null }, { maxWer: { 1: 0.25 } }],
  ['KNOWN-01', 'turn-taking where the close mic is much noisier than the other (-50 vs -70 dBFS)', () =>
    two('k1', ...twoMics(lead(concat(A, silence(1), silence(len(B)))), lead(concat(silence(len(A) + 1), B)), { bleedDb: 12, noise1: -50, noise2: -70 })),
  { 1: 'A', 2: 'B' }, { known: true }],
];

for (const [id, title, run, expect, opts = {}] of scenarios) {
  if (only && id !== only) continue;
  const r = await run();
  // The "same audio" case can't be told apart by speaker: check only that nothing appears twice.
  judge(id, title, r, expect, opts);
}

if (args.includes('--long') && (!only || only === 'SCN-07')) {
  // ~10 minutes: X (mic 1) and Y (mic 2, Bluetooth) take turns of 6-9 s, a quarter of them overlapping by 2 s.
  const turns = [];
  let x = [];
  let y = [];
  let tx = 0;
  for (let i = 0, at = 1.5; at < 600; i++) {
    const who = i % 2;
    const clip = who ? B : A;
    const start = Math.max(0, at - (i && i % 4 === 0 ? 2 : 0));
    (who ? y : x).push([start, clip]);
    turns.push(start);
    at = start + len(clip) + 1;
    tx = Math.max(tx, at);
  }
  const build = (parts) => {
    const out = new Float32Array(Math.round(tx * SR));
    for (const [start, clip] of parts) out.set(clip.subarray(0, out.length - Math.round(start * SR)), Math.round(start * SR));
    return out;
  };
  const before = memory();
  const r = await two('long', ...twoMics(build(x), build(y), { bleedDb: 12, lagMs: 150, gain2Db: 4 }));
  const after = memory();
  // The speakers repeat, so there is no one-mic reference to compare the whole text with.
  judge('SCN-07', `a ${Math.round(tx / 60)}-minute conversation, ${turns.length} turns (some overlapping)`, r, { 1: 'A', 2: 'B' }, { compare: false });
  t.check('SCN-08', 'server memory stays flat over the long conversation', after - before < 60, `${before} → ${after} MB`);
}

if (modelMs.length) {
  const ms = modelMs.sort((a, b) => a - b);
  const at = (p) => ms[Math.floor(p * (ms.length - 1))];
  console.log(`\nmodel time per sentence (${model}): median ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${ms.at(-1)} ms over ${ms.length} sentences`);
}
await server.stop();
fs.rmSync(dir, { recursive: true, force: true });
t.finish();
