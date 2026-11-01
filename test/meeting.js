// The synthetic meeting for the stress tier (TESTING.md §14.2): a script of blocks (who talks, the room, events),
// voiced from the sentence bank, played 100 ms at a time the way the page sends it, with the ground truth of who
// said what and when, and the judge that compares a server's lines with that truth (§14.3).
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { decodeWav } from '../lib/wav.js';
import { sharedWords, wordErrorRate, words } from '../lib/wer.js';
import { ROOT, SR, FIXTURE, loadWav, room } from './helpers.js';

export const CHUNK = 1600; // 100 ms, as the page sends it
const STEP = CHUNK / SR;
const BANK = path.join(ROOT, 'test', 'fixtures', 'meeting-ro.txt');
const CACHE = path.join(os.tmpdir(), 'transcriber-meeting-voices');
const RATES = [180, 205, 160]; // words per minute: each person speaks at their own pace
const FIXTURE_SENTENCES = [
  [0, 6.8, 'Bună ziua, mă numesc Ioana și astăzi vreau să vă povestesc despre o călătorie în munții Carpați.'],
  [7.3, 13.0, 'A fost o experiență frumoasă, deși ploaia ne-a ținut în cabană două zile.'],
  [13.4, 15.9, 'Ce părere aveți, mergem și la anul?'],
];

/** The mics: a wired one, a Bluetooth one (late, louder) and a USB one. */
export const MICS = [
  { lag: 0, gainDb: 0, noiseDb: -58 },
  { lag: 0.15, gainDb: 4, noiseDb: -58 },
  { lag: 0.02, gainDb: -3, noiseDb: -55 },
];
// How loud each person is on each mic (dB). With two mics, the third person shares mic 1, farther than its owner.
const PLACES = { 1: [[0], [0], [0]], 2: [[0, -12], [-12, 0], [-6, -16]], 3: [[0, -12, -12], [-12, 0, -12], [-12, -12, 0]] };
const SPEAKER_DB = -18; // the speaker in the room, as each mic hears it
const SPEAKER_LAG = 0.02;
const GAP = 0.3; // the page reopens its capture when the mics change: no audio for this long

/** Blocks and their minutes. A block left out (or 0) is skipped; R2 repeats R exactly. */
export const SCRIPTS = {
  full: { R: 15, shared: 60, presentation: 20, debate: 20, break: 15, hvac: 40, flaky: 30, changes: 20, R2: 15 },
  short: { R: 4, shared: 5, presentation: 3, debate: 3, break: 2, hvac: 4, flaky: 4, changes: 5, R2: 4 },
  mic3: { R: 20, debate: 20, hvac: 40, flaky: 25, R2: 15 },
  soak: { R: 8, debate: 8, break: 4 },
};
const ORDER = ['R', 'shared', 'presentation', 'debate', 'break', 'hvac', 'flaky', 'changes', 'R2'];

/** The full script stretched to `hours`: blocks shared, hvac and flaky take the difference. */
export function hoursScript(hours) {
  const script = { ...SCRIPTS.full };
  const k = (hours * 60 - 105) / 130;
  for (const b of ['shared', 'hvac', 'flaky']) script[b] = Math.max(1, Math.round(script[b] * k));
  return script;
}

/** Words the judge counts (three letters or more, as sharedWords does). */
export const contentWords = (text) => (text ? words(text, { diacritics: false }).filter((w) => w.length > 2).length : 0);

function random(seed) {
  let s = (Math.abs(seed) % 2147483646) + 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const hash = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 2147483647, 7);

/** Cut the silence `say` leaves around a sentence (keep 30 ms). */
function trim(x) {
  const loud = (i) => Math.abs(x[i]) > 0.003;
  let a = 0;
  while (a < x.length && !loud(a)) a++;
  let b = x.length - 1;
  while (b > a && !loud(b)) b--;
  const pad = Math.round(0.03 * SR);
  return x.slice(Math.max(0, a - pad), Math.min(x.length, b + pad));
}

const clip = (text, samples) => ({ text, samples, roomed: room(samples), short: text !== null && contentWords(text) < 3 });

function hasIoana() {
  try {
    return process.platform === 'darwin' && /^Ioana\s/m.test(execFileSync('say', ['-v', '?']).toString());
  } catch {
    return false;
  }
}

