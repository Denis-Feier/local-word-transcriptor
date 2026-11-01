// Logic checks that need no speech model (seconds). The crosstalk and session checks use the Silero voice
// detector (models/silero_vad.onnx) and are skipped without it. Case ids match TESTING.md.
//
//   node test/unit.js
import fs from 'node:fs';
import path from 'node:path';
import { normalize, resultToText, contextTail } from '../lib/text.js';
import { wordErrorRate, sharedWords } from '../lib/wer.js';
import { TUNING, sanitizeTuning, applyTuning, tuningFrom } from '../lib/tuning.js';
import { encodeWav, decodeWav, WavWriter } from '../lib/wav.js';
import { Segmenter } from '../lib/segmenter.js';
import { EnergyDetector, createDetector } from '../lib/vad.js';
import { CrosstalkGate } from '../lib/crosstalk.js';
import { Session } from '../lib/session.js';
import { config } from '../lib/config.js';
import { SR, scratch, speakers, silence, concat, twoMics, sleep, suite } from './helpers.js';

const t = suite('unit');

// ---------- text cleanup ----------
t.check('UNIT-TEXT-01', 'cedilla ş/ţ become comma-below ș/ț', normalize('Şi ţara şi ŢARA') === 'Și țara și ȚARA');
t.check('UNIT-TEXT-02', 'sound tags and music notes are removed', normalize('[Muzică] bună *râde* ziua ♪♪') === 'bună ziua', normalize('[Muzică] bună *râde* ziua ♪♪'));
t.check('UNIT-TEXT-03', 'missing space after a sentence is added; S.U.A. kept', normalize('ziua!Mă duc în S.U.A. mâine') === 'ziua! Mă duc în S.U.A. mâine');
t.check('UNIT-TEXT-04', 'a hallucinated sentence is dropped, real speech kept',
  resultToText({ text: 'Am stat două zile. Mulțumim pentru vizionare!' }) === 'Am stat două zile.');
const words10 = 'unu doi trei patru cinci șase șapte opt nouă zece';
const tail = contextTail(Array(10).fill(words10).join(' '), 50);
t.check('UNIT-TEXT-05', 'context for the next sentence is cut on a word boundary', tail.length <= 50 && tail.endsWith('zece') && words10.split(' ').includes(tail.split(' ')[0]), JSON.stringify(tail));

// ---------- word comparison ----------
t.check('UNIT-WER-01', 'word error rate', Math.abs(wordErrorRate('ana are mere', 'ana are pere') - 1 / 3) < 1e-9);
t.check('UNIT-WER-02', 'diacritic-blind word error rate', wordErrorRate('fată în casă', 'fata in casa', { diacritics: false }) === 0);
const shared = sharedWords('și de la munții carpați frumoși', 'am fost în munții carpați ieri');
t.check('UNIT-WER-03', 'shared words ignore one/two-letter words and keep order', shared.count === 2 && shared.ratio === 2 / 3, JSON.stringify(shared));
t.check('UNIT-WER-04', 'no shared words between unrelated sentences', sharedWords('vremea este frumoasă', 'cabana avea ferestre').count === 0);

// ---------- live settings ----------
const clean = sanitizeTuning({ vadThreshold: 0.93, silenceMs: 333, crosstalkDb: 99, unknown: 5, minSpeechMs: 'x' });
t.check('UNIT-TUNE-01', 'settings are clamped to range, snapped to step, unknown/invalid dropped',
  clean.vadThreshold === TUNING.vadThreshold.max && clean.silenceMs === 300 && clean.crosstalkDb === TUNING.crosstalkDb.max && !('unknown' in clean) && !('minSpeechMs' in clean), JSON.stringify(clean));
const cfg = structuredClone(config);
applyTuning(cfg, { vadThreshold: 0.35, silenceMs: 1200, minSpeechMs: 300, maxSegmentSec: 12, partialEverySec: 1, crosstalkDb: 5 });
const back = tuningFrom(cfg);
t.check('UNIT-TUNE-02', 'every setting round-trips through the config', back.vadThreshold === 0.35 && back.silenceMs === 1200 && back.minSpeechMs === 300 && back.maxSegmentSec === 12 && back.partialEverySec === 1 && back.crosstalkDb === 5, JSON.stringify(back));
t.check('UNIT-TUNE-03', 'every setting has a range for the Settings sliders', Object.keys(tuningFrom(config)).every((k) => TUNING[k]));

