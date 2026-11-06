// Logic checks that need no speech model (seconds). The crosstalk, session and detector-reuse checks use the Silero
// voice detector (models/silero_vad.onnx) and are skipped without it. Case ids match TESTING.md.
//
//   node test/unit.js
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { normalize, resultToText, contextTail } from '../lib/text.js';
import { wordErrorRate, sharedWords } from '../lib/wer.js';
import { TUNING, sanitizeTuning, applyTuning, tuningFrom } from '../lib/tuning.js';
import { encodeWav, decodeWav, WavWriter } from '../lib/wav.js';
import { Segmenter } from '../lib/segmenter.js';
import { EnergyDetector, SileroDetector, VadPool, createDetector } from '../lib/vad.js';
import { CrosstalkGate } from '../lib/crosstalk.js';
import { Session, fileStamp, fmtTime } from '../lib/session.js';
import { SteadyText } from '../lib/steady.js';
import { Transcriber } from '../lib/transcriber.js';
import { TranscribeCppEngine, describeDevice } from '../lib/engines/transcribe-cpp.js';
import { SidecarEngine } from '../lib/engines/sidecar.js';
import { WhisperCppEngine } from '../lib/engines/whisper-cpp.js';
import { PythonNemoEngine } from '../lib/engines/python-nemo.js';
import { config, ROOT } from '../lib/config.js';
import { MODELS, findModel } from '../lib/models.js';
import { liveSteadiness, sumSteadiness } from '../lib/benchmark/metrics.js';
import { withNoise, withGain, inRoom, silence as benchSilence, joinClips, rms, db } from '../lib/benchmark/audio.js';
import { machineInfo, describeMachine } from '../lib/benchmark/machine.js';
import { loadClips, selectClips, clipSamples } from '../lib/benchmark/dataset.js';
import { runModel, planStages, STAGES, CONDITIONS, SILENCE_INPUTS } from '../lib/benchmark/suite.js';
import { renderReport } from '../lib/benchmark/report.js';
import { parseArgs } from '../scripts/benchmark-suite.js';
import { createBacklog, lostNote } from '../public/backlog.js';
import { spokenOrder } from '../public/order.js';
import { SR, FIXTURE, scratch, speakers, silence, concat, twoMics, sleep, suite, fakeElevenLabs, loadWav, saveWav } from './helpers.js';
import { memoryCheck } from './meeting.js';

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
// The ranking (#28): every model has a tier for the menu's two groups and a one-line reason; the recommended ones are
// the measured best (benchmarks/runs/2026-11-02_20-09_mac-m5), and the catalogue is in ranking order.
{
  const tiers = MODELS.map((m) => m.tier);
  const recommended = MODELS.filter((m) => m.tier === 'recommended').map((m) => m.id);
  const longReason = MODELS.filter((m) => !m.reason || m.reason.length > 70 || /\n/.test(m.reason));
  t.check('UNIT-MODEL-02', 'every model has a tier (recommended/other) and a one-line reason of at most 70 characters; Canary and Parakeet Ultra are the recommended ones, listed first; the cloud model is never recommended',
    tiers.every((x) => ['recommended', 'other'].includes(x)) && !longReason.length && JSON.stringify(recommended) === '["canary-1b-v2","parakeet-ultra"]'
      && MODELS.slice(0, recommended.length).every((m) => m.tier === 'recommended') && MODELS.find((m) => m.cloud).tier === 'other',
    `recommended ${recommended.join(', ')}; ${longReason.length ? `reasons too long: ${longReason.map((m) => m.id).join(', ')}` : 'every reason fits'}`);
}
// python/nemo_server.py refuses a decoder it does not know, but only once someone picks the model.
const nemoDecoders = fs.readFileSync(path.join(ROOT, 'python', 'nemo_server.py'), 'utf8').match(/"--decoder", choices=\[([^\]]*)\]/)[1].match(/[\w-]+/g);
const nemoModels = MODELS.filter((m) => m.engine === 'python-nemo');
const badNemo = nemoModels.filter(({ nemo, files }) => !nemoDecoders.includes(nemo.decoder)
  || (nemo.decoder === 'ctc-lm') !== Boolean(nemo.lm)
  || ![nemo.model, nemo.lm].filter(Boolean).every((f) => files.some((x) => x.file === f)));
t.check('UNIT-MODEL-01', 'every NeMo model uses a decoder nemo_server.py accepts and downloads the files it loads', nemoModels.length > 0 && !badNemo.length,
  `decoders ${nemoDecoders.join('/')}; ${nemoModels.map((m) => `${m.id}: ${m.nemo.decoder}`).join(', ')}${badNemo.length ? `; wrong: ${badNemo.map((m) => m.id).join(', ')}` : ''}`);

// ---------- the page's backlog while the server is unreachable (#11) ----------
{
  const b = createBacklog(3000); // 100 ms chunks: 5 minutes, as the page
  for (let i = 0; i < 4200; i++) b.push(i); // a 7-minute outage
  const kept = b.take();
  t.check('UNIT-NET-01', 'a 7-minute outage keeps the newest 5 minutes in order and counts the 2 minutes dropped',
    kept.chunks.length === 3000 && kept.chunks[0] === 1200 && kept.chunks.at(-1) === 4199 && kept.dropped === 1200,
    `${kept.chunks.length} kept from ${kept.chunks[0]}, ${kept.dropped} dropped`);
  const note = lostNote(kept);
  t.check('UNIT-NET-02', 'the page says how long the server was away and how much was not transcribed',
    note.includes('unreachable for 7 min') && note.includes('last 5 min') && note.includes('first 2 min of it were lost'), note);
  for (let i = 0; i < 50; i++) b.push(i);
  const short = b.take();
  t.check('UNIT-NET-03', 'a short outage after it keeps everything and says nothing (take() starts over)',
    short.chunks.length === 50 && short.dropped === 0 && lostNote(short) === '' && b.take().chunks.length === 0);
}

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
 * Pretends the disk has `free` bytes left for the files opened while it is in place whose names end in one of `kinds`
 * (WAVs unless given), as a real disk behaves: a write that does not fit is cut short without an error, and the next
 * one fails with ENOSPC; rewriting bytes a file already has needs no room, and cutting a file shorter gives room back.
 * A write without a position goes to the end of the file. appendFileSync goes the same way: Node writes a string
 * straight from C++, past these functions, so the stand-in does here what Node does for a Buffer.
 * open() counts those files still open; restore() puts the real fs back.
 */
function smallDisk(free, kinds = ['.wav']) {
  const real = { openSync: fs.openSync, writeSync: fs.writeSync, ftruncateSync: fs.ftruncateSync, closeSync: fs.closeSync, appendFileSync: fs.appendFileSync };
  const sizes = new Map(); // fd -> bytes in the file
  const onDisk = (file) => kinds.some((kind) => String(file).endsWith(kind));
  const full = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
  fs.openSync = (file, ...rest) => {
    const fd = real.openSync(file, ...rest);
    if (onDisk(file)) sizes.set(fd, fs.fstatSync(fd).size);
    return fd;
  };
  fs.writeSync = (fd, buf, offset, length, position) => {
    if (!sizes.has(fd)) return real.writeSync(fd, buf, offset, length, position);
    const size = sizes.get(fd);
    const at = position ?? size;
    const fits = Math.min(length, size + free - at);
    if (fits <= 0) throw full();
    const n = real.writeSync(fd, buf, offset, fits, at);
    const grown = Math.max(0, at + n - size);
    free -= grown;
    sizes.set(fd, size + grown);
    return n;
  };
  fs.ftruncateSync = (fd, length = 0) => {
    if (sizes.has(fd)) {
      if (length - sizes.get(fd) > free) throw full();
      free -= length - sizes.get(fd);
      sizes.set(fd, length);
    }
    real.ftruncateSync(fd, length);
  };
  fs.closeSync = (fd) => {
    sizes.delete(fd);
    real.closeSync(fd);
  };
  fs.appendFileSync = (file, data, ...rest) => {
    if (!onDisk(file)) return real.appendFileSync(file, data, ...rest);
    const buf = Buffer.from(data);
    const fd = fs.openSync(file, 'a');
    try {
      for (let at = 0; at < buf.length;) at += fs.writeSync(fd, buf, at, buf.length - at);
    } finally {
      fs.closeSync(fd);
    }
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

// A reconnect carries the WAV on (#10): the server was killed after a chunk's samples and before its header.
const goneOn = path.join(dir, 'resumed.wav');
const before = new WavWriter(goneOn);
before.append(tone.subarray(0, 8000));
before.close();
fs.appendFileSync(goneOn, Buffer.alloc(2 * 100 + 1)); // 100 samples and half of one, not in the header
const carried = new WavWriter(goneOn, { resume: true });
carried.append(tone.subarray(8000));
carried.close();
const resumedWav = decodeWav(fs.readFileSync(goneOn));
const fresh = new WavWriter(path.join(dir, 'resumed-new.wav'), { resume: true }); // nothing to carry on: a new file
fresh.append(tone.subarray(0, 1600));
fresh.close();
t.check('UNIT-WAV-06', 'a resumed WAV writer carries on an existing file after its last whole sample, header fixed; with no file it starts one',
  resumedWav.samples.length === 8000 + 100 + 8000 && Math.abs(resumedWav.samples.at(-1) - tone.at(-1)) < 1e-4
    && decodeWav(fs.readFileSync(path.join(dir, 'resumed-new.wav'))).samples.length === 1600,
  `${resumedWav.samples.length} samples (want 16,100)`);

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

// ---------- a reconnect carries the transcript on (#10; loudness detector, stand-in model) ----------
// One mic, Save audio on, a sentence at 1 s. The connection drops; the page reconnects and tells the new connection the
// transcript's name and the 4 s of audio it had sent, then the same again: the second sentence is 4 s after the first (the line's time is where its speech starts, with
// a little lead-in, so 0:00 and 0:04).
async function reconnects(resumeWith) {
  const out = scratch('resume');
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy' } };
  const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null, transcribe: async () => ({ text: 'o propoziție', model: 'stub', ms: 1 }) };
  const talk = concat(quiet(1), loud(1.5), quiet(1.5));
  const connect = async (resume, others = []) => {
    const sent = [];
    const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
    session.setOptions({ saveAudio: true });
    if (resume) session.resume(resume, others);
    for (let i = 0; i < talk.length; i += 1600) session.audio(talk.slice(i, i + 1600));
    session.flush();
    await sleep(50);
    return { session, sent, name: sent.find((m) => m.type === 'file')?.name };
  };
  const one = await connect();
  one.session.close();
  const two = await connect(resumeWith(one.name, talk.length));
  two.session.close();
  const files = fs.readdirSync(out).sort();
  const txt = files.filter((f) => f.endsWith('.txt')).map((f) => fs.readFileSync(path.join(out, f), 'utf8'));
  const wavs = files.filter((f) => f.endsWith('.wav')).map((f) => decodeWav(fs.readFileSync(path.join(out, f))).samples.length / SR);
  // Another connection still writing the transcript: a second one cannot take it over.
  const busy = await connect();
  const thief = await connect({ name: busy.name, samples: 0 }, [busy.session]);
  busy.session.close();
  thief.session.close();
  fs.rmSync(out, { recursive: true, force: true });
  return { files, txt, wavs, starts: two.sent.filter((m) => m.type === 'final' && m.text).map((m) => m.start), names: [one.name, two.name], taken: thief.name !== busy.name };
}
const resumed = await reconnects((name, samples) => ({ name, samples }));
t.check('UNIT-SESS-19', 'a reconnect that tells the server its transcript and audio carries on the same .txt and WAV, the clock going on',
  resumed.names[0] === resumed.names[1] && resumed.txt.length === 1 && resumed.txt[0] === '[00:00] o propoziție\n[00:04] o propoziție\n'
    && resumed.wavs.length === 1 && Math.abs(resumed.wavs[0] - 8) < 0.01 && Math.abs(resumed.starts[0] - 4.7) < 0.5,
  `${resumed.files.join(', ')}; ${JSON.stringify(resumed.txt)}; WAV ${resumed.wavs.map((w) => `${w.toFixed(2)} s`).join(', ')}`);
const refusedNames = await Promise.all([
  reconnects(() => ({ name: '../../escape', samples: 64000 })),
  reconnects(() => ({ name: '2020-01-01_00-00-00', samples: 64000 })), // no such transcript
]);
t.check('UNIT-SESS-20', 'a reconnect naming a transcript that is not there (or not a name), or that another connection is writing, starts a new file; the clock still goes on',
  refusedNames.every((r) => r.names[0] !== r.names[1] && r.txt.length === 2 && r.txt.includes('[00:04] o propoziție\n')) && resumed.taken,
  refusedNames.map((r) => r.files.join(', ')).join(' | ') + (resumed.taken ? '' : '; a second connection took over an open transcript'));

// ---------- a model slower than the talk (#9; loudness detector, stand-in model) ----------
// One mic, a sentence every 4 s for 60 s. `slow`: the model answers nothing until the audio is all sent, then
// finishes the queue one sentence at a time; otherwise it answers at once.
async function lagging(slow) {
  const sent = [];
  const out = scratch('behind');
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy' } };
  const queue = [];
  const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null,
    transcribe: () => (slow ? new Promise((resolve) => queue.push(resolve)) : Promise.resolve({ text: 'o propoziție', model: 'stub', ms: 1 })) };
  const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
  const talk = concat(...Array.from({ length: 15 }, () => concat(quiet(1), loud(1.5), quiet(1.5))));
  const told = []; // { at: seconds of audio sent, seconds }
  for (let i = 0; i < talk.length; i += 1600) {
    const from = sent.length;
    session.audio(talk.subarray(i, i + 1600));
    await new Promise((resolve) => setImmediate(resolve)); // the page sends a chunk every 100 ms: the model gets its turn
    for (const m of sent.slice(from)) if (m.type === 'behind') told.push({ at: (i + 1600) / SR, seconds: m.seconds });
  }
  session.flush();
  const waiting = queue.length;
  while (queue.length) {
    queue.shift()({ text: 'o propoziție', model: 'stub', ms: 1 });
    await sleep(1);
  }
  await sleep(20);
  const behind = sent.filter((m) => m.type === 'behind');
  session.close();
  fs.rmSync(out, { recursive: true, force: true });
  return { told, behind, waiting, finals: sent.filter((m) => m.type === 'final' && m.text).length };
}
const late = await lagging(true);
const firstTold = late.told[0];
t.check('UNIT-SESS-21', 'a model slower than the talk: the page is told once the oldest waiting sentence is more than 30 s old, and as it grows',
  firstTold && firstTold.seconds >= 30 && firstTold.seconds <= 31 && firstTold.at <= 36 && late.told.every((m, i) => !i || m.seconds - late.told[i - 1].seconds >= 5),
  late.told.map((m) => `${m.seconds} s at ${m.at.toFixed(1)} s`).join(', ') || 'never told');
