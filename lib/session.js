import fs from 'node:fs';
import path from 'node:path';
import { Segmenter } from './segmenter.js';
import { createDetector } from './vad.js';
import { CrosstalkGate } from './crosstalk.js';
import { resultToText, contextTail } from './text.js';
import { sharedWords } from './wer.js';
import { WavWriter } from './wav.js';

const MIN_PARTIAL_SEC = 0.6;
const MIN_OVERLAP_SEC = 0.5; // sentences on two mics overlapping less than this are just people taking turns
const SAME_WORDS = 0.5; // share of words two mics must both have caught to be the same speech
const KEEP_SEC = 120; // published sentences are kept this long to compare later ones against
const REPORT_FRAMES = 312; // ~10 s: how often DEBUG logs what the crosstalk gate did

export const fmtTime = (sec) => {
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};

export const fileStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

/**
 * Claims a name in `dir` for a new transcript: `stamp`, or `stamp`-2, -3, … when that is taken. Stamps have whole
 * seconds, so they repeat: two recordings started in the same second (two tabs, or the desktop app and `npm start`,
 * which share transcripts/), Clear in the same second, the clock going back an hour at the end of summer time.
 * Creating the name's .txt exclusively ('wx') is the claim, so no two transcripts get one name, even from two servers.
 * A name with audio but no .txt (saved before this claim existed, or its .txt deleted) is skipped too.
 */
function claimName(dir, stamp, maxMics) {
  for (let n = 1; ; n++) {
    const name = n > 1 ? `${stamp}-${n}` : stamp;
    const base = path.join(dir, name);
    try {
      fs.closeSync(fs.openSync(`${base}.txt`, 'wx'));
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      throw err;
    }
    const wavs = [`${base}.wav`, ...Array.from({ length: maxMics }, (_, mic) => `${base}-mic${mic + 1}.wav`)];
    if (!wavs.some((file) => fs.existsSync(file))) return name;
    fs.rmSync(`${base}.txt`); // that audio is another recording's: leave the name to it
  }
}

const overlap = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start);

/**
 * One browser connection: receives 16 kHz Float32 audio from one or more mics, segments each mic into utterances,
 * sends rolling live guesses while someone speaks and a final transcript after each pause.
 * Final lines go to transcripts/<stamp>.txt; with "save audio" on, the audio goes to <stamp>.wav (one file per mic).
 * The .txt is created with the transcript's first file, so it is empty until the first line: it claims the name.
 */
export class Session {
  constructor({ send, transcriber, config }) {
    this.send = send;
    this.transcriber = transcriber;
    this.config = config;
    this.transcript = '';
    this.finalized = new Set();
    this.finalsPending = 0;
    this.partialBusy = false;
    this.stamp = null;
    this.textFile = null;
    this.saveAudio = false;
    this.audioFiles = []; // per mic: { file, writer }
    this.nextId = 1; // shared by all mics, so ids follow the order people started speaking
    this.mics = []; // per mic: { mic, segmenter, lastPartialAt, partialWall }
    this.gate = null; // with several mics: decides which mic each bit of speech belongs to
    this.transcribing = new Map(); // id -> { mic, start, end } waiting for the model
    this.done = []; // transcribed sentences, until published and then for KEEP_SEC
    this.closed = false;
    this.#layout(1);
  }

  get detector() {
    return this.mics[0].segmenter.detector.name;
  }

  /** Audio of `count` mics, one after the other, all covering the same moment. */
  audio(samples, count = 1) {
    // After close() (e.g. while the server drains on Ctrl+C the page keeps sending) the voice detectors belong to
    // the pool again, and saving would reopen the WAVs and wipe them.
    if (this.closed) return;
    if (count !== this.mics.length) this.#layout(count);
    const length = samples.length / count;
    const chunks = this.mics.map((_, mic) => samples.subarray(mic * length, (mic + 1) * length));
    if (this.saveAudio) this.#saveAudio(chunks);
    if (this.gate) {
      const frames = this.mics.map(({ segmenter }, mic) => segmenter.analyze(chunks[mic]));
      for (let i = 0; i < frames[0].length; i++) this.#feed(this.gate.push(frames.map((f) => f[i])));
      if (process.env.DEBUG && frames[0].length && frames[0].at(-1).index % REPORT_FRAMES < frames[0].length) {
        console.log(`[mics] ${this.gate.report()}`);
      }
    } else {
      this.mics[0].segmenter.push(chunks[0]);
    }
    this.#maybePartial();
  }

  /** Speech-detection settings changed in the Settings panel: apply them without restarting. */
  retune() {
    for (const { segmenter } of this.mics) {
      segmenter.setTiming(this.config.vad);
      segmenter.detector.setThreshold?.(this.config.vad.sileroThreshold);
    }
    this.gate?.setMargin(this.config.crosstalkDb);
  }

  setOptions({ saveAudio }) {
    if (saveAudio !== undefined) this.saveAudio = Boolean(saveAudio);
  }