// ---------- WAV files ----------
const tone = Float32Array.from({ length: SR }, (_, i) => 0.5 * Math.sin(i / 10));
const round = decodeWav(encodeWav(tone));
t.check('UNIT-WAV-01', '16-bit WAV round trip', round.sampleRate === SR && round.samples.length === SR && round.samples.every((s, i) => Math.abs(s - tone[i]) < 1e-4));
const dir = scratch('unit');
const wavFile = path.join(dir, 'growing.wav');
const writer = new WavWriter(wavFile);
writer.append(tone.subarray(0, 8000));
const half = decodeWav(fs.readFileSync(wavFile)).samples.length;
writer.append(tone.subarray(8000));
writer.close();
t.check('UNIT-WAV-02', 'a WAV being written is playable after every chunk', half === 8000 && decodeWav(fs.readFileSync(wavFile)).samples.length === SR);

/**
 * Pretends the disk has `free` bytes left for the WAV files opened while it is in place, as a real disk behaves: a write
 * that does not fit is cut short without an error, and the next one fails with ENOSPC; rewriting bytes a file already
 * has needs no room. open() counts those files still open; restore() puts the real fs back.
 */
function smallDisk(free) {
  const real = { openSync: fs.openSync, writeSync: fs.writeSync, closeSync: fs.closeSync };
  const sizes = new Map(); // fd -> bytes in the file (the WAV writer opens with 'w': empty)
  fs.openSync = (file, ...rest) => {
    const fd = real.openSync(file, ...rest);
    if (String(file).endsWith('.wav')) sizes.set(fd, 0);
    return fd;
  };
  fs.writeSync = (fd, buf, offset, length, position) => {
    if (!sizes.has(fd)) return real.writeSync(fd, buf, offset, length, position);
    const size = sizes.get(fd);
    const fits = Math.min(length, size + free - position);
    if (fits <= 0) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
    const n = real.writeSync(fd, buf, offset, fits, position);
    const grown = Math.max(0, position + n - size);
    free -= grown;
    sizes.set(fd, size + grown);
    return n;
  };
  fs.closeSync = (fd) => {
    sizes.delete(fd);
    real.closeSync(fd);
  };
  return { open: () => sizes.size, restore: () => Object.assign(fs, real) };
}

// The disk fills up (#1): room for the header and 12,345½ samples, so chunk 8 is cut short and then fails.
let disk = smallDisk(44 + 2 * 12345 + 1);
const fullWav = path.join(dir, 'full.wav');
const filling = new WavWriter(fullWav);
let full = null;
let chunk = 0;
try {
  for (; chunk < 10; chunk++) filling.append(tone.subarray(0, 1600));
} catch (err) {
  full = err;
}
disk.restore();
const kept = fs.readFileSync(fullWav).readUInt32LE(40) / 2;
filling.append(tone.subarray(0, 1600)); // room again (Save audio ticked again): the file carries on
filling.close();
const grown = fs.readFileSync(fullWav);
t.check('UNIT-WAV-03', 'a disk that fills up: the chunk that does not fit throws ENOSPC; the WAV keeps every whole sample written, header included, and carries on once there is room',
  full?.code === 'ENOSPC' && chunk === 7 && kept === 12345 && grown.readUInt32LE(40) === 2 * (12345 + 1600) && grown.length === 44 + 2 * (12345 + 1600) && decodeWav(grown).samples.length === 12345 + 1600,
  `${full?.code ?? 'no error'} on chunk ${chunk + 1}; the header kept ${kept} of the 12,345 samples that fit; then ${grown.readUInt32LE(40) / 2} samples in the header, ${(grown.length - 44) / 2} in the file`);
