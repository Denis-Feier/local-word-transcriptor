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
import { Session, fileStamp } from '../lib/session.js';
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
const keptFile = path.join(dir, 'kept.wav');
fs.writeFileSync(keptFile, encodeWav(tone));
let refused = 'opened it';
try {
  new WavWriter(keptFile).close();
} catch (err) {
  refused = err.code;
}
t.check('UNIT-WAV-03', 'a WAV writer never overwrites a file: it refuses one that exists and leaves it as it was',
  refused === 'EEXIST' && fs.readFileSync(keptFile).equals(encodeWav(tone)), `${refused}; the file has ${fs.statSync(keptFile).size} of ${encodeWav(tone).length} bytes`);

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

// ---------- recordings that start in the same second (#2; loudness detector: deterministic) ----------
// File names have whole seconds. Two tabs, or the desktop app and `npm start` (they share transcripts/), can start
// in the same second; so can a Clear, and the clock going back an hour when summer time ends.
/**
 * A recording with Save audio on in the transcripts folder `out`: mic 1 says one sentence, transcribed as `said`;
 * mic 2 hears only its noise. `sign` -1 inverts the audio, so two recordings never send the same samples.
 */
function recording(out, said, { sign = 1, mics = 2 } = {}) {
  const sent = [];
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy' } };
  const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null, transcribe: async () => ({ text: said, model: 'stub', ms: 1 }) };
  const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
  session.setOptions({ saveAudio: true });
  const audio = [concat(quiet(1.5), loud(1.5), quiet(1.5)), quiet(4.5)].slice(0, mics).map((a) => a.map((s) => sign * s));
  return {
    session,
    said,
    chunks: audio[0].length / 1600,
    /** Send 100 ms of every mic, as the page does. */
    send(c) {
      const frame = new Float32Array(mics * 1600);
      audio.forEach((a, mic) => frame.set(a.subarray(c * 1600, (c + 1) * 1600), mic * 1600));
      session.audio(frame, mics);
    },
    /** What `mic` sent in chunks from..to, as the WAV it must be. */
    wav: (mic, from = 0, to = Infinity) => encodeWav(audio[mic].subarray(from * 1600, to * 1600)),
    files: (kind) => sent.filter((m) => m.type === 'file' && m.kind === kind).map((m) => path.resolve(m.path)),
    errors: () => sent.filter((m) => m.type === 'error').map((m) => m.message),
    async stop() {
      session.flush();
      await sleep(50);
      session.close();
    },
  };
}
const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : Buffer.alloc(0));
const names = (files) => files.map((f) => path.basename(f)).join(', ');
/** What is wrong with a recording's files: errors, WAVs not holding `wavs` (in the order opened), a .txt not holding its one line. */
function wrongFiles(r, wavs) {
  const audio = r.files('audio');
  const text = r.files('text');
  const lines = text.flatMap((f) => read(f).toString().split('\n').filter(Boolean));
  return [
    ...r.errors(),
    ...(audio.length === wavs.length ? audio.filter((f, i) => !read(f).equals(wavs[i])).map((f) => `${path.basename(f)} does not hold its audio`) : [`${audio.length} WAVs, not ${wavs.length}`]),
    ...(text.length === 1 && lines.length === 1 && lines[0].includes(r.said) ? [] : [`${text.length} .txt with ${JSON.stringify(lines)}`]),
  ];
}
/** Wait, if needed, until a new second has started, so the steps that follow happen within one second. */
const sameSecond = async () => Date.now() % 1000 > 800 && sleep(1005 - (Date.now() % 1000));

// Two recordings start in the same second, then stream at once.
let out = scratch('same-second');
await sameSecond();
const first = recording(out, 'prima înregistrare aici');
const second = recording(out, 'a doua înregistrare acolo', { sign: -1 });
for (let c = 0; c < first.chunks; c++) [first, second].forEach((r) => r.send(c));
await Promise.all([first.stop(), second.stop()]);
const filesOf = (r) => [...r.files('text'), ...r.files('audio')];
const sharedFiles = filesOf(first).filter((f) => filesOf(second).includes(f));
let wrong = [first, second].flatMap((r) => wrongFiles(r, [r.wav(0), r.wav(1)]));
const base = (r) => path.basename(r.files('text')[0] ?? '', '.txt');
t.check('UNIT-SESS-08', 'two recordings started in the same second get their own .txt and WAVs (<stamp>, <stamp>-2), each with only its own lines and audio',
  !sharedFiles.length && !wrong.length && base(second) === `${base(first)}-2`,
  sharedFiles.length ? `both write to ${names(sharedFiles)}` : [`${names(filesOf(first))} | ${names(filesOf(second))}`, ...wrong].join('; '));
fs.rmSync(out, { recursive: true, force: true });

// Clear in the same second the recording started: the new transcript must not reopen the first one's files.
out = scratch('clear-same-second');
await sameSecond();
const cleared = recording(out, 'după ce am golit');
cleared.send(0);
cleared.session.reset(); // Clear
for (let c = 1; c < cleared.chunks; c++) cleared.send(c);
await cleared.stop();
wrong = wrongFiles(cleared, [cleared.wav(0, 0, 1), cleared.wav(1, 0, 1), cleared.wav(0, 1), cleared.wav(1, 1)]); // mic 1, mic 2 before Clear, then after
t.check('UNIT-SESS-09', 'Clear in the same second the recording started: new files, the first transcript\'s WAVs keep their audio',
  !wrong.length, [names(filesOf(cleared)), ...wrong].join('; '));
fs.rmSync(out, { recursive: true, force: true });

// Audio of an earlier recording with the same name and no .txt (Save audio on, nothing said; the clock put back an
// hour since, at the end of summer time): it must not be overwritten.
out = scratch('earlier');
await sameSecond();
const stamp = fileStamp(new Date());
const earlier = encodeWav(loud(1));
fs.writeFileSync(path.join(out, `${stamp}.wav`), earlier);
const later = recording(out, 'o înregistrare nouă', { mics: 1 });
for (let c = 0; c < later.chunks; c++) later.send(c);
await later.stop();
wrong = wrongFiles(later, [later.wav(0)]);
const untouched = read(path.join(out, `${stamp}.wav`)).equals(earlier) && !fs.existsSync(path.join(out, `${stamp}.txt`));
t.check('UNIT-SESS-10', 'an earlier recording\'s audio with the same name is left as it was; the new one gets <stamp>-2',
  untouched && !wrong.length && base(later) === `${stamp}-2`,
  [`${stamp}.wav ${untouched ? 'untouched' : 'changed, or given a .txt'}; new: ${names(filesOf(later))}`, ...wrong].join('; '));
fs.rmSync(out, { recursive: true, force: true });

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