  /** End the current utterances now (Stop pressed). */
  flush() {
    this.gate?.drain().forEach((frames) => this.#feed(frames));
    for (const { segmenter } of this.mics) segmenter.flush();
  }

  /** Clear pressed: forget the context and start new transcript/audio files. */
  reset() {
    this.transcript = '';
    this.#closeFiles();
  }

  close() {
    if (this.closed) return; // the connection closing after a shutdown already closed it
    this.closed = true;
    this.send = () => {};
    this.flush(); // still transcribe and save the last utterance
    this.#releaseDetectors();
    for (const audio of this.audioFiles) audio?.writer.close();
    this.audioFiles = [];
  }

  /** The number of mics changed (or the session starts): finish what is being said, then start fresh. */
  #layout(count) {
    const startFrame = Math.max(0, ...this.mics.map(({ segmenter }) => segmenter.frameIndex));
    // Audio not yet cut into frames carries over, or the clock would fall behind by up to a frame per change.
    // A mic that was not there gets silence, so frame N is the same moment on every mic.
    const unframed = this.mics[0]?.segmenter.leftover.length ?? 0;
    const leftovers = this.mics.map(({ segmenter }) => segmenter.leftover);
    this.flush();
    this.#releaseDetectors(); // first, so the new mics get them back
    this.mics = Array.from({ length: count }, (_, mic) => this.#channel(mic, startFrame, leftovers[mic] ?? new Float32Array(unframed)));
    this.gate = count > 1 ? new CrosstalkGate(count, this.config.crosstalkDb) : null;
  }

  /** Give the mics' voice detectors back for reuse (#4): a dropped one keeps ~3 MB until V8 happens to collect it. */
  #releaseDetectors() {
    for (const { segmenter } of this.mics) segmenter.detector.release?.();
  }