t.check('UNIT-SESS-22', 'when the model catches up, the warning is cleared, and nothing was dropped',
  late.behind.at(-1)?.seconds === 0 && late.behind.filter((m) => m.seconds === 0).length === 1 && late.finals === 15 && late.waiting === 15,
  `last ${late.behind.at(-1)?.seconds} s; ${late.finals} of 15 lines (${late.waiting} were waiting)`);
const quick = await lagging(false);
t.check('UNIT-SESS-23', 'a model that keeps up: the page is never told it is behind', quick.behind.length === 0 && quick.finals === 15,
  `${quick.behind.length} messages; ${quick.finals} of 15 lines`);

// ---------- steady live text (#26; loudness detector, stand-in model) ----------
// Live guesses of one sentence the way Canary revises them: a comma and a capital come and go, the first word is
// rewritten once, a word is cut short and then finished.
const GUESSES = ['Astăzi', 'Astăzi vorbim', 'Astăzi, vorbim despre', 'Azi vorbim despre model', 'Astăzi vorbim despre modelele noi',
  'Astăzi vorbim despre modelele noi.'];
const steadyRun = (guesses) => {
  const steady = new SteadyText();
  return guesses.map((g) => steady.update(g));
};
const shownSeq = steadyRun(GUESSES);
t.check('UNIT-STEADY-01', 'a word is shown only once two guesses in a row agree on it; the first guess shows nothing',
  JSON.stringify(shownSeq) === JSON.stringify([null, 'Astăzi', 'Astăzi vorbim', 'Astăzi vorbim despre', null, 'Astăzi vorbim despre modelele noi']),
  JSON.stringify(shownSeq));
const growing = (texts) => texts.every((x, i) => !i || x.startsWith(`${texts[i - 1]} `));
t.check('UNIT-STEADY-02', 'a word once shown is never taken back: each text shown is the one before plus words, even when a guess rewrites an earlier word',
  growing(shownSeq.filter(Boolean)) && !shownSeq.some((x) => x?.includes('Azi')), shownSeq.filter(Boolean).join(' → '));
const forms = steadyRun(['bună ziua', 'Bună ziua, dragi', 'Bună, ziua dragi colegi', 'bună ziua dragi colegi.']);
t.check('UNIT-STEADY-03', 'words are compared ignoring case and punctuation, and keep the form already on screen',
  JSON.stringify(forms) === JSON.stringify([null, 'Bună ziua', 'Bună ziua dragi', 'Bună ziua dragi colegi']), JSON.stringify(forms));

// The same guesses through a session: one 5 s sentence, the stand-in answers each live guess with the next of GUESSES.
async function liveGuesses(steadyLive) {
  const sent = [];
  const out = scratch('steady');
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy' } };
  let n = 0;
  const stub = { supportsPrompt: false, avgMs: 10,
    tryTranscribe: () => Promise.resolve({ text: GUESSES[Math.min(n++, GUESSES.length - 1)] }),
    transcribe: async () => ({ text: 'Astăzi vorbim despre modelele noi de azi.', model: 'stub', ms: 1 }) };
  const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
  session.setOptions({ steadyLive });
  const talk = concat(quiet(1), loud(5), quiet(1.5));
  for (let i = 0; i < talk.length; i += 1600) {
    session.audio(talk.subarray(i, i + 1600));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await sleep(20);
  session.close();
  fs.rmSync(out, { recursive: true, force: true });
  const texts = sent.filter((m) => m.type === 'partial' || m.type === 'final');
  return { guesses: n, partials: texts.filter((m) => m.type === 'partial'), finals: texts.filter((m) => m.type === 'final'), lastType: texts.at(-1)?.type };
}
const steadyOn = await liveGuesses(true);
const steadyOff = await liveGuesses(false);
const liveTexts = (r) => r.partials.map((m) => m.text);
const finalOn = steadyOn.finals[0];
t.check('UNIT-STEADY-04', 'Steady live text on (the default): the page gets only growing live text, and the final line replaces it under the same sentence id',
  steadyOn.guesses >= GUESSES.length && growing(liveTexts(steadyOn)) && liveTexts(steadyOn).at(-1) === 'Astăzi vorbim despre modelele noi'
    && steadyOn.finals.length === 1 && steadyOn.lastType === 'final' && steadyOn.partials.every((m) => m.id === finalOn.id) && finalOn.text === 'Astăzi vorbim despre modelele noi de azi.',
  `${steadyOn.guesses} guesses; live ${liveTexts(steadyOn).join(' → ')}; final #${finalOn?.id} "${finalOn?.text}"`);
t.check('UNIT-STEADY-05', 'Steady live text off: every guess is shown as the model wrote it, rewrites included',
  steadyOff.partials.length === steadyOff.guesses && liveTexts(steadyOff).includes('Azi vorbim despre model') && !growing(liveTexts(steadyOff)),
  `${steadyOff.guesses} guesses, ${steadyOff.partials.length} live texts`);

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
    options: sent.filter((m) => m.type === 'options').map((m) => m.saveAudio),
  };
}
const filled = await diskFills();
const after = filled.finals.filter((f) => f.start > Math.max(...filled.secs)).length;
t.check('UNIT-SESS-08', 'the disk fills up while saving two mics: audio() never throws, one "Could not save audio", sentences keep coming, both WAVs playable up to there',
  !filled.thrown && filled.errors.length === 1 && filled.errors[0].startsWith('Could not save audio: ENOSPC') && filled.finals.length === 6 && after === 4
    && filled.playable && filled.secs.every((s) => Math.abs(s - 8) < 0.1),
  `${filled.thrown ? `audio() threw ${filled.thrown.code}; ` : ''}errors: ${filled.errors.join(' | ') || 'none'}; ${filled.finals.length} sentences, ${after} after the disk filled; WAVs ${filled.secs.map((s) => `${s.toFixed(2)} s`).join(', ')}${filled.playable ? '' : ', a header and its file differ'}`);
t.check('UNIT-SESS-12', 'when a full disk stops Save audio, the page is told once to untick its box',
  filled.options.length === 1 && filled.options[0] === false, `"options" messages: ${JSON.stringify(filled.options)}`);