disk = smallDisk(0);
let refused = null;
try {
  new WavWriter(path.join(dir, 'none.wav')).close();
} catch (err) {
  refused = err;
}
const leftOpen = disk.open();
disk.restore();
t.check('UNIT-WAV-04', 'a WAV started on a full disk: ENOSPC, and the file is not left open', refused?.code === 'ENOSPC' && leftOpen === 0, `${refused?.code ?? 'no error'}; ${leftOpen} file(s) left open`);

// ---------- segmenter (loudness detector: deterministic) ----------
const timing = { silenceMs: 700, preRollMs: 300, minSpeechMs: 250, maxSegmentSec: 20 };
const quiet = (sec) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => 0.0004 * Math.sin(i * 1.7));
// Speech-like: 250 ms syllables with 100 ms gaps, so the loudness detector doesn't take it for steady noise.
const loud = (sec) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => ((i % 5600) < 4000 ? 0.1 : 0.0004) * Math.sin(i / 6));
function segment(audio, extra = {}) {
  const events = [];
  const seg = new Segmenter({
    ...timing,
    ...extra,
    detector: new EnergyDetector({ minRms: 0.006, noiseRatio: 3 }),
    onSpeechStart: (id) => events.push({ type: 'start', id }),
    onSegment: (s) => events.push({ type: 'segment', ...s }),
    onDiscard: (id) => events.push({ type: 'discard', id }),
  });
  for (let i = 0; i < audio.length; i += 1600) seg.push(audio.subarray(i, i + 1600));
  return { seg, events, segments: events.filter((e) => e.type === 'segment') };
}
let r = segment(concat(quiet(1), loud(1.5), quiet(1.5)));
const s0 = r.segments[0];
t.check('UNIT-SEG-01', 'speech becomes one segment with ~0.3 s lead-in and a short tail',
  r.segments.length === 1 && Math.abs(s0.start - 0.75) < 0.15 && Math.abs(s0.end - 2.7) < 0.15, r.segments.map((s) => `${s.start.toFixed(2)}–${s.end.toFixed(2)}`).join(' '));
r = segment(concat(quiet(1), loud(0.1), quiet(1.5)));
t.check('UNIT-SEG-02', 'a click shorter than the minimum speech is discarded', r.segments.length === 0 && r.events.some((e) => e.type === 'discard'));
r = segment(concat(quiet(1), loud(25), quiet(1.5)));
t.check('UNIT-SEG-03', 'speech longer than the longest sentence is split', r.segments.length === 2 && r.segments[0].end - r.segments[0].start <= 20.1, r.segments.map((s) => `${(s.end - s.start).toFixed(1)} s`).join(', '));
r = segment(concat(quiet(1), loud(2)));
r.seg.flush();
t.check('UNIT-SEG-04', 'Stop (flush) ends the sentence being spoken', r.events.filter((e) => e.type === 'segment').length === 1);
let next = 100;
r = segment(concat(quiet(1), loud(1.5), quiet(1.5)), { startFrame: 500, newId: () => next++ });
t.check('UNIT-SEG-05', 'a segmenter added mid-session uses the session clock and shared ids',
  r.segments[0]?.id === 100 && r.segments[0].start > 500 * 0.032, `id ${r.segments[0]?.id}, start ${r.segments[0]?.start.toFixed(2)} s`);