async function say(text, rate) {
  const file = path.join(CACHE, `${createHash('sha1').update(`${rate}|${text}`).digest('hex').slice(0, 16)}.wav`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`; // parallel lanes share the cache: write, then rename
    await promisify(execFile)('say', ['-v', 'Ioana', '-r', String(rate), '-o', tmp, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
    fs.renameSync(tmp, file);
  }
  return trim(decodeWav(fs.readFileSync(file)).samples);
}

/** Pieces of 6–12 s of a real recording, cut at its quietest moment; their text comes from the model later. */
function pieces(file) {
  const x = loadWav(file).subarray(0, 10 * 60 * SR);
  const level = (at) => {
    let sum = 0;
    for (let i = at; i < at + 512 && i < x.length; i++) sum += x[i] * x[i];
    return sum;
  };
  const out = [];
  for (let start = 0; start + 6 * SR < x.length;) {
    let cut = Math.min(x.length, start + 12 * SR);
    for (let at = start + 6 * SR; at < Math.min(x.length - 512, start + 12 * SR); at += 512) if (level(at) < level(cut)) cut = at;
    const piece = x.slice(start, cut);
    if (Math.sqrt(piece.reduce((s, v) => s + v * v, 0) / piece.length) > 0.005) out.push(clip(null, piece));
    start = cut;
  }
  return out;
}

/**
 * Each person's voice: a list of clips { text, samples, roomed, short }. The sentence bank spoken by macOS
 * `say -v Ioana` at the person's pace (cached in the temp folder); without that voice, the fixture's three sentences;
 * with recordings, pieces of those (text null until the caller fills it in). keep(i) picks sentences from the bank.
 */
export async function voices({ people = 3, recordings = null, keep = () => true } = {}) {
  if (recordings) {
    const files = recordings.split(',');
    return { source: 'recordings', people: Array.from({ length: people }, (_, p) => pieces(files[p % files.length])) };
  }
  if (!hasIoana()) {
    const all = loadWav(FIXTURE);
    const clips = FIXTURE_SENTENCES.map(([a, b, text]) => clip(text, all.slice(Math.round(a * SR), Math.round(b * SR))));
    return { source: 'fixture (no Ioana voice)', people: Array.from({ length: people }, () => clips) };
  }
  fs.mkdirSync(CACHE, { recursive: true });
  const texts = fs.readFileSync(BANK, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).filter((_, i) => keep(i));
  const out = [];
  for (let p = 0; p < people; p++) {
    const clips = [];
    for (let i = 0; i < texts.length; i += 8) {
      const batch = texts.slice(i, i + 8);
      const audio = await Promise.all(batch.map((text) => say(text, RATES[p % RATES.length])));
      batch.forEach((text, j) => clips.push(clip(text, audio[j])));
    }
    out.push(clips);
  }
  return { source: `sentence bank (${texts.length} sentences, say -v Ioana)`, people: out };
}

// ---------- the script ----------

/** A short sound every mic hears: a door, a chair, typing. */
function transient(rng, kind) {
  const n = Math.round({ door: 0.25, chair: 0.5, keys: 3 }[kind] * SR);
  const x = new Float32Array(n);
  let y = 0;
  if (kind === 'keys') {
    for (let at = 0; at < n - 80; at += Math.round((0.1 + rng() * 0.1) * SR)) for (let i = 0; i < 64; i++) x[at + i] = (rng() * 2 - 1) * 0.05;
    return x;
  }
  for (let i = 0; i < n; i++) {
    const env = kind === 'door' ? 0.25 * Math.exp(-i / (0.04 * SR)) : 0.03 * Math.sin((Math.PI * i) / n);
    x[i] = y = y + (kind === 'door' ? 0.5 : 0.1) * ((rng() * 2 - 1) * env - y);
  }
  return x;
}

/**
 * The meeting for `voice` (from voices()): blocks of minutes in a fixed order (SCRIPTS), on 2 or 3 mics.
 * Times are meeting seconds. Returns the utterances (ground truth), events, blocks and what the room does when.
 */
export function meeting(voice, { minutes = SCRIPTS.full, mics = 2, seed = 1 } = {}) {
  const homeOf = (p) => (mics === 2 && p === 2 ? 0 : p);
  const utterances = [];
  const events = []; // { t, type: 'layout' | 'tuning' | 'clear', ... }
  const dropouts = []; // { mic, start, end }: digital silence
  const transients = []; // { start, samples, gains }
  const ramps = []; // { start, end }: the air conditioning (noise +12 dB)
  const speaker = []; // { start, end }: the speaker in the room plays the voices
  const blocks = [];
  const pick = (rng, list, avoid) => {
    const ok = list.filter((c) => !avoid.has(c.text));
    return ok[Math.floor(rng() * ok.length)] ?? list[0];
  };
  const longOf = (p) => voice.people[p].filter((c) => !c.short);
  const shortOf = (p) => voice.people[p].filter((c) => c.short);
  const speak = (p, c, start, block, kind, first) => {
    const u = { person: p, home: homeOf(p), start, end: start + c.samples.length / SR, text: c.text, clip: c, block, kind, first };
    utterances.push(u);
    return u;
  };
  // Said by anyone in the last minute (or still being said): people rarely repeat each other word for word.
  const busy = (t) => new Set(utterances.filter((u) => u.end > t - 60).map((u) => u.text));

  /** People taking turns: 1–4 sentences each, a share of the turns starting before the previous one ends. */
  const discussion = (rng, block, at, len, who, { overlap = 0.25, most = 3.5, replies = 0 } = {}) => {
    let prev = null;
    for (;;) {
      const others = who.filter((p) => p !== prev?.person);
      const person = others[Math.floor(rng() * others.length)];
      const start = prev && rng() < overlap
        ? prev.end - Math.max(0.3, Math.min(0.5 + rng() * most, prev.end - prev.start - 0.5))
        : (prev?.end ?? at) + 0.5 + rng() * 1.5;
      const n = 1 + Math.floor(rng() ** 1.6 * 4);
      if (start + 8 > at + len) break;
      let t = start;
      let last = null;
      for (let i = 0; i < n && t + 6 < at + len; i++) {
        last = speak(person, pick(rng, longOf(person), busy(t)), t, block, 'turn', i === 0);
        t = last.end + 0.25 + rng() * 0.2; // shorter than the pause that ends a sentence
      }
      if (!last) break;
      if (replies && rng() < replies && last.end - start > 3) {
        const listener = who.filter((p) => p !== person)[0];
        const c = shortOf(listener);
        if (c.length) speak(listener, c[Math.floor(rng() * c.length)], start + (last.end - start) / 2, block, 'reply', true);
      }
      prev = { person, start, end: last.end };
    }
  };

  let t = 1.5; // people start a moment after Start, when the gate learns each mic's noise
  for (const name of ORDER) {
    const len = (minutes[name] ?? 0) * 60;
    if (!len) continue;
    const rng = random(hash(name === 'R2' ? 'R' : name) + seed);
    const at = t;
    const two = [0, 1];
    const all = mics === 3 ? [0, 1, 2] : two;
    if (name === 'R' || name === 'R2' || name === 'hvac' || name === 'flaky' || name === 'changes') discussion(rng, name, at, len, all);
    if (name === 'shared') discussion(rng, name, at, len, [0, 1, 2]);
    if (name === 'debate') discussion(rng, name, at, len, all, { overlap: 0.5, most: 3.5, replies: 0.4 });
    if (name === 'presentation') {
      const questions = [0.25, 0.5, 0.75].map((f) => at + f * len);
      let first = true;
      for (let s = at; s + 15 < at + len;) {
        if (questions.length && s >= questions[0]) {
          questions.shift();
          const q = speak(1, pick(rng, longOf(1), busy(s)), s + 1, name, 'question', true);
          s = q.end + 1;
          first = true;
          continue;
        }
        const u = speak(0, pick(rng, longOf(0), busy(s)), s, name, 'talk', first);
        first = false;
        s = u.end + 0.2 + rng() * 0.3;
      }
    }
    if (name === 'break') {
      for (let s = at + 10 + rng() * 20; s + 5 < at + len; s += 15 + rng() * 25) {
        const kind = ['door', 'chair', 'keys'][Math.floor(rng() * 3)];
        transients.push({ start: s, samples: transient(rng, kind), gains: Array.from({ length: mics }, () => 10 ** (-(rng() * 8) / 20)), kind });
      }
    }
    if (name === 'hvac') ramps.push({ start: at + 0.1 * len, end: at + 0.85 * len });
    if (name === 'flaky') {
      const scale = Math.min(1, len / 1800);
      [5, 20, 90, 10, 45, 30].forEach((d, i) => {
        const dur = Math.max(3, d * scale);
        const mid = at + ((i + 0.5) / 6) * len;
        dropouts.push({ mic: 1, start: mid - dur / 2, end: mid + dur / 2 });
      });
    }
    if (name === 'changes') {
      const ev = (f, e) => events.push({ t: Math.round((at + f * len) / STEP) * STEP, ...e });
      ev(0.1, { type: 'layout', count: mics - 1 });
      ev(0.2, { type: 'layout', count: mics });
      ev(0.3, { type: 'tuning', values: { silenceMs: 1000 } });
      ev(0.35, { type: 'tuning', values: { vadThreshold: 0.35, crosstalkDb: 12 } });
      ev(0.4, { type: 'tuning', reset: true });
      ev(0.55, { type: 'clear' });
      ev(0.65, { type: 'layout', count: mics - 1 });
      ev(0.75, { type: 'layout', count: mics });
      speaker.push({ start: at + 0.45 * len, end: at + 0.95 * len });
    }
    blocks.push({ name, start: at, end: at + len });
    t = at + len;
  }
  utterances.sort((a, b) => a.start - b.start);
  events.sort((a, b) => a.t - b.t);
  return finishMeeting({ mics, length: t + 2, utterances, events, dropouts, transients, ramps, speaker, blocks, voice: voice.source });
}

/** A meeting from given utterances ({ person, start, clip }): for short checks that need exact control. */
export function meetingFrom(utterances, { mics = 2, length } = {}) {
  const list = utterances.map((u) => ({ home: mics === 2 && u.person === 2 ? 0 : u.person, end: u.start + u.clip.samples.length / SR, text: u.clip.text, block: 'R', kind: 'turn', first: true, ...u }));
  const end = Math.max(...list.map((u) => u.end));
  return finishMeeting({ mics, length: length ?? end + 2, utterances: list, events: [], dropouts: [], transients: [], ramps: [], speaker: [], blocks: [{ name: 'R', start: 0, end: end + 2 }], voice: 'given' });
}

function finishMeeting(m) {
  const layouts = m.events.filter((e) => e.type === 'layout');
  m.gaps = layouts.map((e) => [e.t, e.t + GAP]);
  m.chunks = Math.ceil(m.length / STEP);
  /** How many mics the page sends at meeting time t. */
  m.countAt = (t) => layouts.reduce((n, e) => (e.t <= t ? e.count : n), m.mics);
  m.inGap = (t) => m.gaps.some(([a, b]) => t >= a - 1e-9 && t < b - 1e-9);
  m.dropped = (mic, t) => m.dropouts.some((d) => d.mic === mic && t >= d.start && t < d.end);
  /** Session time (the server's clock: the audio it received) at meeting time t. */
  m.toSession = (t) => t - m.gaps.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(t, b) - a), 0);
  m.noiseAt = (t) => {
    for (const r of m.ramps) {
      if (t < r.start || t >= r.end + 60) continue;
      return 12 * Math.min(1, (t - r.start) / 60, (r.end + 60 - t) / 60);
    }
    return 0;
  };
  m.speakerOn = (t) => m.speaker.some((s) => t >= s.start && t < s.end);
  // A person whose own mic is missing or silent can be heard on another mic; those utterances may go anywhere.
  const missing = (u) => {
    for (let t = u.start; t <= u.end + 0.2; t += 0.1) if (m.countAt(t) <= u.home || m.inGap(t) || m.dropped(u.home, t)) return true;
    return false;
  };
  for (const u of m.utterances) {
    u.orphan = missing(u);
    u.solo = !m.utterances.some((o) => o !== u && o.person !== u.person && Math.min(o.end, u.end) - Math.max(o.start, u.start) > 0.3);
  }
  return m;
}

/** The ground truth as the server sees it: per utterance, its time on each mic in session seconds. */
export function truth(m) {
  return m.utterances.map((u) => ({
    ...u,
    at: MICS.slice(0, m.mics).map(({ lag }) => [m.toSession(u.start) + lag, m.toSession(u.end) + lag]),
  }));
}

/** Session times of the blocks, for judge(). */
export const sessionBlocks = (m) => m.blocks.map((b) => ({ name: b.name, start: m.toSession(b.start), end: m.toSession(b.end) }));

// ---------- playing it ----------

/**
 * Plays a meeting 100 ms at a time, as the page sends it: frame(i) for i = 0, 1, 2… in order returns the ArrayBuffer
 * (Uint32 mic count, then each mic's samples) or null while the page reopens its capture.
 */
export class Room {
  constructor(m, { seed = 7 } = {}) {
    this.m = m;
    this.next = 0;
    this.active = [];
    this.nextTransient = 0;
    this.activeTransients = [];
    const rngs = MICS.map((_, i) => random(seed * 101 + i));
    this.noise = rngs.map((rng) => () => rng() * 2 - 1);
    this.tail = Math.round((0.1 + Math.max(...MICS.map((x) => x.lag)) + SPEAKER_LAG) * SR);
  }

  frame(i) {
    const { m } = this;
    const t = i * STEP;
    if (m.inGap(t)) return null;
    const count = m.countAt(t);
    const a = i * CHUNK;
    while (this.next < m.utterances.length && Math.round(m.utterances[this.next].start * SR) < a + CHUNK) this.active.push(m.utterances[this.next++]);
    this.active = this.active.filter((u) => Math.round(u.start * SR) + u.clip.roomed.length + this.tail > a);
    while (this.nextTransient < m.transients.length && Math.round(m.transients[this.nextTransient].start * SR) < a + CHUNK) this.activeTransients.push(m.transients[this.nextTransient++]);
    this.activeTransients = this.activeTransients.filter((x) => Math.round(x.start * SR) + x.samples.length + this.tail > a);
    const buffer = new ArrayBuffer(4 + count * CHUNK * 4);
    new Uint32Array(buffer, 0, 1)[0] = count;
    const out = new Float32Array(buffer, 4);
    const places = PLACES[m.mics];
    const speakerGain = m.speakerOn(t) ? 10 ** (SPEAKER_DB / 20) : 0;
    const speakerLag = Math.round(SPEAKER_LAG * SR);
    for (let mic = 0; mic < count; mic++) {
      const o = out.subarray(mic * CHUNK, (mic + 1) * CHUNK);
      const { lag, gainDb, noiseDb } = MICS[mic];
      const amp = 10 ** ((noiseDb + m.noiseAt(t)) / 20) * Math.sqrt(3);
      const noise = this.noise[mic];
      for (let k = 0; k < CHUNK; k++) o[k] = noise() * amp;
      if (m.dropped(mic, t)) {
        o.fill(0);
        continue;
      }
      const shift = a - Math.round(lag * SR);
      for (const u of this.active) {
        const g = 10 ** (places[u.person][mic] / 20);
        const src = g >= 0.5 ? u.clip.samples : u.clip.roomed; // near: the voice itself; farther: through the room
        const s0 = Math.round(u.start * SR);
        for (let k = 0; k < CHUNK; k++) {
          const idx = shift + k - s0;
          if (idx >= 0 && idx < src.length) o[k] += g * src[idx];
          if (speakerGain && idx - speakerLag >= 0 && idx - speakerLag < u.clip.roomed.length) o[k] += speakerGain * u.clip.roomed[idx - speakerLag];
        }
      }
      for (const x of this.activeTransients) {
        const s0 = Math.round(x.start * SR);
        for (let k = 0; k < CHUNK; k++) {
          const idx = shift + k - s0;
          if (idx >= 0 && idx < x.samples.length) o[k] += x.gains[mic] * x.samples[idx];
        }
      }
      const gain = 10 ** (gainDb / 20);
      if (gain !== 1) for (let k = 0; k < CHUNK; k++) o[k] *= gain;
    }
    return buffer;
  }

  /** The whole meeting as one Float32Array per mic (for WAV files: the fake mics, replays). */
  static render(m, opts) {
    const r = new Room(m, opts);
    const out = Array.from({ length: m.mics }, () => new Float32Array(m.chunks * CHUNK));
    for (let i = 0; i < m.chunks; i++) {
      const buffer = r.frame(i);
      if (!buffer) continue;
      const count = new Uint32Array(buffer, 0, 1)[0];
      const samples = new Float32Array(buffer, 4);
      for (let mic = 0; mic < count; mic++) out[mic].set(samples.subarray(mic * CHUNK, (mic + 1) * CHUNK), i * CHUNK);
    }
    return out;
  }
}

// ---------- judging ----------

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : NaN);
export const quantile = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))] : NaN);

/**
 * Compare a server's final lines ({ mic (0-based), start, end, text, ms?, sentSec? }) with the truth (truth()):
 * each line is ok, phantom (nobody spoke) or wrong (another person's speech); pairs of lines are "both" when two mics
 * kept the same words; each utterance is caught or not (§14.3). groups: [{ name, start, end }] in session seconds
 * (blocks, windows); each gets its own numbers. partials: [{ sentSec }].
 */
export function judge(items, lines, { groups = [], partials = [] } = {}) {
  const byStart = [...items].sort((a, b) => a.at[0][0] - b.at[0][0]);
  const starts = byStart.map((u) => Math.min(...u.at.map(([s]) => s)));
  const near = (from, to) => {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < from - 30) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < starts.length && starts[i] < to + 1; i++) out.push(byStart[i]);
    return out;
  };
  const judged = lines.map((line) => {
    const cands = near(line.start, line.end).filter((u) => u.at[line.mic]);
    const mine = (u) => u.home === line.mic || u.orphan;
    let own = 0;
    let other = 0;
    let bestOwn = 0;
    let bestOther = 0;
    for (const u of cands) {
      const [s, e] = u.at[line.mic];
      const o = overlap(line.start, line.end, s, e);
      if (mine(u)) own += o;
      else other += o;
      if (o <= 0 && !(s < line.end + 1 && e > line.start - 1)) continue;
      const { count } = sharedWords(line.text, u.text ?? '');
      if (mine(u)) bestOwn = Math.max(bestOwn, count);
      else bestOther = Math.max(bestOther, count);
    }
    const kind = own + other < 0.2 ? 'phantom' : own < 0.2 || (bestOther >= 3 && bestOther > bestOwn) ? 'wrong' : 'ok';
    return { ...line, kind };
  });
  const both = [];
  const sorted = [...judged].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].start < sorted[i].end; j++) {
      const [a, b] = [sorted[i], sorted[j]];
      if (a.mic === b.mic || overlap(a.start, a.end, b.start, b.end) < 0.5) continue;
      const { count, ratio } = sharedWords(a.text, b.text);
      if (count >= 2 && ratio > 0.5) both.push([a, b]);
    }
  }
  const linesOn = (mic) => sorted.filter((l) => l.mic === mic);
  const perMic = items[0]?.at.map((_, mic) => linesOn(mic)) ?? [];
  const utterances = items.map((u) => {
    const judgedHere = u.text && !u.short && !u.orphan && contentWords(u.text) >= 3;
    if (!judgedHere) return { ...u, judged: false };
    const [s, e] = u.at[u.home];
    const text = perMic[u.home].filter((l) => overlap(l.start, l.end, s - 0.3, e + 0.3) > 0).map((l) => l.text).join(' ');
    const caught = sharedWords(u.text, text).count >= Math.ceil(contentWords(u.text) / 2);
    let offset = null;
    if (caught && u.solo && u.first) {
      const line = perMic[u.home].filter((l) => overlap(l.start, l.end, s, e) > 0).sort((a, b) => overlap(b.start, b.end, s, e) - overlap(a.start, a.end, s, e))[0];
      if (line && line.start - s > -1 && line.start - s < 0.5) offset = line.start - s;
    }
    return { ...u, judged: true, caught, offset };
  });
  const stats = (from, to, { wer: withWer = true } = {}) => {
    const mid = ([s, e]) => (s + e) / 2; // by the middle, so a sentence on a boundary counts in one part only
    const ls = judged.filter((l) => mid([l.start, l.end]) >= from && mid([l.start, l.end]) < to);
    const us = utterances.filter((u) => mid(u.at[u.home]) >= from && mid(u.at[u.home]) < to);
    const rate = (list) => ({ n: list.length, caught: list.filter((u) => u.caught).length });
    const delays = ls.filter((l) => l.sentSec !== undefined).map((l) => l.sentSec - l.end);
    const wer = !withWer ? [] : perMic.map((_, mic) => {
      const ref = us.filter((u) => u.home === mic && !u.orphan && u.text).sort((a, b) => a.at[mic][0] - b.at[mic][0]).map((u) => u.text).join(' ');
      const hyp = ls.filter((l) => l.mic === mic).sort((a, b) => a.start - b.start).map((l) => l.text).join(' ');
      return ref ? wordErrorRate(ref, hyp, { diacritics: false }) : null;
    });
    return {
      lines: ls.length,
      wrong: ls.filter((l) => l.kind === 'wrong').length,
      phantom: ls.filter((l) => l.kind === 'phantom').length,
      both: both.filter(([a]) => a.start >= from && a.start < to).length,
      solo: rate(us.filter((u) => u.judged && u.solo)),
      overlapped: rate(us.filter((u) => u.judged && !u.solo)),
      wer,
      offset: median(us.map((u) => u.offset).filter((x) => x !== null && x !== undefined)),
      delayP50: quantile(delays, 0.5),
      delayP95: quantile(delays, 0.95),
      modelMs: median(ls.map((l) => l.ms).filter(Number.isFinite)),
      partials: partials.filter((p) => p.sentSec >= from && p.sentSec < to).length,
    };
  };
  const all = stats(-Infinity, Infinity, { wer: false });
  return { lines: judged, both, utterances, all, groups: groups.map((g) => ({ ...g, ...stats(g.start, g.end) })) };
}

/** 10-minute windows (or `sec`) over a session of `length` seconds. */
export const windows = (length, sec = 600) => Array.from({ length: Math.ceil(length / sec) }, (_, i) => ({ name: `${fmt(i * sec)}–${fmt(Math.min(length, (i + 1) * sec))}`, start: i * sec, end: (i + 1) * sec }));

export function fmt(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)} %` : '—');
const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

/** A Markdown table of the groups (blocks or windows); extra: (group) => { column: value }. */
export function table(groups, extra = () => ({})) {
  const rows = groups.map((g) => ({
    Part: g.name,
    Lines: g.lines,
    'Wrong mic': g.wrong,
    'Both mics': g.both,
    Phantom: g.phantom,
    'Solo caught': g.solo.n ? `${g.solo.caught}/${g.solo.n}` : '—',
    'Overlap caught': g.overlapped.n ? `${g.overlapped.caught}/${g.overlapped.n}` : '—',
    WER: g.wer.map((w, mic) => `m${mic + 1} ${pct(w)}`).join(', '),
    'Clock (s)': num(g.offset),
    'Delay p50/p95 (s)': `${num(g.delayP50)} / ${num(g.delayP95)}`,
    'Model ms': num(g.modelMs, 0),
    'Live guesses': g.partials,
    ...extra(g),
  }));
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  return [`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${cols.map((c) => r[c]).join(' | ')} |`)].join('\n');
}