// ---------- the disk fills up while saving the transcript (#19; loudness detector, stand-in model) ----------
// One mic, a sentence every 4 s, each transcribed as its own text. The disk has room for two lines and 10 bytes, so
// line 3 is cut short and then fails, as on a real disk. Then there is room again (someone deleted files), the disk
// fills again, Stop and Start are pressed, then Clear, and at last there is room again.
async function textFills() {
  const sent = [];
  const out = scratch('full-text');
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy' } };
  const said = (n) => `propoziția numărul ${n} din ședință`;
  let calls = 0;
  const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null, transcribe: async () => ({ text: said(++calls), model: 'stub', ms: 1 }) };
  const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
  const sentence = concat(quiet(1), loud(1.5), quiet(1.5));
  const talk = async (count) => {
    for (let n = 0; n < count; n++) for (let i = 0; i < sentence.length; i += 1600) session.audio(sentence.subarray(i, i + 1600));
    await sleep(20); // the stand-in model answers
  };
  const finals = () => sent.filter((m) => m.type === 'final' && m.text);
  const files = () => sent.filter((m) => m.type === 'file' && m.kind === 'text').map((m) => path.resolve(m.path));
  const text = (file) => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  let disk = smallDisk(2 * Buffer.byteLength(`[00:00] ${said(1)}\n`) + 10, ['.txt']);
  await talk(4); // line 3 is cut short and fails; 3 and 4 wait
  const whileFull = text(files()[0]);
  disk.restore();
  await talk(2); // line 5 takes 3 and 4 along
  const caughtUp = text(files()[0]);
  disk = smallDisk(0, ['.txt']);
  await talk(2); // 7 and 8 wait
  session.flush(); // Stop
  await talk(1); // Start: 9 waits
  session.reset(); // Clear: a new transcript; 7 to 9 had no room in the old one
  await talk(1); // 10 waits
  disk.restore();
  await talk(1); // 11 takes 10 along
  session.close();
  /** A .txt against the page's lines from..to: '' when it holds exactly those, whole and in order; else how it differs. */
  const differs = (txt, from, to) => {
    const want = finals().slice(from - 1, to).map((f) => `[${fmtTime(f.start)}] ${f.text}\n`);
    if (txt === want.join('')) return '';
    const got = txt.split(/(?<=\n)/);
    const missing = want.map((l, i) => !got.includes(l) && from + i).filter(Boolean);
    const odd = got.filter((l) => !want.includes(l)).map((l) => JSON.stringify(l.length > 45 ? `${l.slice(0, 45)}…` : l));
    return [missing.length && `lines ${missing.join(', ')} missing`, odd.length && `not a line: ${odd.join(', ')}`].filter(Boolean).join(', ') || 'out of order';
  };
  const told = []; // after which line each "Could not save transcript" came
  sent.forEach((m, i) => m.type === 'error' && told.push(sent.slice(0, i).filter((x) => x.type === 'final' && x.text).length));
  const result = {
    finals: finals().length,
    whileFull: differs(whileFull, 1, 2),
    caughtUp: differs(caughtUp, 1, 6),
    old: differs(text(files()[0]), 1, 6),
    fresh: files().length === 2 ? differs(text(files()[1]), 10, 11) : `${files().length} transcript files`,
    told,
    errors: [...new Set(sent.filter((m) => m.type === 'error').map((m) => m.message))],
  };
  fs.rmSync(out, { recursive: true, force: true });
  return result;
}
const tf = await textFills();
t.check('UNIT-SESS-13', 'a full disk while saving the transcript: the .txt keeps only whole lines; once there is room it catches up, every line in order; after Clear the new transcript does too',
  tf.finals === 11 && !tf.whileFull && !tf.caughtUp && !tf.old && !tf.fresh,
  `${tf.finals} sentences. While full: ${tf.whileFull || 'lines 1-2, whole'}. With room again: ${tf.caughtUp || 'lines 1-6'}. `
    + `After Clear, the old .txt: ${tf.old || 'lines 1-6'}; the new one: ${tf.fresh || 'lines 10-11'}`);
t.check('UNIT-SESS-14', 'a full disk while saving the transcript: the page is told once, and again only after a save worked, after Start (which hides its errors) and after Clear',
  tf.told.join() === '3,7,9,10' && tf.errors.length === 1 && tf.errors[0].startsWith('Could not save transcript: ENOSPC'),
  `told after lines ${tf.told.join(', ') || 'never'} (expected 3, 7, 9, 10); ${tf.errors.join(' | ')}`);

// ---------- the .txt is in speaking order (#7; loudness detector, stand-in model) ----------
// Mic 1 says a long sentence, then mic 2 a short one, taking turns. The stand-in model takes longer for longer audio,
// so the short line is transcribed first. The page shows it at once (it sorts by start); the .txt waits for mic 1's.
async function speakingOrder() {
  const sent = [];
  const out = scratch('order');
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy' } };
  const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null,
    transcribe: async (samples) => {
      const sec = samples.length / SR;
      await sleep(sec * 30);
      return { text: sec > 2 ? 'o propoziție lungă de la primul' : 'una scurtă la al doilea', model: 'stub', ms: 1 };
    } };
  const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
  const mics = [concat(quiet(1), loud(3), quiet(4)), concat(quiet(5), loud(0.7), quiet(2.3))];
  for (let i = 0; i < mics[0].length; i += 1600) {
    const frame = new Float32Array(3200);
    mics.forEach((m, mic) => frame.set(m.subarray(i, i + 1600), mic * 1600));
    session.audio(frame, 2);
  }
  session.flush();
  await sleep(300);
  session.close();
  const finals = sent.filter((m) => m.type === 'final' && m.text);
  const file = sent.find((m) => m.type === 'file' && m.kind === 'text');
  const txt = file ? fs.readFileSync(path.resolve(file.path), 'utf8') : '';
  fs.rmSync(out, { recursive: true, force: true });
  const spoken = [...finals].sort((a, b) => a.start - b.start).map((f) => `[${fmtTime(f.start)}] Mic ${f.mic + 1}: ${f.text}\n`).join('');
  return { finals: finals.map((f) => `mic${f.mic + 1}`).join(', '), txt, spoken };
}
const so = await speakingOrder();
t.check('UNIT-SESS-15', 'mic 2\'s short line is transcribed before mic 1\'s longer one that started earlier: the .txt still has them in speaking order (as the page\'s Download), and the page gets the short line at once',
  so.finals === 'mic2, mic1' && so.txt === so.spoken,
  `page got ${so.finals || 'nothing'}; .txt ${so.txt === so.spoken ? 'in speaking order' : JSON.stringify(so.txt)}`);

// ---------- the page and the .txt in one order (#50; loudness detector, stand-in model) ----------
// Mic 1 talks for 5.5 s with one short dip, longer than the longest sentence (5 s here): the session cuts it at the
// dip, 3 s back, and the rest gets its id only then. Mic 2 started a short sentence after the dip but before the cut,
// so it has the smaller id and the later start. The page (public/order.js, the rule app.js places lines with) and the
// .txt must both put mic 1's rest first. Before the fix the page sorted by id: mic 2's line came first.
async function splitOrder() {
  const sent = [];
  const out = scratch('order50');
  const conf = { ...structuredClone(config), transcriptsDir: out, vad: { ...config.vad, engine: 'energy', maxSegmentSec: 5 } };
  // No word in common: a line that shares words with one on the other mic at the same time is dropped as heard twice.
  const said = (sec) => (sec < 1.5 ? 'cifrele sunt bune' : sec < 3 ? 'vreau să subliniez' : 'că toate rezultatele contează');
  const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null, transcribe: async (samples) => ({ text: said(samples.length / SR), model: 'stub', ms: 1 }) };
  const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
  const dip = (sec) => Float32Array.from({ length: Math.round(sec * SR) }, (_, i) => 0.0001 * Math.sin(i * 1.7));
  const mics = [concat(quiet(1), loud(2), dip(0.3), loud(3.2), quiet(3.5)), concat(quiet(4), loud(0.8), quiet(5.2))];
  for (let i = 0; i < mics[0].length; i += 1600) {
    const frame = new Float32Array(3200);
    mics.forEach((m, mic) => frame.set(m.subarray(i, i + 1600), mic * 1600));
    session.audio(frame, 2);
  }
  session.flush();
  await sleep(300);
  session.close();
  const finals = sent.filter((m) => m.type === 'final' && m.text);
  const file = sent.find((m) => m.type === 'file' && m.kind === 'text');
  const txt = file ? fs.readFileSync(path.resolve(file.path), 'utf8') : '';
  fs.rmSync(out, { recursive: true, force: true });
  const line = (f) => `[${fmtTime(f.start)}] Mic ${f.mic + 1}: ${f.text}\n`;
  const lines = (sort) => [...finals].sort(sort).map(line).join('');
  return {
    finals: finals.map((f) => `#${f.id} mic ${f.mic + 1} ${f.start.toFixed(2)}–${f.end.toFixed(2)} s`).join(', '),
    page: lines(spokenOrder), // what the page shows and downloads
    txt,
    byStart: lines((a, b) => a.start - b.start),
    byId: lines((a, b) => a.id - b.id), // the page before the fix
  };
}
const sp = await splitOrder();
t.check('UNIT-ORDER-01', 'a sentence too long for the model is cut 3 s back, after mic 2 started a short one: the page\'s order and the .txt both put the rest of mic 1\'s sentence first, in speaking order (by id, the page\'s order before the fix, mic 2 came first)',
  sp.page === sp.txt && sp.txt === sp.byStart && sp.byId !== sp.byStart,
  `${sp.finals}; page ${sp.page === sp.byStart ? 'in speaking order' : JSON.stringify(sp.page)}; .txt ${sp.txt === sp.byStart ? 'in speaking order' : JSON.stringify(sp.txt)}; by id ${sp.byId === sp.byStart ? 'the same (the case did not happen)' : 'another order'}`);
const rule = [
  { connection: 1, start: 0.5, id: 1 }, // a later connection: ids and, when it could not carry on, times restart
  { connection: 0, start: 3.8, id: 2 },
  { connection: 0, start: 3.3, id: 3 }, // started earlier, id given later
  { connection: 0, start: 3.8, id: 4 }, // the same moment as #2
  { start: 0.8, id: 5 }, // the .txt's lines have no connection: the first
].sort(spokenOrder).map((l) => `${l.connection ?? '-'}:${l.id}`).join(' ');
t.check('UNIT-ORDER-02', 'the order rule (public/order.js): by connection, then by start, then by id', rule === '-:5 0:3 0:2 0:4 1:1', rule);

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