// ---------- changing the mics mid-session (loudness detector: deterministic) ----------
// The page sends 1600-sample chunks, so a segmenter usually holds part of a frame when the mics change
// (every 23 chunks: 448 samples, 28 ms). Mic 1 speaks at 32 s, mic 2 at 36 s; before that the session goes
// 1 ↔ 2 mics `changes` times, ending on two (none: two mics from the start).
async function layouts(changes) {
  const PHASE = 23;
  const sent = [];
  const out = scratch('layout');
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy' } };
  const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null, transcribe: async () => ({ text: 'o propoziție', model: 'stub', ms: 1 }) };
  const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
  const mics = [concat(quiet(32), loud(1.5), quiet(5.5)), concat(quiet(36), loud(1.5), quiet(1.5))];
  let drift = 0; // largest gap, in samples, between the audio sent and a mic's frame clock
  for (let c = 0; c * 1600 < mics[0].length; c++) {
    const count = c >= PHASE * changes || Math.floor(c / PHASE) % 2 ? 2 : 1;
    const frame = new Float32Array(count * 1600);
    for (let mic = 0; mic < count; mic++) frame.set(mics[mic].subarray(c * 1600, (c + 1) * 1600), mic * 1600);
    session.audio(frame, count);
    for (const { segmenter } of session.mics) drift = Math.max(drift, Math.abs((c + 1) * 1600 - (segmenter.frameIndex * 512 + segmenter.leftover.length)));
  }
  session.flush();
  await sleep(50);
  session.close();
  fs.rmSync(out, { recursive: true, force: true });
  const finals = sent.filter((m) => m.type === 'final' && m.text);
  return { drift, starts: [0, 1].map((mic) => finals.find((f) => f.mic === mic)?.start) };
}
const steady = await layouts(0);
const moved = await layouts(11);
t.check('UNIT-SESS-06', 'changing the mics (1 ↔ 2, 11 times) keeps every mic\'s clock on the audio sent',
  steady.drift === 0 && moved.drift === 0, `${moved.drift} samples (${((moved.drift / SR) * 1000).toFixed(0)} ms) behind`);
t.check('UNIT-SESS-07', 'after 11 mic changes each mic\'s sentence starts when it does without them',
  moved.starts.every((s, mic) => Math.abs(s - steady.starts[mic]) < 0.016),
  moved.starts.map((s, mic) => `mic ${mic + 1}: ${s?.toFixed(3)} s (${steady.starts[mic]?.toFixed(3)} s without)`).join(', '));

// ---------- the disk fills up while saving audio (#1; loudness detector, stand-in model) ----------
// Two mics: a sentence on mic 1 every 4 s for 24 s, room noise on mic 2. The WAVs have room for 8 s of both mics and
// 1,000 bytes, so mic 1's write at 8.0 s is cut short and then fails.
async function diskFills() {
  const sent = [];
  const out = scratch('full');
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy' } };
  const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null, transcribe: async () => ({ text: 'o propoziție', model: 'stub', ms: 1 }) };
  const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
  session.setOptions({ saveAudio: true });
  const talk = concat(...Array.from({ length: 6 }, () => concat(quiet(1), loud(1.5), quiet(1.5))));
  const noise = quiet(0.1);
  const small = smallDisk(2 * 44 + 8 * 2 * 2 * SR + 1000);
  let thrown = null;
  try {
    for (let i = 0; i < talk.length; i += 1600) {
      const frame = new Float32Array(3200);
      frame.set(talk.subarray(i, i + 1600));
      frame.set(noise, 1600);
      session.audio(frame, 2);
    }
  } catch (err) {
    thrown = err;
  }
  small.restore();
  session.flush();
  await sleep(50);
  session.close();
  const wavs = fs.readdirSync(out).filter((f) => f.endsWith('.wav')).sort().map((f) => fs.readFileSync(path.join(out, f)));
  fs.rmSync(out, { recursive: true, force: true });
  const whole = (b) => b.length - 44 - ((b.length - 44) % 2);
  return {
    thrown,
    errors: sent.filter((m) => m.type === 'error').map((m) => m.message),
    finals: sent.filter((m) => m.type === 'final' && m.text),
    secs: wavs.map((b) => b.readUInt32LE(40) / (2 * SR)),
    playable: wavs.length === 2 && wavs.every((b) => b.readUInt32LE(40) === whole(b)),
  };
}
const filled = await diskFills();
const after = filled.finals.filter((f) => f.start > Math.max(...filled.secs)).length;
t.check('UNIT-SESS-08', 'the disk fills up while saving two mics: audio() never throws, one "Could not save audio", sentences keep coming, both WAVs playable up to there',
  !filled.thrown && filled.errors.length === 1 && filled.errors[0].startsWith('Could not save audio: ENOSPC') && filled.finals.length === 6 && after === 4
    && filled.playable && filled.secs.every((s) => Math.abs(s - 8) < 0.1),
  `${filled.thrown ? `audio() threw ${filled.thrown.code}; ` : ''}errors: ${filled.errors.join(' | ') || 'none'}; ${filled.finals.length} sentences, ${after} after the disk filled; WAVs ${filled.secs.map((s) => `${s.toFixed(2)} s`).join(', ')}${filled.playable ? '' : ', a header and its file differ'}`);

