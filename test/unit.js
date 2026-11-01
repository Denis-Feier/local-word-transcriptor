// Logic checks that need no speech model (seconds). The crosstalk, session and detector-reuse checks use the Silero
// voice detector (models/silero_vad.onnx) and are skipped without it. Case ids match TESTING.md.
//
//   node test/unit.js
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { normalize, resultToText, contextTail } from '../lib/text.js';
import { wordErrorRate, sharedWords } from '../lib/wer.js';
import { TUNING, sanitizeTuning, applyTuning, tuningFrom } from '../lib/tuning.js';
import { encodeWav, decodeWav, WavWriter } from '../lib/wav.js';
import { Segmenter } from '../lib/segmenter.js';
import { EnergyDetector, SileroDetector, VadPool, createDetector } from '../lib/vad.js';
import { CrosstalkGate } from '../lib/crosstalk.js';
import { Session, fileStamp } from '../lib/session.js';
import { Transcriber } from '../lib/transcriber.js';
import { config, ROOT } from '../lib/config.js';
import { MODELS } from '../lib/models.js';
import { SR, scratch, speakers, silence, concat, twoMics, sleep, suite, fakeElevenLabs } from './helpers.js';

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

// ---------- model list ----------
// python/nemo_server.py refuses a decoder it does not know, but only once someone picks the model.
const nemoDecoders = fs.readFileSync(path.join(ROOT, 'python', 'nemo_server.py'), 'utf8').match(/"--decoder", choices=\[([^\]]*)\]/)[1].match(/[\w-]+/g);
const nemoModels = MODELS.filter((m) => m.engine === 'python-nemo');
const badNemo = nemoModels.filter(({ nemo, files }) => !nemoDecoders.includes(nemo.decoder)
  || (nemo.decoder === 'ctc-lm') !== Boolean(nemo.lm)
  || ![nemo.model, nemo.lm].filter(Boolean).every((f) => files.some((x) => x.file === f)));
t.check('UNIT-MODEL-01', 'every NeMo model uses a decoder nemo_server.py accepts and downloads the files it loads', nemoModels.length > 0 && !badNemo.length,
  `decoders ${nemoDecoders.join('/')}; ${nemoModels.map((m) => `${m.id}: ${m.nemo.decoder}`).join(', ')}${badNemo.length ? `; wrong: ${badNemo.map((m) => m.id).join(', ')}` : ''}`);

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
  const sizes = new Map(); // fd -> bytes in the file (the WAV writer creates a new, empty file)
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
let again = 'started';
try {
  new WavWriter(path.join(dir, 'none.wav')).close(); // room again, Save audio ticked again: a new WavWriter never overwrites
} catch (err) {
  again = err.code;
}
t.check('UNIT-WAV-04', 'a WAV started on a full disk: ENOSPC; the file is neither left open nor left behind, so it starts once there is room',
  refused?.code === 'ENOSPC' && leftOpen === 0 && again === 'started', `${refused?.code ?? 'no error'}; ${leftOpen} file(s) left open; once there is room: ${again}`);