// ---------- a model that keeps crashing ----------
// A stand-in engine behind the real Transcriber (retryMs shortened from 30 s): crashed 4 times in quick succession,
// then its reloads fail once and work after that.
{
  const keepKey = config.elevenlabs.apiKey;
  config.elevenlabs.apiKey = 'stand-in'; // makes the cloud model count as installed; the engine is the stand-in below
  let crash = null;
  let loads = 0;
  let failLoads = 0;
  class Flaky extends Transcriber {
    createEngine(model, onCrash) {
      return {
        load: async () => {
          loads++;
          if (failLoads > 0 && failLoads--) throw new Error('stand-in load failed');
          crash = () => onCrash('stand-in crashed.');
        },
        unload: async () => {},
        kill: () => {},
        transcribe: async () => ({ text: 'merge' }),
      };
    }
  }
  const tr = new Flaky(structuredClone(config));
  tr.retryMs = 300;
  const states = [];
  tr.on('state', (s) => states.push(s.state));
  const logError = console.error;
  console.error = () => {};
  try {
    await tr.select('elevenlabs-scribe-v2');
    for (let k = 0; k < 3; k++) { crash(); await tr.queue; }
    const restarted = tr.state === 'ready' && loads === 4;
    failLoads = 1;
    crash();
    const gaveUp = { state: tr.state, message: tr.message, loads };
    states.length = 0;
    await sleep(450); // first retry: its load fails
    const afterFailed = { state: tr.state, loads, states: [...states] };
    await sleep(300); // second retry: it loads
    await tr.queue;
    const text = tr.state === 'ready' ? (await tr.transcribe(new Float32Array(SR))).text : null;
    t.check('UNIT-ENG-01', 'a model that crashes 4 times in quick succession: 3 quick restarts, then an error saying it retries every 30 s',
      restarted && gaveUp.state === 'error' && /stand-in crashed\. Retrying every 0 s/.test(gaveUp.message),
      `${gaveUp.loads} loads; ${gaveUp.state}: ${gaveUp.message}`);
    t.check('UNIT-ENG-01', 'after giving up it is tried again on its own; a failed retry keeps the error shown (no "loading"), the next one brings it back',
      afterFailed.state === 'error' && afterFailed.loads === 5 && afterFailed.states.every((s) => s === 'error') && loads === 6 && tr.state === 'ready' && text === 'merge',
      `after the 1st retry ${afterFailed.state} (${afterFailed.states.join(', ') || 'no state change'}); after the 2nd ${tr.state}, ${loads} loads, text ${text}`);
    crash(); // within a minute of the last crashes: gives up straight away
    const before = loads;
    tr.kill();
    await sleep(450);
    t.check('UNIT-ENG-01', 'closing the app stops the retries', tr.state === 'error' && loads === before, `${loads - before} loads after kill()`);
  } finally {
    console.error = logError;
    tr.kill();
    config.elevenlabs.apiKey = keepKey;
  }
}

// ---------- a sentence the model goes away under is sent again (#45) ----------
// A stand-in model process (Node, an HTTP server like whisper-server) killed with SIGKILL while it transcribes the
// first of three sentences: before the fix the first failed with "fetch failed" and the two queued behind it with
// "Loading …" (or "fetch failed" too). Each answer names the process that gave it and the sentence's length.
{
  const keepKey = config.elevenlabs.apiKey;
  config.elevenlabs.apiKey = 'stand-in'; // makes the cloud model count as installed; the engine is the stand-in below
  const script = path.join(dir, 'fake-model-process.mjs');
  fs.writeFileSync(script, `import http from 'node:http';
http.createServer((req, res) => {
  if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
  let bytes = 0;
  req.on('data', (chunk) => (bytes += chunk.length));
  req.on('end', () => setTimeout(() => res.end(JSON.stringify({ text: process.pid + ' ' + bytes / 4 })), 200));
}).listen(Number(process.argv[2]), '127.0.0.1');
`);
  class FakeModelProcess extends SidecarEngine {
    command(port) {
      return { name: 'fake-model', bin: process.execPath, args: [script, String(port)], missing: 'fake program missing' };
    }

    async transcribe(samples) {
      const res = await this.post('/inference', { body: Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength) });
      return { text: JSON.parse(res.text).text };
    }
  }
  const engines = [];
  class Restarting extends Transcriber {
    createEngine(model, onCrash) {
      const engine = new FakeModelProcess({ onCrash });
      engines.push(engine);
      return engine;
    }
  }
  const tr = new Restarting(structuredClone(config));
  const logError = console.error;
  console.error = () => {};
  try {
    await tr.select('elevenlabs-scribe-v2');
    const first = engines[0].child?.pid;
    const sentences = [1, 2, 3].map((k) => tr.transcribe(new Float32Array(k * 1000)));
    await sleep(80); // the first sentence is on the model, the other two wait behind it
    process.kill(first, 'SIGKILL');
    const results = await Promise.allSettled(sentences);
    const texts = results.map((x) => (x.status === 'fulfilled' ? x.value.text : `failed: ${x.reason.message}`));
    const second = engines[1]?.child?.pid;
    t.check('UNIT-ENG-02', 'the model process killed mid-sentence, two sentences waiting: it is restarted and all three are transcribed by the new process, none fails',
      engines.length === 2 && tr.state === 'ready' && second && second !== first && texts.join() === [1000, 2000, 3000].map((n) => `${second} ${n}`).join() && tr.pending === 0,
      `${engines.length} processes started (killed ${first}, then ${second}); ${tr.state}; ${texts.join(' | ')}`);
  } finally {
    console.error = logError;
    await tr.shutdown();
    config.elevenlabs.apiKey = keepKey;
  }
}

// A switch with sentences waiting for the model (stand-in engines, 100 ms a sentence; a second stand-in model in the
// list): before the fix the waiting sentences failed with "Loading …". Then the old model's process dies while the
// switch waits for it: its sentences go to the new model. A sentence the model itself fails on is not sent again.
{
  const keepKey = config.elevenlabs.apiKey;
  config.elevenlabs.apiKey = 'stand-in';
  const standIn = { id: 'stand-in-model', label: 'Stand-in model', engine: 'elevenlabs', size: 'cloud', cloud: true };
  MODELS.push(standIn);
  const log = [];
  let crash = false;
  class Switching extends Transcriber {
    createEngine(model, onCrash) {
      const name = model === standIn ? 'B' : 'A';
      return {
        load: async () => { log.push(`load ${name}`); await sleep(50); },
        unload: async () => { log.push(`unload ${name}`); },
        kill: () => {},
        transcribe: async (samples) => {
          await sleep(100);
          log.push(`${name}${samples.length}`);
          if (crash && name === 'A') {
            crash = false;
            onCrash('stand-in crashed.'); // as a model process does: the crash is reported, then the request fails
            throw new Error('fetch failed');
          }
          if (samples.length === 9) throw new Error('stand-in: this audio cannot be read');
          return { text: `${name}${samples.length}` };
        },
      };
    }
  }
  const run = async (crashing) => {
    log.length = 0;
    const tr = new Switching(structuredClone(config));
    await tr.select('elevenlabs-scribe-v2');
    const queued = [1, 2, 3].map((k) => tr.transcribe(new Float32Array(k)));
    await sleep(20); // the first is on model A, the other two wait behind it
    crash = crashing;
    tr.select(standIn.id);
    const later = [4, 5, 9].map((k) => tr.transcribe(new Float32Array(k)));
    const results = await Promise.allSettled([...queued, ...later]);
    const out = results.map((x) => (x.status === 'fulfilled' ? `${x.value.text} (${x.value.model === standIn.id ? 'B' : 'A'})` : `failed: ${x.reason.message}`));
    await tr.shutdown();
    return { out, log: [...log], state: tr.state, pending: tr.pending };
  };
  const logError = console.error;
  console.error = () => {};
  try {
    const sw = await run(false);
    t.check('UNIT-ENG-03', 'a switch with two sentences waiting: the old model transcribes the sentences queued before it, the new one those after it; none fails',
      sw.out.slice(0, 5).join() === 'A1 (A),A2 (A),A3 (A),B4 (B),B5 (B)' && sw.log.slice(0, 7).join() === 'load A,A1,A2,A3,unload A,load B,B4' && sw.state === 'ready',
      `${sw.out.slice(0, 5).join(', ')}; ${sw.log.join(', ')}`);
    t.check('UNIT-ENG-03', 'a sentence the model itself fails on is not sent again: one try, its own error',
      sw.out[5] === 'failed: stand-in: this audio cannot be read' && sw.log.filter((x) => x === 'B9').length === 1 && sw.pending === 0,
      `${sw.out[5]}; tried ${sw.log.filter((x) => x === 'B9').length} time(s)`);
    const died = await run(true);
    t.check('UNIT-ENG-03', 'the old model\'s process dies during a switch: its sentence and the two waiting go to the new model, which is not reloaded; none fails',
      died.out.slice(0, 5).join() === 'B1 (B),B2 (B),B3 (B),B4 (B),B5 (B)' && died.log.filter((x) => x.startsWith('load')).join() === 'load A,load B' && died.state === 'ready',
      `${died.out.slice(0, 5).join(', ')}; ${died.log.join(', ')}`);
  } finally {
    console.error = logError;
    MODELS.splice(MODELS.indexOf(standIn), 1);
    config.elevenlabs.apiKey = keepKey;
  }
}