// ---------- crosstalk gate and two-mic session (need Silero) ----------
const silero = fs.existsSync(config.vad.sileroModel);
const { A, B } = speakers();
const lead = (x) => concat(silence(1.5), x); // people start talking a moment after Start; the gate learns the noise then
// A mic needs this many speech frames to make a sentence; fewer stray frames (a word's echo dying away) are harmless.
const SENTENCE_FRAMES = Math.round(config.vad.minSpeechMs / 32);

/** Run two mic signals through per-mic analysis + the gate; count speech frames kept per mic. */
function gate(m1, m2, marginDb = config.crosstalkDb) {
  const segs = [0, 1].map(() => new Segmenter({ ...config.vad, detector: createDetector(config.vad) }));
  const g = new CrosstalkGate(2, marginDb);
  const kept = [0, 0];
  const speech = [0, 0];
  const n = Math.min(m1.length, m2.length);
  for (let i = 0; i + 1600 <= n; i += 1600) {
    const f = [segs[0].analyze(m1.subarray(i, i + 1600)), segs[1].analyze(m2.subarray(i, i + 1600))];
    for (let k = 0; k < f[0].length; k++) {
      f.forEach((frames, mic) => (speech[mic] += frames[k].loud));
      g.push([f[0][k], f[1][k]])?.forEach((frame, mic) => (kept[mic] += frame.loud));
    }
  }
  return { kept, speech, g };
}