const keptFile = path.join(dir, 'kept.wav');
fs.writeFileSync(keptFile, encodeWav(tone));
let overwrote = 'opened it';
try {
  new WavWriter(keptFile).close();
} catch (err) {
  overwrote = err.code;
}
t.check('UNIT-WAV-05', 'a WAV writer never overwrites a file: it refuses one that exists and leaves it as it was',
  overwrote === 'EEXIST' && fs.readFileSync(keptFile).equals(encodeWav(tone)), `${overwrote}; the file has ${fs.statSync(keptFile).size} of ${encodeWav(tone).length} bytes`);

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
t.check('UNIT-SESS-09', 'two recordings started in the same second get their own .txt and WAVs (<stamp>, <stamp>-2), each with only its own lines and audio',
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
t.check('UNIT-SESS-10', 'Clear in the same second the recording started: new files, the first transcript\'s WAVs keep their audio',
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
t.check('UNIT-SESS-11', 'an earlier recording\'s audio with the same name is left as it was; the new one gets <stamp>-2',
  untouched && !wrong.length && base(later) === `${stamp}-2`,
  [`${stamp}.wav ${untouched ? 'untouched' : 'changed, or given a .txt'}; new: ${names(filesOf(later))}`, ...wrong].join('; '));
fs.rmSync(out, { recursive: true, force: true });

// ---------- the ElevenLabs cloud model, against a stand-in (never the real service, TESTING.md §2) ----------
// Seeded noise makes every 512-sample frame different, so the stand-in's audio can be found in what was streamed.
let seed = 11;
const noisy = (x) => x.map((v) => v + 0.0003 * (((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1));
const pcm16 = (x) => Int16Array.from(x, (v) => Math.round(Math.max(-1, Math.min(1, v)) * 32767));
/** Where a connection's audio is in the input: [from, to) in samples, or null when it is not one piece of it. */
function piece(input, audio) {
  for (let at = 0; audio.length && at + audio.length <= input.length; at += 512) {
    if (audio.every((v, i) => v === input[at + i])) return [at, at + audio.length];
  }
  return null;
}
/**
 * One mic on the ElevenLabs model through the real Transcriber and Session (loudness detector), streamed in 100 ms
 * chunks; after each chunk the stand-in answers what was committed. close: end with session.close() and drain().
 */
async function cloud(audio, fakeOptions = {}, { close = false } = {}) {
  const fake = await fakeElevenLabs(fakeOptions);
  const keep = { ...config.elevenlabs };
  Object.assign(config.elevenlabs, { apiKey: 'test-key', baseUrl: fake.url }); // models.js looks for the key here
  const out = scratch('cloud');
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy' } };
  const transcriber = new Transcriber(conf);
  await transcriber.select('elevenlabs-scribe-v2');
  const sent = [];
  const session = new Session({ send: (m) => sent.push(m), transcriber, config: conf });
  for (let i = 0; i < audio.length; i += 1600) {
    session.audio(audio.subarray(i, i + 1600));
    await sleep(1);
    for (let n = 0; transcriber.pending && n < 1000; n++) await sleep(1);
  }
  if (close) session.close();
  else session.flush();
  await transcriber.drain(5000);
  await sleep(50);
  const text = fs.readdirSync(out).filter((f) => f.endsWith('.txt')).map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('');
  session.close();
  await transcriber.shutdown();
  await fake.close();
  Object.assign(config.elevenlabs, keep);
  fs.rmSync(out, { recursive: true, force: true });
  const input = pcm16(audio);
  const sentences = fake.connections.filter((c) => c.audio.length);
  return {
    state: transcriber.state,
    fake,
    text,
    probe: fake.connections[0],
    sentences,
    pieces: sentences.map((c) => piece(input, c.audio)),
    finals: sent.filter((m) => m.type === 'final' && m.text),
    partials: sent.filter((m) => m.type === 'partial'),
    errors: sent.filter((m) => m.type === 'error').map((m) => m.message),
  };
}
const secs = (n) => `${(n / SR).toFixed(2)} s`;
const span = (p) => (p ? `${secs(p[0])}–${secs(p[1])}` : 'not a piece of the input');
const apart = (pieces) => pieces.every((p, i) => p && (i === 0 || p[0] >= pieces[i - 1][1]));

let c = await cloud(noisy(concat(quiet(1), loud(2.5), quiet(1.5), loud(2), quiet(1.5))));
const q = c.probe?.query ?? {};
t.check('UNIT-CLOUD-01', 'choosing the model starts one ElevenLabs session to check the key, with the realtime settings, and sends it no audio',
  c.state === 'ready' && c.probe.key === 'test-key' && q.model_id === 'scribe_v2_realtime' && q.audio_format === 'pcm_16000' && q.commit_strategy === 'manual' && q.language_code === 'ro'
    && c.probe.audio.length === 0 && c.probe.closed,
  `${c.state}; ${JSON.stringify(q)}; ${c.probe?.audio.length} samples`);
const keyFake = await fakeElevenLabs();
const keep = config.elevenlabs.apiKey;
config.elevenlabs.apiKey = 'wrong-key';
const wrongKey = new Transcriber({ ...structuredClone(config), elevenlabs: { apiKey: 'wrong-key', baseUrl: keyFake.url } });
const logError = console.error;
console.error = () => {}; // the transcriber logs the error with ✖, which reads like a failed test in the run's output
await wrongKey.select('elevenlabs-scribe-v2');
console.error = logError;
config.elevenlabs.apiKey = keep;
await keyFake.close();
t.check('UNIT-CLOUD-01', 'a wrong key: the model is in error, saying ElevenLabs refused the key and where it goes',
  wrongKey.state === 'error' && /Invalid API key/.test(wrongKey.message) && /\.env\.local/.test(wrongKey.message), wrongKey.message);

// Speech at 1–3.5 s and 5–7 s: each connection gets its lead-in, the speech and ≤ 0.2 s after it, not the pause.
const sentence = (p, from, to) => p && p[0] <= from * SR && p[1] >= to * SR && p[1] <= (to + 0.25) * SR;
t.check('UNIT-CLOUD-02', 'two sentences: one connection each, committed once, each sent its own audio only (not the pause after it), no frame twice',
  c.sentences.length === 2 && c.sentences.every((x) => x.commits === 1) && apart(c.pieces) && sentence(c.pieces[0], 1, 3.5) && sentence(c.pieces[1], 5, 7),
  `${c.fake.connections.length} connections; sent ${c.pieces.map(span).join(', ')} of ${secs(8.5 * SR)}`);
t.check('UNIT-CLOUD-02', 'the finals are ElevenLabs\' committed texts, the live text its partial texts, and the second sentence gets the first as context',
  c.finals.map((f) => f.text).join(' | ') === 'propoziția 1 | propoziția 2' && c.finals.every((f) => f.model === 'elevenlabs-scribe-v2')
    && c.partials.length > 0 && c.partials.every((p) => p.text === `ascult ${c.finals.findIndex((f) => f.id === p.id) + 1}`)
    && c.sentences[0].previousText.every((x) => x === null) && c.sentences[1].previousText[0] === 'propoziția 1' && c.sentences[1].previousText.slice(1).every((x) => x === null),
  `finals ${c.finals.map((f) => f.text).join(' | ')}; ${c.partials.length} live texts (${[...new Set(c.partials.map((p) => p.text))].join(', ')}); context ${JSON.stringify(c.sentences.map((x) => x.previousText[0]))}`);

c = await cloud(noisy(concat(quiet(1), loud(25), quiet(1.5), loud(0.1), quiet(1.5))));
const click = c.sentences.filter((x) => !x.commits);
t.check('UNIT-CLOUD-03', 'speech split at the longest sentence: two connections whose audio meets exactly, nothing sent twice or left out',
  c.sentences.filter((x) => x.commits).length === 2 && apart(c.pieces.slice(0, 2)) && c.pieces[0]?.[1] === c.pieces[1]?.[0] && c.finals.length === 2,
  `sent ${c.pieces.slice(0, 2).map(span).join(', ')}; ${c.finals.length} finals`);
t.check('UNIT-CLOUD-03', 'a click: its connection is closed without a commit, and it gives no line',
  click.length <= 1 && click.every((x) => x.closed) && c.fake.connections.every((x) => x.closed) && c.finals.length === 2,
  `${click.length} uncommitted connection(s), ${click.map((x) => secs(x.audio.length)).join(', ')} sent`);

c = await cloud(noisy(concat(quiet(1), loud(2), quiet(1.5))), { fail: (x) => (x.index === 1 ? 'transcriber_error' : null) });
t.check('UNIT-CLOUD-04', 'the commit fails once: the sentence is sent again, whole, on a new connection, and still transcribed, with no error shown',
  c.sentences.length === 2 && c.sentences[0].commits === 1 && !c.sentences[0].committed && c.sentences[1].committed && c.pieces[1]?.[0] <= c.pieces[0]?.[0]
    && c.finals.map((f) => f.text).join() === 'propoziția 2' && !c.errors.length,
  `sent ${c.pieces.map(span).join(', then ')}; finals ${c.finals.map((f) => f.text).join(' | ')}; errors ${c.errors.join(' | ') || 'none'}`);

c = await cloud(noisy(concat(quiet(1), loud(2), quiet(1.5), loud(2), quiet(1.5))), { fail: (x) => (x.index === 1 || x.index === 2 ? 'quota_exceeded' : null) });
t.check('UNIT-CLOUD-05', 'the commit and its retry fail: one error with ElevenLabs\' reason, and the next sentence is transcribed',
  c.errors.length === 1 && /stand-in quota_exceeded\. The ElevenLabs account has no credits left/.test(c.errors[0]) && c.finals.map((f) => f.text).join() === 'propoziția 3',
  `errors ${c.errors.join(' | ')}; finals ${c.finals.map((f) => f.text).join(' | ')}`);

c = await cloud(noisy(concat(quiet(1), loud(2), quiet(1.5), loud(1.5))), {}, { close: true });
t.check('UNIT-CLOUD-06', 'closed mid-sentence (Ctrl+C, the window closed): the sentence is committed and saved before drain() returns',
  c.sentences.length === 2 && c.sentences.every((x) => x.committed) && c.text.split('\n').filter(Boolean).length === 2 && /propoziția 2/.test(c.text),
  JSON.stringify(c.text));

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

// ---------- voice detectors are reused, not rebuilt (#4) ----------
// A Silero detector holds ~3 MB of native memory that V8 does not see, so a dropped one stayed until V8 happened to
// collect it. Detectors now go back to a pool (lib/vad.js) when a connection closes, the mics change or the threshold
// changes. Without the fix every connection made 3 and every threshold change 2, and they stayed in memory.

// The pool's rules, with stand-ins for sherpa-onnx's detectors.
let collections = 0;
const pool = new VadPool({ create: (model, threshold) => ({ threshold, resets: 0, reset() { this.resets++; } }), collect: () => collections++ });
const [p1, p2] = [pool.acquire('m', 0.5), pool.acquire('m', 0.5)];
pool.release(p1, 'm', 0.5);
pool.release(p2, 'm', 0.5);
const reused = pool.acquire('m', 0.5) === p2 && pool.acquire('m', 0.5) === p1 && pool.created === 2 && p1.resets === 1;
[p1, p2].forEach((p) => pool.release(p, 'm', 0.5));
const p3 = pool.acquire('m', 0.3); // the threshold changed: the 0.5 spares will not be wanted again
const switched = p3.threshold === 0.3 && pool.idle.length === 0 && pool.dropped === 2 && collections === 1;
const six = Array.from({ length: 6 }, () => pool.acquire('m', 0.3));
six.forEach((p) => pool.release(p, 'm', 0.3));
const capped = pool.idle.length === 4 && pool.dropped === 4 && pool.idle.every((d, i) => d.vad === six[i + 2]);
t.check('UNIT-VAD-01', 'detector pool: a detector given back is reset and handed out again; spares with another threshold, or beyond 4, are dropped and collected',
  reused && switched && capped, `reused ${reused}, threshold change ${switched}, at most 4 spares ${capped}; ${pool.created} made, ${pool.dropped} dropped, ${collections} collections`);

/** Counts the Silero detectors sherpa-onnx makes while it is in place, and how many of them are still in memory. */
const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
function vadCounter() {
  const Real = sherpa.Vad;
  let freed = 0;
  const registry = new FinalizationRegistry(() => freed++);
  const counter = { made: 0, registry, alive: () => counter.made - freed, restore: () => (sherpa.Vad = Real) };
  sherpa.Vad = class extends Real {
    constructor(...args) {
      super(...args);
      counter.made++;
      registry.register(this);
    }
  };
  return counter;
}
const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null, transcribe: async () => ({ text: 'o propoziție', model: 'stub', ms: 1 }) };
/** Two mics' audio from `from` to `to` seconds, in the page's 1600-sample chunks; mics: 1 sends mic 1 only. */
function stream(session, [m1, m2], from, to, mics = 2) {
  for (let i = Math.round(from * SR); i + 1600 <= Math.round(to * SR); i += 1600) {
    const frame = new Float32Array(mics * 1600);
    frame.set(m1.subarray(i, i + 1600));
    if (mics === 2) frame.set(m2.subarray(i, i + 1600), 1600);
    session.audio(frame, mics);
  }
}
const turns = () => new Promise((resolve) => setTimeout(resolve, 20)); // a few turns of the event loop: collections run

const VAD_IDS = ['UNIT-VAD-02', 'UNIT-VAD-03', 'UNIT-VAD-04', 'UNIT-VAD-05'];
if (!silero) {
  for (const id of VAD_IDS) t.skip(id, 'Silero detectors reused', `no ${config.vad.sileroModel} (npm run setup)`);
} else {
  const talk = twoMics(concat(silence(0.3), A), concat(silence(0.6), B), { bleedDb: 12 });
  const model = config.vad.sileroModel;

  // A detector given back mid-sentence and handed out again decides exactly as a new one.
  const own = new VadPool({ collect: () => {} });
  const decide = (d, x) => Array.from({ length: Math.floor(x.length / 512) }, (_, i) => (d.isSpeech(x.subarray(i * 512, (i + 1) * 512)) ? 1 : 0)).join('');
  const fresh = new SileroDetector({ model, threshold: 0.5, pool: own });
  const first = decide(fresh, lead(A));
  decide(fresh, B.subarray(0, 2 * SR)); // stops in the middle of B's sentence
  const midSentence = fresh.vad.isDetected();
  const handle = fresh.vad;
  fresh.release();
  const again = new SileroDetector({ model, threshold: 0.5, pool: own });
  const second = decide(again, lead(A));
  const other = new SileroDetector({ model, threshold: 0.3, pool: own });
  const spoken = first.split('').filter((c) => c === '1').length;
  t.check('UNIT-VAD-02', 'a Silero detector given back mid-sentence comes back as good as new: the same detector, the same decision on every frame',
    midSentence && again.vad === handle && second === first && spoken > 50 && other.vad !== handle && own.created === 2,
    `${midSentence ? 'given back mid-sentence' : 'given back in silence'}, ${again.vad === handle ? 'the same detector came back' : 'another detector came back'}; ${spoken} of ${first.length} frames speech, ${[...first].filter((c, i) => c !== second[i]).length} decided differently; another threshold got ${other.vad === handle ? 'the same one' : 'its own'}`);

  // 20 connections, each closed mid-sentence, then the mics changed 1 ↔ 2 twenty times in one session.
  const conf = { ...structuredClone(config), transcriptsDir: scratch('pool') };
  let count = vadCounter();
  const heard = new Set(); // what each connection's detectors decided, as the page sees it
  for (let k = 0; k < 20; k++) {
    const sent = [];
    const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
    stream(session, talk, 0, 1);
    session.close();
    heard.add(JSON.stringify(sent.filter((m) => m.type === 'vad')));
  }
  const byConnections = count.made;
  const session = new Session({ send: () => {}, transcriber: stub, config: conf });
  for (let k = 0; k < 21; k++) stream(session, talk, 0.2 * k, 0.2 * (k + 1), k % 2 ? 1 : 2);
  session.close();
  count.restore();
  t.check('UNIT-VAD-03', 'connections and mic changes reuse the Silero detectors: 20 connections with two mics and 20 mic changes make at most 2',
    count.made <= 2 && heard.size === 1, `${byConnections} made by 20 connections, ${count.made - byConnections} by 20 mic changes (without the fix 60 and 33); ${heard.size === 1 ? 'every connection heard the same' : `${heard.size} different results`}`);

  // 20 threshold changes (random slider values) while two mics talk, a message at a time as from the page.
  count = vadCounter();
  const tuned = new Session({ send: () => {}, transcriber: stub, config: conf });
  stream(tuned, talk, 0, 0.4);
  await turns();
  const rss0 = process.memoryUsage().rss;
  let seed = 11;
  const values = Array.from({ length: 20 }, () => Number((0.1 + 0.05 * ((seed = (seed * 16807) % 2147483647) % 17)).toFixed(2)));
  for (const [k, vadThreshold] of values.entries()) {
    applyTuning(conf, { vadThreshold });
    tuned.retune();
    stream(tuned, talk, 0.4 + 0.1 * k, 0.5 + 0.1 * k);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await turns();
  const last = values.at(-1);
  const applied = tuned.mics.every(({ segmenter: { detector } }) => detector.threshold === last && detector.vad.config.sileroVad.threshold === last);
  const alive = count.alive();
  const grown = Math.round((process.memoryUsage().rss - rss0) / 1048576);
  tuned.close();
  count.restore();
  t.check('UNIT-VAD-04', 'threshold changes free the detectors they replace: after 20 changes with two mics at most 4 are in memory, the last threshold applied',
    alive <= 4 && applied, `${count.made} made, ${alive} still in memory (without the fix all of them); last threshold ${last} ${applied ? 'applied on both mics' : 'not applied'}; process memory ${grown >= 0 ? '+' : ''}${grown} MB`);

  // A closed session gives its detectors back and takes no more audio (the page keeps sending while Ctrl+C waits for
  // the last sentence); before, saving that audio reopened the WAVs and wiped the recording.
  const out = scratch('closed');
  const closing = new Session({ send: () => {}, transcriber: stub, config: { ...conf, transcriptsDir: out } });
  closing.setOptions({ saveAudio: true });
  stream(closing, talk, 0, 2);
  closing.close();
  const given = closing.mics.every(({ segmenter }) => segmenter.detector.vad === null);
  const wavs = () => fs.readdirSync(out).filter((f) => f.endsWith('.wav')).sort().map((f) => (fs.statSync(path.join(out, f)).size - 44) / (2 * SR));
  const before = wavs();
  let thrown = null;
  try {
    stream(closing, talk, 2, 3);
  } catch (err) {
    thrown = err;
  }
  const after = wavs();
  await turns(); // the last sentence is still being saved
  fs.rmSync(out, { recursive: true, force: true });
  fs.rmSync(conf.transcriptsDir, { recursive: true, force: true });
  t.check('UNIT-VAD-05', 'a closed session gives its detectors back and ignores audio sent after: the WAVs keep the recording',
    given && !thrown && before.length === 2 && before.every((s) => s === 2) && after.join() === before.join(),
    `detectors ${given ? 'given back' : 'kept'}; ${thrown ? `audio after close threw ${thrown.message}; ` : ''}WAVs ${before.map((s) => `${s} s`).join(', ')} at close, ${after.map((s) => `${s} s`).join(', ')} after 1 s more audio`);
}

fs.rmSync(dir, { recursive: true, force: true });
t.finish();