// ---------- GPU first, CPU only as the fallback ----------
// Every local model that can use the GPU is on an engine that tries the GPU first (stand-ins for the GPU: none in tests).
{
  const GPU_ENGINES = ['transcribe.cpp', 'whisper.cpp', 'python-nemo', 'apple-speech'];
  const local = MODELS.filter((m) => !m.cloud);
  const cpuOnly = local.filter((m) => !GPU_ENGINES.includes(m.engine));
  const parakeet = MODELS.find((m) => m.id === 'parakeet-tdt-0.6b-v3');
  t.check('UNIT-GPU-01', 'every local model runs on an engine that uses the GPU; Parakeet TDT v3 keeps its id and is on transcribe.cpp',
    !cpuOnly.length && parakeet?.engine === 'transcribe.cpp' && /\.gguf$/.test(parakeet.file) && parakeet.url.endsWith(parakeet.file),
    `${local.length} local models; CPU-only: ${cpuOnly.map((m) => `${m.id} (${m.engine})`).join(', ') || 'none'}; Parakeet TDT v3 on ${parakeet?.engine}`);

  // transcribe.cpp: "auto" (the GPU) first; the CPU only when that load throws.
  const fakeModel = (backend, deviceType) => ({ backend, device: { deviceType, name: backend }, capabilities: { languages: ['ro'] }, supports: () => false, dispose() {}, transcribe: async () => ({ text: backend }) });
  const tries = [];
  const onGpu = new TranscribeCppEngine({ modelPath: 'x.gguf', language: 'ro', load: async (file, opts) => (tries.push(opts.backend), fakeModel('Metal', 'gpu')) });
  await onGpu.load();
  const failing = [];
  const onCpu = new TranscribeCppEngine({
    modelPath: 'x.gguf',
    language: 'ro',
    load: async (file, opts) => {
      failing.push(opts.backend);
      if (opts.backend !== 'cpu') throw new Error('stand-in: Metal could not allocate the model');
      return fakeModel('CPU', 'cpu');
    },
  });
  await onCpu.load();
  const text = (await onCpu.transcribe(new Float32Array(SR))).text;
  t.check('UNIT-GPU-02', 'transcribe.cpp: loaded on the GPU first; when the GPU load fails, loaded on the CPU and still transcribes, saying why',
    tries.join() === 'auto' && onGpu.device === 'GPU (Metal)' && !onGpu.fallback
      && failing.join() === 'auto,cpu' && onCpu.device === 'CPU' && /Metal could not allocate/.test(onCpu.fallback) && text === 'CPU',
    `GPU: tried ${tries.join()} -> ${onGpu.device}; failing GPU: tried ${failing.join()} -> ${onCpu.device} (${onCpu.fallback})`);
  t.check('UNIT-GPU-03', 'transcribe.cpp device names: Metal/MTL0/CUDA0/Vulkan0 are the GPU, CPU and a CPU-accelerated backend are the CPU',
    [['Metal', 'gpu', 'GPU (Metal)'], ['MTL0', 'gpu', 'GPU (Metal)'], ['CUDA0', 'gpu', 'GPU (CUDA)'], ['Vulkan0', 'gpu', 'GPU (Vulkan)'], ['CPU', 'cpu', 'CPU'], ['cpu_accel', 'accel', 'CPU']]
      .every(([backend, type, want]) => describeDevice(fakeModel(backend, type)) === want));

  // A sidecar (whisper-server, the NeMo server) that dies on the GPU is started again on the CPU; a missing program is not.
  const script = path.join(dir, 'fake-sidecar.mjs');
  fs.writeFileSync(script, `import http from 'node:http';
const [port, mode] = process.argv.slice(2);
if (mode !== 'cpu') { console.error('stand-in: GPU init failed'); process.exit(3); }
http.createServer((req, res) => res.end(JSON.stringify({ status: 'ok' }))).listen(Number(port), '127.0.0.1');
`);
  class FakeSidecar extends SidecarEngine {
    cpuFallback = true;
    commands = [];
    command(port, { cpu }) {
      this.commands.push(cpu ? 'cpu' : 'gpu');
      return { name: 'fake', bin: this.bin ?? process.execPath, args: [script, String(port), cpu ? 'cpu' : 'gpu'], missing: 'fake program missing' };
    }
  }
  const sidecar = new FakeSidecar();
  await sidecar.load();
  await sidecar.unload();
  const missing = new FakeSidecar();
  missing.bin = path.join(dir, 'no-such-program');
  const missingError = await missing.load().then(() => null, (err) => err.message);
  t.check('UNIT-GPU-04', 'a model process that fails to start on the GPU is started again on the CPU; a missing program is reported, not retried',
    sidecar.commands.join() === 'gpu,cpu' && sidecar.device === 'CPU' && /GPU init failed/.test(sidecar.fallback)
      && missingError === 'fake program missing' && missing.commands.join() === 'gpu',
    `started ${sidecar.commands.join(' then ')} -> ${sidecar.device}; missing program: ${missingError} after ${missing.commands.join()}`);

  // The real engines ask for the GPU first and the CPU on the retry.
  const whisper = new WhisperCppEngine({ bin: 'whisper-server', modelPath: 'm.bin', port: 1, language: 'ro', threads: 4 });
  const nemo = new PythonNemoEngine({ id: 'jackrabbit-110m-ro', modelDir: 'd', nemo: { model: 'a.nemo', decoder: 'ctc' }, threads: 4 });
  const nemoDevices = fs.readFileSync(path.join(ROOT, 'python', 'nemo_server.py'), 'utf8').match(/"--device", choices=\[([^\]]*)\]/)?.[1].match(/[\w-]+/g) ?? [];
  const arg = (cmd, flag) => cmd.args[cmd.args.indexOf(flag) + 1];
  const [wGpu, wCpu, nGpu, nCpu] = [whisper.command(1, { cpu: false }), whisper.command(1, { cpu: true }), nemo.command(1, { cpu: false }), nemo.command(1, { cpu: true })];
  t.check('UNIT-GPU-05', 'whisper-server gets --no-gpu only on the CPU retry; the NeMo server gets --device auto, then cpu (choices it accepts), with MPS fallback on',
    whisper.cpuFallback && nemo.cpuFallback && !wGpu.args.includes('--no-gpu') && wCpu.args.includes('--no-gpu')
      && arg(nGpu, '--device') === 'auto' && arg(nCpu, '--device') === 'cpu' && ['auto', 'cpu'].every((d) => nemoDevices.includes(d))
      && nGpu.env.PYTORCH_ENABLE_MPS_FALLBACK === '1'
      && [['whisper_backend_init_gpu: using MTL0 backend', 'GPU (Metal)'], ['whisper_backend_init_gpu: using Metal backend', 'GPU (Metal)'],
        ['whisper_backend_init_gpu: using CUDA0 backend', 'GPU (CUDA)'], ['whisper_backend_init_gpu: using Vulkan0 backend', 'GPU (Vulkan)'],
        ['whisper_backend_init_gpu: no GPU found', 'CPU'], ['whisper_backend_init_gpu: failed to initialize MTL0 backend', 'CPU'],
        ['whisper_backend_init: using BLAS backend', null], ['whisper_init_with_params_no_state: use gpu    = 1', null]]
        .every(([line, want]) => (whisper.deviceFromLog(line) ?? null) === want),
    `whisper ${wCpu.args.slice(-1)}; nemo --device ${arg(nGpu, '--device')} / ${arg(nCpu, '--device')}; server accepts ${nemoDevices.join('/')}`);

  // transcribe.cpp mid-meeting: the GPU fails on a sentence. The CPU is tried on the same audio: if it works the GPU was
  // at fault and the model stays on the CPU; if it fails too, the audio was, and the model stays on the GPU.
  const midMeeting = async (cpuWorks) => {
    const disposed = [];
    const model = (backend, type, fails) => ({ ...fakeModel(backend, type), dispose: () => disposed.push(backend), transcribe: async () => { if (fails) throw new Error(`stand-in: ${backend} failed`); return { text: backend }; } });
    const engine = new TranscribeCppEngine({ modelPath: 'x.gguf', language: 'ro', load: async (file, opts) => (opts.backend === 'cpu' ? model('CPU', 'cpu', !cpuWorks) : model('Metal', 'gpu', true)) });
    await engine.load();
    const text = await engine.transcribe(new Float32Array(SR)).then((r) => r.text, (err) => `threw ${err.message}`);
    return { text, device: engine.device, fallback: engine.fallback, disposed: disposed.join() };
  };
  const moved = await midMeeting(true);
  const stayed = await midMeeting(false);
  t.check('UNIT-GPU-06', 'transcribe.cpp: the GPU fails on a sentence the CPU can do: the sentence is kept and the model stays on the CPU; when the CPU fails too, the error is the audio\'s and the model stays on the GPU',
    moved.text === 'CPU' && moved.device === 'CPU' && /Metal failed/.test(moved.fallback) && moved.disposed === 'Metal'
      && stayed.text === 'threw stand-in: Metal failed' && stayed.device === 'GPU (Metal)' && !stayed.fallback && stayed.disposed === 'CPU',
    `CPU works: "${moved.text}" on ${moved.device}, disposed ${moved.disposed}; CPU fails too: ${stayed.text}, on ${stayed.device}, disposed ${stayed.disposed}`);

  // The page is told where the model runs, and when it moves to the CPU mid-meeting (a stand-in engine).
  const keepKey = config.elevenlabs.apiKey;
  config.elevenlabs.apiKey = 'stand-in'; // makes the cloud model count as installed; the engine is the stand-in below
  const engine = { device: 'GPU (Metal)', fallback: null, load: async () => {}, unload: async () => {}, kill: () => {}, transcribe: async () => ({ text: 'merge' }) };
  class OnGpu extends Transcriber {
    createEngine() {
      return engine;
    }
  }
  const tr = new OnGpu(structuredClone(config));
  const told = [];
  tr.on('state', (s) => told.push(s));
  const logError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await tr.select('elevenlabs-scribe-v2');
    const ready = tr.status();
    await tr.transcribe(new Float32Array(SR));
    const quiet = told.length;
    Object.assign(engine, { device: 'CPU', fallback: 'stand-in: out of video memory' });
    await tr.transcribe(new Float32Array(SR));
    const moved = told.at(-1);
    t.check('UNIT-GPU-07', 'the status names the device; a model that moves to the CPU mid-meeting tells the page (device, reason) and the terminal, once',
      ready.state === 'ready' && ready.device === 'GPU (Metal)' && !ready.fallback && / on GPU \(Metal\)/.test(ready.message)
        && told.length === quiet + 1 && moved.state === 'ready' && moved.device === 'CPU' && moved.fallback === 'stand-in: out of video memory'
        && logged.some((l) => /moved to the CPU, the GPU failed: stand-in: out of video memory/.test(l)),
      `ready: ${ready.message} (${ready.device}); after the move: ${moved.device}, ${moved.fallback}; ${told.length - quiet} status message(s) for the move`);
  } finally {
    console.error = logError;
    tr.kill();
    config.elevenlabs.apiKey = keepKey;
  }
}

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

/**
 * Run two mic signals through per-mic analysis + the gate; count speech frames kept per mic. With `late`, the detector
 * notices speech that starts after a pause (0.5 s or more) that many frames late, as Silero does when someone starts
 * softly ("Era…"): on the FLEURS Romanian recordings up to 24 frames (0.8 s).
 */
function gate(m1, m2, marginDb = config.crosstalkDb, late = 0) {
  const segs = [0, 1].map(() => new Segmenter({ ...config.vad, detector: createDetector(config.vad) }));
  const g = new CrosstalkGate(2, marginDb);
  const kept = [0, 0];
  const speech = [0, 0];
  const pause = [Infinity, Infinity]; // per mic: frames since the detector last heard speech
  const unnoticed = [0, 0]; // frames of speech the detector has yet to notice
  const n = Math.min(m1.length, m2.length);
  for (let i = 0; i + 1600 <= n; i += 1600) {
    const f = [segs[0].analyze(m1.subarray(i, i + 1600)), segs[1].analyze(m2.subarray(i, i + 1600))];
    for (let k = 0; k < f[0].length; k++) {
      f.forEach((frames, mic) => {
        const frame = frames[k];
        if (frame.loud && pause[mic] >= 16) unnoticed[mic] = late;
        pause[mic] = frame.loud ? 0 : pause[mic] + 1;
        if (frame.loud && unnoticed[mic] > 0) {
          unnoticed[mic]--;
          frame.loud = false;
        }
        speech[mic] += frame.loud;
      });
      g.push([f[0][k], f[1][k]])?.forEach((frame, mic) => (kept[mic] += frame.loud));
    }
  }
  return { kept, speech, g };
}

/** Part of a signal (seconds) made gainDb louder, as a far mic hears some sounds more than others. */
function louder(x, from, to, gainDb) {
  const out = Float32Array.from(x);
  const ramp = Math.round(0.02 * SR);
  const [a, b] = [from, to].map((sec) => Math.round(sec * SR));
  const k = 10 ** (gainDb / 20);
  for (let i = Math.max(0, a - ramp); i < Math.min(out.length, b + ramp); i++) {
    const w = i < a ? (i - (a - ramp)) / ramp : i >= b ? 1 - (i - b) / ramp : 1;
    out[i] *= 1 + (k - 1) * w;
  }
  return out;
}