if (!silero) {
  for (const id of ['UNIT-GATE-01', 'UNIT-GATE-02', 'UNIT-GATE-03', 'UNIT-GATE-04', 'UNIT-GATE-05', 'UNIT-SESS-01', 'UNIT-SESS-02', 'UNIT-SESS-03', 'UNIT-SESS-04', 'UNIT-SESS-05']) {
    t.skip(id, 'crosstalk / two-mic session', `no ${config.vad.sileroModel} (npm run setup)`);
  }
} else {
  const quietMic = silence(1.5 + A.length / SR);
  let g = gate(...twoMics(lead(A), quietMic, { bleedDb: 12, lagMs: 150 }));
  t.check('UNIT-GATE-01', 'only A talks: mic 2 (bleed, Bluetooth lag) keeps too little to make a sentence', g.kept[1] < SENTENCE_FRAMES && g.kept[0] > 0.5 * g.speech[0], `kept ${g.kept} of ${g.speech}`);
  g = gate(...twoMics(lead(A), quietMic, { bleedDb: 6, lagMs: 150, gain2Db: 12, noise2: -50 }));
  t.check('UNIT-GATE-02', 'only A talks: a louder, noisier mic 2 keeps too little to make a sentence', g.kept[1] < SENTENCE_FRAMES, `kept ${g.kept} of ${g.speech}`);
  // Known limit: before the first moment of silence the gate can only compare raw volume, so a louder mic wins.
  g = gate(...twoMics(A, silence(A.length / SR), { bleedDb: 6, lagMs: 150, gain2Db: 12, noise2: -50 }));
  t.check('UNIT-GATE-05', 'speech from the very first moment, louder mic 2: mic 2 keeps too little to make a sentence', g.kept[1] < SENTENCE_FRAMES, `kept ${g.kept} of ${g.speech}`, { known: true });
  g = gate(...twoMics(lead(A), lead(B), { bleedDb: 12, lagMs: 150 }));
  t.check('UNIT-GATE-03', 'both talk at once: both mics keep their own speech', g.kept.every((k, mic) => k > 0.3 * g.speech[mic]), `kept ${g.kept} of ${g.speech}`);
  // A mic that sends digital silence (not connected) must not teach the gate a fake noise level.
  const [m1] = twoMics(concat(silence(2), A), silence(2 + A.length / SR));
  g = gate(m1, new Float32Array(m1.length));
  t.check('UNIT-GATE-04', 'a silent (unconnected) mic does not get a noise level', !g.g.floors[1].learned && g.g.floors[0].learned, g.g.report());

  // Session with a stand-in model: same words on both mics -> one copy; different words -> both.
  const run = async (m1, m2, text, { margin = 30, saveAudio = false } = {}) => {
    const sent = [];
    const out = scratch('session');
    const conf = { ...structuredClone(config), transcriptsDir: out, crosstalkDb: margin };
    let calls = 0;
    const stub = { supportsPrompt: false, avgMs: 10, busy: false, tryTranscribe: () => null,
      transcribe: async () => ({ text: text(++calls), model: 'stub', ms: 1 }) };
    const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
    session.setOptions({ saveAudio });
    const n = Math.min(m1.length, m2?.length ?? Infinity);
    for (let i = 0; i < n; i += 1600) {
      const len = Math.min(1600, n - i);
      if (!m2) {
        session.audio(m1.subarray(i, i + len));
        continue;
      }
      const frame = new Float32Array(2 * len);
      frame.set(m1.subarray(i, i + len));
      frame.set(m2.subarray(i, i + len), len);
      session.audio(frame, 2);
    }
    session.flush(); // Stop: finish what is being said, then the connection closes
    await sleep(200);
    session.close();
    const files = fs.existsSync(out) ? fs.readdirSync(out) : [];
    const txt = files.find((f) => f.endsWith('.txt'));
    return { finals: sent.filter((m) => m.type === 'final' && m.text), sent, files, text: txt ? fs.readFileSync(path.join(out, txt), 'utf8') : '' };
  };
  // Bleed loud enough to pass the gate (margin 30 dB), and the model "hears" the same words on both mics.
  const bleed = twoMics(lead(A), quietMic, { bleedDb: 6 });
  let s = await run(...bleed, () => 'munții carpați frumoși astăzi');
  t.check('UNIT-SESS-01', 'same words on both mics at once: only the clearer mic keeps them',
    s.finals.length >= 1 && s.finals.every((f) => f.mic === 0), s.finals.map((f) => `mic${f.mic + 1}`).join(' '));
  s = await run(...twoMics(lead(A), lead(B), { bleedDb: 12 }), (n) => `cuvântul${'abcdefghij'[n % 10]} altceva${'abcdefghij'[n % 10]} mereu${'abcdefghij'[n % 10]}`);
  const mics = new Set(s.finals.map((f) => f.mic));
  t.check('UNIT-SESS-02', 'different words at the same time: both mics keep their sentences', mics.has(0) && mics.has(1), s.finals.map((f) => `mic${f.mic + 1}`).join(' '));
  const ids = s.sent.filter((m) => m.type === 'vad' && m.speaking).map((m) => m.id);
  t.check('UNIT-SESS-03', 'sentence ids are shared by the mics and unique', new Set(ids).size === ids.length && ids.every((id, i) => i === 0 || id > ids[i - 1]), ids.join(','));
  const [same] = twoMics(lead(A), quietMic, { bleedDb: 60 });
  s = await run(same, same, () => 'munții carpați frumoși astăzi');
  t.check('UNIT-SESS-04', 'identical audio on two mics (same mic picked twice): one copy, on mic 1',
    s.finals.length >= 1 && s.finals.every((f) => f.mic === 0), s.finals.map((f) => `mic${f.mic + 1}`).join(' '));
  s = await run(...twoMics(lead(A), lead(B), { bleedDb: 12 }), (n) => `fraza${n} numărul${n} unu`, { saveAudio: true });
  const one = await run(A, null, () => 'o propoziție simplă aici', { saveAudio: true });
  t.check('UNIT-SESS-05', 'files: one WAV per mic and "Mic N:" lines with two mics; plain with one',
    s.files.filter((f) => /-mic[12]\.wav$/.test(f)).length === 2 && /^\[\d\d:\d\d\] Mic [12]: /m.test(s.text)
      && one.files.some((f) => /\d\.wav$/.test(f)) && /^\[\d\d:\d\d\] o propoziție/m.test(one.text),
    `${s.files.join(', ')} | ${one.files.join(', ')}`);
}

fs.rmSync(dir, { recursive: true, force: true });
t.finish();