/**
 * For a looped meeting (the soak): the meeting time at session time 0 on each mic, from the lines whose words match
 * an utterance (the most common difference, refined by its median). period: the loop's length in seconds.
 */
export function loopOffset(m, lines, mic, period) {
  const ds = [];
  for (const line of lines.filter((l) => l.mic === mic && contentWords(l.text) >= 4)) {
    for (const u of m.utterances) {
      const { count, ratio } = sharedWords(line.text, u.text ?? '');
      if (count < 3 || ratio < 0.6) continue;
      const d = (((u.start + MICS[mic].lag - (line.start + 0.3)) % period) + period) % period;
      ds.push(d);
    }
  }
  if (!ds.length) return null;
  const bins = new Map();
  for (const d of ds) bins.set(Math.round(d * 4), (bins.get(Math.round(d * 4)) ?? 0) + 1);
  const mode = [...bins.entries()].sort((a, b) => b[1] - a[1])[0][0] / 4;
  return median(ds.filter((d) => Math.abs(d - mode) < 0.5));
}

/** The truth of a looped meeting in session seconds, given each mic's loopOffset(), up to `length` seconds. */
export function loopTruth(m, offsets, length, period) {
  const out = [];
  for (let k = 0; k * period < length + period; k++) {
    for (const u of m.utterances) {
      const at = offsets.map((off, mic) => [u.start + MICS[mic].lag + k * period - off, u.end + MICS[mic].lag + k * period - off]);
      if (at.every(([s]) => s < -1 || s > length)) continue;
      out.push({ ...u, at, loop: k });
    }
  }
  return out;
}