if (!silero) {
  for (const id of ['UNIT-GATE-01', 'UNIT-GATE-02', 'UNIT-GATE-03', 'UNIT-GATE-04', 'UNIT-GATE-05', 'UNIT-GATE-06', 'UNIT-GATE-07',
    'UNIT-SESS-01', 'UNIT-SESS-02', 'UNIT-SESS-03', 'UNIT-SESS-04', 'UNIT-SESS-05', 'UNIT-SESS-16', 'UNIT-SESS-17', 'UNIT-SESS-18',
    'UNIT-SESS-24', 'UNIT-WAIT-01', 'UNIT-WAIT-02', 'UNIT-WAIT-03', 'UNIT-TAIL-01', 'UNIT-TAIL-02', 'UNIT-TAIL-03',
    'UNIT-WAIT-04', 'UNIT-WAIT-05']) {
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
  // Issue #3: frames of a soft start the detector had not noticed yet were learned as background noise; the mic then
  // looked 10–20 dB noisier until the next long pause, and the other mic's bleed won.
  g = gate(...twoMics(lead(A), quietMic, { bleedDb: 12, lagMs: 150 }), config.crosstalkDb, 16);
  t.check('UNIT-GATE-06', 'only A talks, the detector notices A 0.5 s late: mic 2 keeps too little to make a sentence, mic 1 its speech',
    g.kept[1] < SENTENCE_FRAMES && g.kept[0] > 0.5 * g.speech[0], `kept ${g.kept} of ${g.speech} · ${g.g.report()}`);
  // Someone talks soon after Start: the few quiet frames before it must be enough for each mic's noise level, or the
  // louder mic wins.
  g = gate(...twoMics(concat(silence(0.5), A), silence(0.5 + A.length / SR), { bleedDb: 6, lagMs: 150, gain2Db: 12, noise2: -50 }));
  t.check('UNIT-GATE-07', 'A starts 0.5 s after Start, louder and noisier mic 2: mic 2 keeps too little to make a sentence',
    g.kept[1] < SENTENCE_FRAMES && g.kept[0] > 0.5 * g.speech[0], `kept ${g.kept} of ${g.speech} · ${g.g.report()}`);

  // Session with a stand-in model: same words on both mics -> one copy; different words -> both.
  // text(n, seg): what the model "hears" in the n-th sentence, seg = { mic, start, end }. mics(sec): how many mics are
  // chosen at that moment (2 when m2 is given, more with `more`: the signals of mics 3…).
  const run = async (m1, m2, text, { margin = 30, saveAudio = false, more = [], mics = () => 2 + more.length } = {}) => {
    const sent = [];
    const out = scratch('session');
    const conf = { ...structuredClone(config), transcriptsDir: out, crosstalkDb: margin };
    let calls = 0;
    let session = null;
    const stub = { supportsPrompt: false, avgMs: 10, busy: false, tryTranscribe: () => null,
      transcribe: async () => ({ text: text(++calls, [...session.transcribing.values()].at(-1)), model: 'stub', ms: 1 }) };
    session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
    session.setOptions({ saveAudio });
    const signals = [m1, m2, ...more];
    const n = Math.min(...signals.map((m) => m?.length ?? Infinity));
    for (let i = 0; i < n; i += 1600) {
      const len = Math.min(1600, n - i);
      if (!m2) {
        session.audio(m1.subarray(i, i + len));
        continue;
      }
      const count = mics(i / SR);
      const frame = new Float32Array(count * len);
      signals.slice(0, count).forEach((m, k) => frame.set(m.subarray(i, i + len), k * len));
      session.audio(frame, count);
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

  // Issue #3. On some sounds the far mic hears the other person only ~6 dB less clearly, so a stretch of their speech
  // gets through the gate there; the model writes it as other words, so the duplicate check cannot catch it.
  const SENTENCE = 'Munții Carpați sunt frumoși toamna, iar pădurile lor ascund multe animale sălbatice rare.';
  const [near, far] = twoMics(lead(A), quietMic, { bleedDb: 12, lagMs: 150 });
  s = await run(near, louder(far, 3, 3.8, 6), (n, seg) => (seg.mic === 0 ? SENTENCE : 'Bine, mulțumesc.'), { margin: config.crosstalkDb });
  t.check('UNIT-SESS-16', 'mic 2 hears 0.8 s of A only 6 dB less clearly: that stretch is not transcribed on mic 2',
    s.finals.length >= 1 && s.finals.every((f) => f.mic === 0), s.finals.map((f) => `mic${f.mic + 1}: ${f.text}`).join(' | '));
  // Issue #3. A few words of a long sentence that another mic caught, even more clearly, must not cancel the sentence.
  s = await run(near, louder(far, 3.5, 5, 16), (n, seg) => (seg.mic === 0 ? SENTENCE : 'pădurile lor ascund'), { margin: config.crosstalkDb });
  t.check('UNIT-SESS-17', 'mic 2 catches 3 words of A\'s sentence 4 dB more clearly: the whole sentence stays on mic 1',
    s.finals.some((f) => f.mic === 0 && f.text === SENTENCE), s.finals.map((f) => `mic${f.mic + 1}: ${f.text}`).join(' | '));
  // Mic 2 set to None and back (2 -> 1 -> 2 mics), and A talks the moment it is back: the gate must still know each mic's
  // noise, or the louder mic wins until the next long pause.
  const [mic1, mic2] = twoMics(concat(silence(5), A), silence(5 + A.length / SR), { bleedDb: 6, lagMs: 150, gain2Db: 12, noise2: -50 });
  s = await run(mic1, mic2, () => 'munții carpați frumoși astăzi', { margin: config.crosstalkDb, mics: (sec) => (sec >= 3 && sec < 5 ? 1 : 2) });
  t.check('UNIT-SESS-18', 'mics 2 -> 1 -> 2, A talks as mic 2 comes back (louder, noisier): A\'s sentence stays on mic 1',
    s.finals.length >= 1 && s.finals.every((f) => f.mic === 0), s.finals.map((f) => `mic${f.mic + 1} at ${f.start.toFixed(1)} s`).join(' | '));

  // Issue #44. The connection drops after 5 s of a two-mic meeting and the page resumes the transcript (D2); A talks
  // from the new connection's first moment, mic 2 louder and noisier. The new connection's gate must start with the
  // noise levels the old one learned, or (as in UNIT-GATE-05) the louder mic wins until the next long pause.
  const midMeeting = async () => {
    const out = scratch('resume-gate');
    const conf = { ...structuredClone(config), transcriptsDir: out };
    const stub = { supportsPrompt: false, avgMs: 10, busy: false, tryTranscribe: () => null,
      transcribe: async () => ({ text: 'munții carpați frumoși astăzi', model: 'stub', ms: 1 }) };
    const [m1, m2] = twoMics(concat(silence(5), A), silence(5 + A.length / SR), { bleedDb: 6, lagMs: 150, gain2Db: 12, noise2: -50 });
    const cut = 5 * SR;
    const connect = async (from, to, resume) => {
      const sent = [];
      const session = new Session({ send: (m) => sent.push(m), transcriber: stub, config: conf });
      session.setOptions({ saveAudio: true });
      if (resume) session.resume(resume, []);
      const floors = session.floors.map((f) => f.learned); // what the gate starts with
      for (let i = from; i < to; i += 1600) {
        const len = Math.min(1600, to - i);
        const frame = new Float32Array(2 * len);
        frame.set(m1.subarray(i, i + len));
        frame.set(m2.subarray(i, i + len), len);
        session.audio(frame, 2);
      }
      if (resume) {
        session.flush(); // Stop, so the last sentence reaches the page before the connection closes
        await sleep(200);
      }
      session.close(); // the first connection just drops
      return { floors, name: sent.find((m) => m.type === 'file')?.name, finals: sent.filter((m) => m.type === 'final' && m.text) };
    };
    const one = await connect(0, cut);
    const two = await connect(cut, m1.length, { name: one.name, samples: cut });
    fs.rmSync(out, { recursive: true, force: true });
    return { one, two };
  };
  const mid = await midMeeting();
  t.check('UNIT-SESS-24', 'a reconnect mid-meeting, A talks at once (mic 2 louder, noisier): the resumed gate starts with both mics\' noise levels and A\'s sentence stays on mic 1',
    mid.two.name === mid.one.name && mid.two.floors.length === 2 && mid.two.floors.every(Boolean)
      && mid.two.finals.length >= 1 && mid.two.finals.every((f) => f.mic === 0),
    `noise levels at the start: ${mid.two.floors.length ? mid.two.floors.map((l, mic) => `mic ${mic + 1} ${l ? 'kept' : 'not measured'}`).join(', ') : 'none'}; `
      + `${mid.two.finals.map((f) => `mic${f.mic + 1} at ${f.start.toFixed(1)} s`).join(' | ') || 'no lines'}${mid.two.name === mid.one.name ? '' : '; a new transcript'}`);
  // Issue #47. A line waits for another mic's overlapping sentence only while that sentence could still show it to be a
  // copy (D5, #6). The stand-in model answers between two chunks, as a fast model in real time; `at` is how many
  // seconds of audio were sent when each line arrived. A says one sentence; its words are 1.5–7.5 s.
  const timed = async (m1, m2, text, { margin = config.crosstalkDb, vad = {} } = {}) => {
    const sent = [];
    const out = scratch('wait');
    const conf = { ...structuredClone(config), transcriptsDir: out, crosstalkDb: margin };
    Object.assign(conf.vad, vad);
    let session = null;
    let at = 0;
    const stub = { supportsPrompt: false, avgMs: 10, tryTranscribe: () => null,
      transcribe: async () => ({ text: text([...session.transcribing.values()].at(-1)), model: 'stub', ms: 1 }) };
    session = new Session({ send: (m) => sent.push({ ...m, at }), transcriber: stub, config: conf });
    for (let i = 0; i + 1600 <= Math.min(m1.length, m2.length); i += 1600) {
      const frame = new Float32Array(3200);
      frame.set(m1.subarray(i, i + 1600));
      frame.set(m2.subarray(i, i + 1600), 1600);
      at = (i + 1600) / SR;
      session.audio(frame, 2);
      await sleep(0);
    }
    session.flush();
    await sleep(50);
    session.close();
    fs.rmSync(out, { recursive: true, force: true });
    return sent.filter((m) => m.type === 'final' && m.text);
  };
  const SAID_A = 'Bună ziua, mă numesc Ioana și astăzi vreau să vă povestesc despre o călătorie în munții Carpați.';
  const SAID_B = 'A fost o experiență frumoasă, deși ploaia ne-a ținut în cabană două zile. Ce părere aveți, mergem și la anul?';
  const lines = (finals) => finals.map((f) => `mic${f.mic + 1} "${f.text.slice(0, 24)}" at ${f.at.toFixed(1)} s`).join(' | ') || 'none';
  // B says a word (0.6 s) in the middle of A's sentence; the model writes "Da.". One word can never be a copy.
  let w = await timed(...twoMics(lead(A), concat(silence(4.5), B.subarray(0, Math.round(0.6 * SR))), { lagMs: 150 }),
    (seg) => (seg.mic === 0 ? SAID_A : 'Da.'));
  let reply = w.find((f) => f.mic === 1);
  t.check('UNIT-WAIT-01', 'B says "Da." in the middle of A\'s sentence: the line comes at once, before A has finished (it used to wait for A\'s whole sentence)',
    reply?.text === 'Da.' && reply.at < 8.3 && w.some((f) => f.mic === 0 && f.text === SAID_A), lines(w));
  // B starts 1 s before A has finished (A's words end at 7.5 s, B's start at 6.5 s) and talks on for 8 s: A's line must
  // not wait for B's sentence, which mic 2 heard more clearly only at A's very end.
  w = await timed(...twoMics(lead(A), concat(silence(5.9), B), { lagMs: 150 }), (seg) => (seg.mic === 0 ? SAID_A : SAID_B));
  const first = w.find((f) => f.mic === 0);
  t.check('UNIT-WAIT-02', 'B starts talking 1 s before A has finished: A\'s line comes when A has finished, before B\'s (it used to wait for B\'s sentence)',
    first?.text === SAID_A && first.at < 9.5 && first === w[0] && w.some((f) => f.mic === 1 && f.text === SAID_B), lines(w));
  // The wait itself stays where it matters: mic 2 picks up the first 3.5 s of A, 6 dB less clearly, and that part ends
  // before A's sentence does. It must still wait for A's line, and is then dropped as a copy.
  const [whole] = twoMics(lead(A), silence(1.5 + A.length / SR), { bleedDb: 6 });
  const [, part] = twoMics(lead(A.subarray(0, Math.round(3.5 * SR))), silence(1.5 + A.length / SR), { bleedDb: 6 });
  w = await timed(whole, part, (seg) => (seg.mic === 0 ? SAID_A : 'Bună ziua, mă numesc Ioana și astăzi vreau'), { margin: 30 });
  t.check('UNIT-WAIT-03', 'mic 2 picks up the start of A\'s sentence and finishes first: it still waits for mic 1\'s line and is dropped as a copy',
    w.length === 1 && w[0].mic === 0 && w[0].text === SAID_A, lines(w));

  // Issue #46. With three mics the last word of a sentence ("curățenie.", "în octombrie.") reaches the two far mics
  // only ~3 dB less clearly than the near one: the far mics' detector and gate keep it, the whole-sentence check lets it
  // through (under half of "Mic separation"), and one word in common was too few for the duplicate check.
  const spans = (r) => r.finals.map((f) => `mic${f.mic + 1} ${f.start.toFixed(1)}–${f.end.toFixed(1)} s: ${f.text}`).join(' | ');
  const [mic3, far1] = twoMics(lead(A), quietMic, { bleedDb: 12 });
  const [, far2] = twoMics(lead(A), quietMic, { bleedDb: 12, seed: 11 });
  const lastWord = [1.5 + 5.45, 1.5 + 6]; // A's last word, in session seconds
  s = await run(louder(far1, ...lastWord, 9), louder(far2, ...lastWord, 9), (n, seg) => (seg.mic === 2 ? SENTENCE : 'rare.'),
    { margin: config.crosstalkDb, more: [mic3] });
  t.check('UNIT-TAIL-01', 'three mics, only the person on mic 3 talks, mics 1 and 2 hear the last word 3 dB less clearly: no line on mics 1 and 2',
    s.finals.some((f) => f.mic === 2 && f.text === SENTENCE) && s.finals.every((f) => f.mic === 2), spans(s));
  // Issue #46. A stops, B on mic 2 goes on 0.3 s later, and mic 1 hears B's first second only 8 dB less clearly: the gate
  // lets enough of it through to keep A's sentence going, and the model wrote B's words at the end of A's line.
  const aEnd = 1.5 + 5.95; // A's speech ends here
  const bStart = aEnd + 0.3; // B's starts 0.4 s into its clip
  const [glued1, glued2] = twoMics(concat(silence(1.5), A.subarray(0, Math.round(5.95 * SR))), concat(silence(bStart - 0.4), B), { bleedDb: 12 });
  s = await run(louder(glued1, bStart, bStart + 1.2, 4), glued2, (n, seg) => `fraza${n} mic${seg.mic + 1}`, { margin: config.crosstalkDb });
  const lineA = s.finals.find((f) => f.mic === 0);
  t.check('UNIT-TAIL-02', 'B goes on 0.3 s after A stops, mic 1 hears B\'s first second 8 dB less clearly: A\'s line ends before B starts',
    lineA && lineA.end < bStart + 0.2 && s.finals.filter((f) => f.mic === 0).length === 1, spans(s));
  // Issue #46: the cut must not take the speech of someone who goes on, softly (6 dB under B), while B talks.
  const [soft1, soft2] = twoMics(lead(A.map((x) => x / 2)), concat(silence(4.5), B), { bleedDb: 12 });
  s = await run(soft1, soft2, (n, seg) => `fraza${n} mic${seg.mic + 1}`, { margin: config.crosstalkDb });
  const soft = s.finals.find((f) => f.mic === 0);
  t.check('UNIT-TAIL-03', 'A talks 6 dB softer than B, who starts 3 s into A\'s sentence: A\'s line keeps all of A\'s speech',
    soft && soft.end >= aEnd && s.finals.filter((f) => f.mic === 0).length === 1, spans(s));

  // #46 with #47: a line of one word waits for the other mic's sentence only while it could be that sentence's last
  // word. In real time (timed), mic 2 hears A's last word 3 dB less clearly ("rare."): it must wait for A's line and be
  // dropped. B's one-word reply ("Bine.") said inside A's sentence, while A talks on, comes at once.
  w = await timed(louder(far1, ...lastWord, 9), mic3, (seg) => (seg.mic === 1 ? SENTENCE : 'rare.'));
  t.check('UNIT-WAIT-04', 'in real time, mic 1 hears A\'s last word 3 dB less clearly than mic 2: the one-word line waits for A\'s line and is dropped',
    w.length === 1 && w[0].mic === 1 && w[0].text === SENTENCE, lines(w));
  // A pause of 0.5 s ends a sentence (Settings): the reply is finished before A's sentence has gone on far enough past
  // it, so it is released only as A's speech goes on (audio() asks again).
  w = await timed(...twoMics(lead(A), concat(silence(4.5), B.subarray(0, Math.round(0.6 * SR))), { lagMs: 150 }),
    (seg) => (seg.mic === 0 ? SAID_A : 'Bine.'), { vad: { silenceMs: 500 } });
  reply = w.find((f) => f.mic === 1);
  t.check('UNIT-WAIT-05', 'B says "Bine." in the middle of A\'s sentence while A talks on (pause length 0.5 s): the one-word line comes at once, before A has finished',
    reply?.text === 'Bine.' && reply.at < 8.3 && w.some((f) => f.mic === 0 && f.text === SAID_A), lines(w));
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

// ---------- the benchmark suite (scripts/benchmark-suite.js): its scores, audio, plan and a whole run on a stand-in ----------
{
  // UNIT-BENCH-01: steadiness of a live line, the way Canary revises it (as UNIT-STEADY-01's guesses).
  const shown = ['Azi vorbim', 'Astăzi vorbim despre', 'Astăzi vorbim despre model', 'Astăzi vorbim despre modelele noi'];
  const s = liveSteadiness(shown, 'Astăzi vorbim despre modelele noi de azi.');
  const sum = sumSteadiness([s]);
  t.check('UNIT-BENCH-01', 'live-text steadiness: "Azi" and "model" taken back = 3 words erased in 2 of 5 updates; 5 of the final\'s 7 words were on screen',
    s.erased === 3 && s.rewrites === 2 && s.updates === 5 && s.covered === 5 && s.finalWords === 7 && Math.abs(sum.normalizedErasure - 3 / 7) < 1e-9 && sum.rewriteShare === 0.4 && Math.abs(sum.coverage - 5 / 7) < 1e-9,
    JSON.stringify(s));
  const steady = liveSteadiness(['Astăzi', 'Astăzi vorbim despre', 'Astăzi vorbim despre modelele noi'], 'Astăzi vorbim despre modelele noi.');
  t.check('UNIT-BENCH-01', 'a line that only grows erases nothing, and a final equal to it is fully covered', steady.erased === 0 && steady.rewrites === 0 && steady.covered === steady.finalWords, JSON.stringify(steady));
  t.check('UNIT-BENCH-01', 'no live text at all: nothing erased, nothing covered', JSON.stringify(liveSteadiness([], 'ana are mere')) === JSON.stringify({ erased: 0, rewrites: 0, updates: 1, covered: 0, finalWords: 3 }));

  // UNIT-BENCH-02: the fixed clip selection.
  const all = Array.from({ length: 883 }, (_, i) => ({ file: `${String(i).padStart(4, '0')}.wav`, ref: 'x', seconds: 10 }));
  const hundred = selectClips(all, 100);
  const again = selectClips([...all].reverse().sort((a, b) => (a.file < b.file ? -1 : 1)), 100);
  const gaps = hundred.slice(1).map((c, i) => Number(c.file.slice(0, 4)) - Number(hundred[i].file.slice(0, 4)));
  t.check('UNIT-BENCH-02', '100 of 883 clips: the same clips every time, spread evenly (8 or 9 apart), the first one first; asking for more than there are gives all',
    hundred.length === 100 && hundred[0] === all[0] && gaps.every((g) => g === 8 || g === 9) && JSON.stringify(hundred) === JSON.stringify(again) && selectClips(all, 2000).length === 883 && selectClips(all, 0).length === 0,
    `gaps ${Math.min(...gaps)}–${Math.max(...gaps)}`);

  // UNIT-BENCH-03: the plan fits the model's share of the time.
  const roomy = planStages(all, 0.02, 3600); // 50× real-time, an hour
  const tight = planStages(all, 0.5, 120); // 2× real-time, two minutes
  const sized = planStages(all, 0.02, 3600, { accuracy: 30, live: 5 });
  t.check('UNIT-BENCH-03', 'a fast model in an hour keeps the full stages; a slow one in two minutes shrinks every stage, never below its minimum; asked-for sizes are kept when they fit',
    roomy.fits && roomy.sizes.accuracy === STAGES.accuracy.full && roomy.sizes.live === STAGES.live.full
      && !tight.fits && tight.sizes.accuracy < STAGES.accuracy.full && tight.sizes.accuracy >= STAGES.accuracy.min && tight.sizes.live >= STAGES.live.min && tight.sizes.robustness >= STAGES.robustness.min && tight.sizes.silence === STAGES.silence.full
      && sized.sizes.accuracy === 30 && sized.sizes.live === 5,
    `roomy ${JSON.stringify(roomy.sizes)} ${roomy.estimatedSec.toFixed(0)} s; tight ${JSON.stringify(tight.sizes)} ${tight.estimatedSec.toFixed(0)} s`);

  // UNIT-BENCH-04: the synthetic conditions.
  const tone = Float32Array.from({ length: 3 * SR }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR));
  const noisy = withNoise(tone, 20);
  const added = Float32Array.from(noisy, (v, i) => v - tone[i]);
  const snr = db(rms(tone) / rms(added));
  const quiet = withGain(tone, -20);
  const roomy2 = inRoom(tone);
  const same = withNoise(tone, 20);
  t.check('UNIT-BENCH-04', 'noise at 20 dB SNR measures 20 dB (±0.5); −20 dB gain is a tenth of the level; the room keeps the level; the same seed gives the same audio; silence is zeros',
    Math.abs(snr - 20) < 0.5 && Math.abs(rms(quiet) / rms(tone) - 0.1) < 0.005 && Math.abs(rms(roomy2) / rms(tone) - 1) < 0.05 && roomy2.length > tone.length
      && noisy.every((v, i) => v === same[i]) && benchSilence(2).length === 2 * SR && benchSilence(2).every((v) => v === 0) && joinClips([tone, tone], 0.5).length === 2 * tone.length + SR / 2,
    `SNR ${snr.toFixed(2)} dB, quiet ×${(rms(quiet) / rms(tone)).toFixed(3)}, room ×${(rms(roomy2) / rms(tone)).toFixed(3)}`);

  // UNIT-BENCH-05: the computer's description, nothing personal.
  const info = await machineInfo();
  const text = JSON.stringify(info);
  t.check('UNIT-BENCH-05', 'machine info has the OS, CPU, memory, GPU list, compute devices, Node and app version, and no user or host name',
    info.os.platform === process.platform && info.cpu.cores > 0 && info.ramGb > 0 && Array.isArray(info.gpus) && Array.isArray(info.compute) && info.node === process.version && typeof info.app.version === 'string'
      && !text.includes(os.hostname()) && !text.includes(os.userInfo().username) && describeMachine(info).includes(`${info.ramGb} GB`),
    describeMachine(info));

  // UNIT-BENCH-06..08: a whole run on a stand-in model over a three-clip set cut from the fixture.
  const set = scratch('bench');
  fs.mkdirSync(path.join(set, 'test'));
  const fixture = loadWav(FIXTURE);
  const cuts = [[0, 6.8, 'Bună ziua dragi colegi, astăzi vorbim despre munții noștri.'], [7.3, 11.2, 'Vremea este frumoasă la munte.'], [11.2, 15.9, 'Cabana avea ferestre mari spre vale.']];
  const rows = cuts.map(([from, to, ref], i) => {
    const samples = fixture.subarray(Math.round(from * SR), Math.round(to * SR));
    const file = `clip-${i}.wav`;
    saveWav(path.join(set, 'test', file), samples);
    return { file, ref, samples };
  });
  fs.writeFileSync(path.join(set, 'test.tsv'), rows.map((r, i) => [i, r.file, r.ref, r.ref.toLowerCase(), '', r.samples.length, 'FEMALE'].join('\t')).join('\n'));
  const clips = loadClips(set);
  let current = null;
  const load = (c) => {
    current = { samples: clipSamples(c, set), ref: c.ref };
    return current.samples;
  };
  // The stand-in: the reference for a whole clip (under any condition); for the audio so far, that many words, the
  // unfinished last one guessed wrong (so the raw live line rewrites it each time, as a real model does); nothing for
  // silence or noise.
  let loadFails = false;
  let guessNo = 0;
  const isPrefix = (samples) => current && samples.length < current.samples.length && samples.subarray(0, 200).every((v, i) => v === current.samples[i]);
  class Bench extends Transcriber {
    createEngine() {
      return {
        device: 'CPU',
        load: async () => { if (loadFails) throw new Error('stand-in cannot load'); },
        unload: async () => {},
        kill: () => {},
        transcribe: async (samples) => {
          await sleep(2); // so the speeds are numbers
          const whole = rows.find((r) => r.samples.length === samples.length || r.samples.length + 1072 === samples.length); // the room adds 67 ms
          if (whole) return { text: whole.ref };
          if (isPrefix(samples)) {
            const words = current.ref.split(' ');
            const out = words.slice(0, Math.round((words.length * samples.length) / current.samples.length));
            if (out.length) out[out.length - 1] = `xx${guessNo++}`; // never the same wrong guess twice
            return { text: out.join(' ') };
          }
          const joined = rows.map((r) => r.ref).join(' ');
          return { text: samples.length > 12 * SR && rms(samples) > 0.001 ? joined : '' }; // joined clips (16 s), or silence
        },
      };
    }
  }
  const keepKey = config.elevenlabs.apiKey;
  config.elevenlabs.apiKey = 'stand-in'; // makes the cloud model count as installed; the engine is the stand-in above
  const model = findModel('elevenlabs-scribe-v2');
  const logError = console.error;
  console.error = () => {};
  let full;
  let late;
  let broken;
  try {
    full = await runModel({ model, transcriber: new Bench(structuredClone(config)), clips, load, budgetSec: 600, deadline: Date.now() + 60000 });
    late = await runModel({ model, transcriber: new Bench(structuredClone(config)), clips, load, budgetSec: 600, deadline: Date.now() - 1 });
    loadFails = true;
    broken = await runModel({ model, transcriber: new Bench(structuredClone(config)), clips, load });
  } finally {
    config.elevenlabs.apiKey = keepKey;
    console.error = logError;
    fs.rmSync(set, { recursive: true, force: true });
  }
  const st = full.stages;
  t.check('UNIT-BENCH-06', 'a whole run on a stand-in: every stage has its numbers; a model that writes the reference scores 0 % WER, on every condition and on the joined long sentences; silence gets no words',
    !full.error && !full.truncated && full.load.device === 'CPU' && st.accuracy.done === 3 && st.accuracy.werStrict === 0 && st.accuracy.speed > 0 && Object.keys(st.accuracy.perClip).length === 3
      && Object.keys(st.robustness.conditions).length === CONDITIONS.length + 1 && Object.values(st.robustness.conditions).every((c) => c.werPlain === 0)
      && st.length.lengths.length >= 1 && st.length.lengths.every((l) => l.werPlain === 0 && l.msPerSentence >= 0) && st.silence.inputs.length === SILENCE_INPUTS.length && st.silence.hallucinated === 0,
    `${full.error ?? ''} accuracy ${JSON.stringify({ done: st.accuracy?.done, wer: st.accuracy?.werStrict })}, robustness ${Object.keys(st.robustness?.conditions ?? {}).join('/')}, lengths ${st.length?.lengths.map((l) => l.target).join('/')}, silence ${st.silence?.hallucinated}`);
  const lv = st.live;
  t.check('UNIT-BENCH-06', 'live text on the app\'s schedule: several guesses per sentence from 0.6 s on; the raw line rewrites its wrongly guessed last word (erasure > 0), Steady live text never does (0) and still shows most of the sentence before the final',
    lv.done === 3 && lv.guessesPerSentence >= 3 && lv.sentences.every((x) => x.guesses[0].at === 0.6 && x.guesses.every((g, i) => i === 0 || g.at >= x.guesses[i - 1].at + 0.5))
      && lv.raw.normalizedErasure > 0 && lv.steady.normalizedErasure === 0 && lv.steady.coverage > 0.5 && lv.raw.coverage > 0.5 && lv.firstLiveSec.raw >= 0.6 && lv.finalMs >= 0,
    `${lv.guessesPerSentence?.toFixed(1)} guesses; erasure raw ${lv.raw?.normalizedErasure.toFixed(2)} steady ${lv.steady?.normalizedErasure.toFixed(2)}; coverage raw ${lv.raw?.coverage.toFixed(2)} steady ${lv.steady?.coverage.toFixed(2)}; first live ${lv.firstLiveSec?.raw} s`);
  t.check('UNIT-BENCH-07', 'past the deadline: the model still loads and is warmed up, every stage stops at once and says so, nothing throws; a model that cannot load gives an error, not a crash',
    late.truncated && late.load && late.stages.accuracy.done === 0 && late.stages.accuracy.truncated && late.stages.live.truncated && late.stages.silence.truncated && !late.error
      && broken.error && /cannot load/.test(broken.error) && !broken.stages.accuracy,
    `late: ${late.stages.accuracy?.done} clips, truncated ${late.truncated}; broken: ${broken.error}`);
  const run = { name: 'unit', startedAt: new Date().toISOString(), minutes: 10, parallel: 2, machine: info, dataset: { clips: 3 }, models: [full, broken], seconds: 1 };
  const report = renderReport(run);
  const args = parseArgs(['--minutes', '500', '--models', 'a, b', '--clips', '10', '--label', 'My Laptop/1', '--parallel', '0']);
  t.check('UNIT-BENCH-08', 'the report lists the model in every section, the machine, the parallel warning and the model that could not run; the command line caps the budget at 120 min and 1 model at a time',
    ['## Accuracy and speed', '## Live text', '## Noise, a quiet speaker', '## Silence and noise alone', '## Models that could not run', model.label, describeMachine(info), 'side by side', 'cannot load'].every((x) => report.includes(x))
      && args.minutes === 120 && args.parallel === 1 && JSON.stringify(args.models) === '["a","b"]' && args.sizes.accuracy === 10 && args.sizes.live === STAGES.live.full && args.label === 'My-Laptop-1' && parseArgs([]).minutes === 60,
    `${report.length} chars; ${JSON.stringify({ minutes: args.minutes, parallel: args.parallel, label: args.label })}`);
}

// ---------- the stress tier's memory check (#48) ----------
{
  // The server in the 3.9-hour meeting of the stress run on c10baf5, one sample per 10 min of meeting: a rise of 165 MB
  // after the break that comes back down, which a straight line through the samples read as 29 MB per hour.
  const hump = [276, 271, 291, 278, 292, 322, 298, 325, 358, 317, 344, 422, 392, 431, 435, 436, 397, 413, 414, 389, 372, 350, 296, 284]
    .map((value, i) => ({ at: (i + 1) * 600 - 10, value }));
  const h = memoryCheck(hump, 1800);
  // As long, with ups and downs, over a floor that rises 15 MB per hour.
  const leak = hump.map(({ at }, i) => ({ at, value: 280 + (15 * at) / 3600 + [0, 30, 10, 60, 20][i % 5] }));
  const l = memoryCheck(leak, 1800);
  // 40 minutes after warm-up: each window is a third of it.
  const short = Array.from({ length: 40 }, (_, i) => ({ at: 600 + i * 60, value: 200 + (i % 7) }));
  const s = memoryCheck(short, 600);
  t.check('UNIT-MEM-01', 'the stress tier\'s memory check: a rise that comes back down is not growth, a rising floor is; a short run judges its thirds',
    h.from === 278 && h.to === 284 && h.peak === 436 && h.peakOver === 144 && h.perHour < 10 && l.growth > 30 && l.perHour > 10
      && s.span < 1 && s.growth === 0 && memoryCheck(short.slice(0, 5), 600).span === 0,
    `hump: low point ${h.from} → ${h.to} MB, ${h.perHour.toFixed(1)} MB/h, peak ${h.peakOver} MB above the first 30 min; `
      + `rising floor: ${l.from.toFixed(0)} → ${l.to.toFixed(0)} MB, ${l.perHour.toFixed(1)} MB/h; short: ${s.growth} MB over ${s.span.toFixed(2)} h`);
}

fs.rmSync(dir, { recursive: true, force: true });
t.finish();