  #channel(mic, startFrame, leftover) {
    const ch = { mic, lastPartialAt: 0, partialWall: 0 };
    ch.segmenter = new Segmenter({
      ...this.config.vad,
      detector: createDetector(this.config.vad),
      startFrame,
      leftover,
      newId: () => this.nextId++,
      onSpeechStart: (id) => {
        ch.lastPartialAt = 0;
        this.send({ type: 'vad', mic, speaking: true, id });
      },
      onSegment: (seg) => {
        this.send({ type: 'vad', mic, speaking: false, id: seg.id });
        this.#finalize(mic, seg);
      },
      onDiscard: (id) => {
        this.finalized.add(id);
        this.send({ type: 'vad', mic, speaking: false, id });
        this.send({ type: 'final', mic, id, text: '' });
        this.#settle(); // a sentence on another mic may have been waiting for this one
      },
    });
    return ch;
  }

  #feed(frames) {
    frames?.forEach((frame, mic) => this.mics[mic].segmenter.feed(frame));
  }

  #prompt() {
    if (!this.transcriber.supportsPrompt) return '';
    return this.transcript ? contextTail(this.transcript) : this.config.whisper.initialPrompt;
  }

  #partialInterval() {
    // Slow models get fewer live guesses so they don't delay the final text.
    const avg = this.transcriber.avgMs ?? 0;
    return Math.max(this.config.partialEverySec, (2 * avg) / 1000);
  }

  #maybePartial() {
    if (this.partialBusy || this.finalsPending > 0) return;
    // Two mics live at once take turns: the one whose live text is oldest goes first.
    const interval = this.#partialInterval();
    const due = this.mics
      .map((ch) => ({ ch, cur: ch.segmenter.current() }))
      .filter(({ ch, cur }) => cur && cur.duration >= MIN_PARTIAL_SEC && cur.duration - ch.lastPartialAt >= interval)
      .sort((a, b) => a.ch.partialWall - b.ch.partialWall)[0];
    if (!due) return;

    const { ch, cur } = due;
    const job = this.transcriber.tryTranscribe(cur.samples(), { prompt: this.#prompt(), fallback: false });
    if (!job) return; // model busy; try again on the next audio chunk
    this.partialBusy = true;
    ch.lastPartialAt = cur.duration;
    ch.partialWall = Date.now();
    job
      .then((result) => {
        if (this.finalized.has(cur.id)) return;
        const text = resultToText(result);
        if (text) this.send({ type: 'partial', mic: ch.mic, id: cur.id, start: cur.start, text });
      })
      .catch(() => {}) // a failed live guess is harmless; the final will report errors
      .finally(() => {
        this.partialBusy = false;
      });
  }

  async #finalize(mic, { id, samples, start, end }) {
    this.finalized.add(id);
    this.finalsPending++;
    const seg = { id, mic, start, end, text: '' };
    this.transcribing.set(id, seg);
    try {
      const result = await this.transcriber.transcribe(samples, { prompt: this.#prompt(), fallback: true });
      Object.assign(seg, { text: resultToText(result), model: result.model, ms: Math.round(result.ms) });
      if (process.env.DEBUG) {
        const who = this.mics.length > 1 ? ` mic ${mic + 1}` : '';
        console.log(`[final #${id}${who}] ${result.model} ${(end - start).toFixed(1)} s audio, ${seg.ms} ms: ${seg.text || '(empty)'}`);
      }
    } catch (err) {
      this.send({ type: 'error', message: err.message });
    } finally {
      this.finalsPending--;
      this.transcribing.delete(id);
    }
    this.done.push(seg);
    this.#settle();
  }

  /**
   * Publish transcribed sentences. With several mics, a sentence first waits until every sentence overlapping it
   * on another mic is transcribed too: when two mics caught the same words, only the mic that heard them more
   * clearly keeps them, because the other one just picked up the other speaker.
   */
  #settle() {
    const ready = this.done.filter((seg) => !seg.published && !this.#waiting(seg)).sort((a, b) => a.id - b.id);
    for (const seg of ready) {
      seg.published = true;
      const echo = seg.text && this.#heardBetterElsewhere(seg);
      if (echo && process.env.DEBUG) console.log(`[final #${seg.id} mic ${seg.mic + 1}] dropped, another mic heard it more clearly`);
      const text = echo ? '' : seg.text;
      const { id, mic, start, end, model, ms } = seg;
      this.send({ type: 'final', mic, id, start, end, text, model, ms });
      if (!text) continue;
      this.transcript = `${this.transcript} ${text}`.trim();
      this.#saveLine(`[${fmtTime(start)}] ${this.mics.length > 1 ? `Mic ${mic + 1}: ` : ''}${text}\n`);
    }
    const latest = Math.max(...this.done.map((seg) => seg.end));
    this.done = this.done.filter((seg) => !seg.published || seg.end > latest - KEEP_SEC);
  }

  /** Another mic is still speaking, or still being transcribed, at the same time as this sentence. */
  #waiting(seg) {
    if (!this.gate) return false;
    const speaking = this.mics.some(({ mic, segmenter }) => {
      const cur = segmenter.current();
      return mic !== seg.mic && cur && seg.end - Math.max(seg.start, cur.start) >= MIN_OVERLAP_SEC;
    });
    if (speaking) return true;
    return [...this.transcribing.values()].some((t) => t.mic !== seg.mic && overlap(seg, t) >= MIN_OVERLAP_SEC);
  }

  /** The same words were transcribed on another mic at the same time, and that mic heard them more clearly. */
  #heardBetterElsewhere(seg) {
    if (!this.gate) return false;
    return this.done.some((other) => {
      if (other.mic === seg.mic || !other.text || overlap(seg, other) < MIN_OVERLAP_SEC) return false;
      const { count, ratio } = sharedWords(seg.text, other.text);
      if (count < 2 || ratio < SAME_WORDS) return false;
      const start = Math.max(seg.start, other.start);
      const end = Math.min(seg.end, other.end);
      const mine = this.gate.clarity(seg.mic, start, end);
      const theirs = this.gate.clarity(other.mic, start, end);
      return theirs > mine || (theirs === mine && other.mic < seg.mic); // a tie (the same mic picked twice) keeps one
    });
  }

  #base() {
    if (!this.stamp) {
      fs.mkdirSync(this.config.transcriptsDir, { recursive: true });
      this.stamp = claimName(this.config.transcriptsDir, fileStamp(new Date()), this.config.maxMics); // creates the .txt
    }
    return path.join(this.config.transcriptsDir, this.stamp);
  }

  #saveLine(line) {
    try {
      if (!this.textFile) {
        this.textFile = `${this.#base()}.txt`;
        this.send({ type: 'file', kind: 'text', path: path.relative(process.cwd(), this.textFile) });
      }
      fs.appendFileSync(this.textFile, line);
    } catch (err) {
      this.send({ type: 'error', message: `Could not save transcript: ${err.message}` });
    }
  }

  #saveAudio(chunks) {
    try {
      chunks.forEach((chunk, mic) => this.#audioWriter(mic).append(chunk));
    } catch (err) {
      // A full disk or a drive that went away stops the recording, never the transcript. The files keep what was
      // written; ticking Save audio again carries on in them.
      this.saveAudio = false;
      this.send({ type: 'error', message: `Could not save audio: ${err.message}` });
    }
  }

  #audioWriter(mic) {
    if (!this.audioFiles[mic]) {
      // One file per mic, opened once per transcript, so changing mics never overwrites a recording.
      const file = `${this.#base()}${this.mics.length > 1 ? `-mic${mic + 1}` : ''}.wav`;
      this.audioFiles[mic] = { file, writer: new WavWriter(file) };
      this.send({ type: 'file', kind: 'audio', mic, path: path.relative(process.cwd(), file) });
    }
    return this.audioFiles[mic].writer;
  }

  #closeFiles() {
    for (const audio of this.audioFiles) audio?.writer.close();
    this.audioFiles = [];
    this.textFile = null;
    this.stamp = null;
  }
}
