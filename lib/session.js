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
const SAME_WORDS = 0.5; // share of a line's words another mic must have caught too for the line to be a copy
const OTHER_SPEAKER = 0.5; // share of "Mic separation": a whole sentence another mic heard this much more clearly is the other person's
const KEEP_SEC = 120; // published sentences are kept this long to compare later ones against
const REPORT_FRAMES = 312; // ~10 s: how often DEBUG logs what the crosstalk gate did

export const fmtTime = (sec) => {
  const s = Math.floor(sec);
  const hh = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
};

const fileStamp = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

const overlap = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start);

/**
 * One browser connection: receives 16 kHz Float32 audio from one or more mics, segments each mic into utterances,
 * sends rolling live guesses while someone speaks and a final transcript after each pause.
 * Final lines go to transcripts/<stamp>.txt; with "save audio" on, the audio goes to <stamp>.wav (one file per mic).
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
    this.floors = []; // each mic's background noise as the gate learned it, kept when the mics change
    this.transcribing = new Map(); // id -> { mic, start, end } waiting for the model
    this.done = []; // transcribed sentences, until published and then for KEEP_SEC
    this.#layout(1);
  }

  get detector() {
    return this.mics[0].segmenter.detector.name;
  }

  /** Audio of `count` mics, one after the other, all covering the same moment. */
  audio(samples, count = 1) {
    if (count !== this.mics.length) this.#layout(count);
    const length = samples.length / count;
    const chunks = this.mics.map((_, mic) => samples.subarray(mic * length, (mic + 1) * length));
    if (this.saveAudio) chunks.forEach((chunk, mic) => this.#audioWriter(mic)?.append(chunk));
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
    this.send = () => {};
    this.flush(); // still transcribe and save the last utterance
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
    this.mics = Array.from({ length: count }, (_, mic) => this.#channel(mic, startFrame, leftovers[mic] ?? new Float32Array(unframed)));
    // The mics' noise levels carry over: learning them again needs a long pause, which a lively meeting may not have.
    this.floors = this.gate?.floors ?? this.floors;
    this.gate = count > 1 ? new CrosstalkGate(count, this.config.crosstalkDb, this.floors) : null;
  }

  #channel(mic, startFrame, leftover) {
    const ch = { mic, lastPartialAt: 0, partialWall: 0 };
    const discard = (id) => {
      this.finalized.add(id);
      this.send({ type: 'final', mic, id, text: '' });
      this.#settle(); // a sentence on another mic may have been waiting for this one
    };
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
        if (this.#otherSpeaker(mic, seg)) discard(seg.id);
        else this.#finalize(mic, seg);
      },
      onDiscard: (id) => {
        this.send({ type: 'vad', mic, speaking: false, id });
        discard(id);
      },
    });
    return ch;
  }

  /**
   * With several mics: the whole sentence is the other person, heard through this mic. The gate decides moment by
   * moment, and on some sounds a far mic hears the other person only a few dB less clearly, so short stretches of
   * their speech get through and become 1–3-word lines (issue #3). Over the whole sentence the far mic still heard
   * that speech clearly less well than the other person's own mic did (by more than half of "Mic separation"), which
   * is what this checks before the model runs. A short reply said softly while the other person talks can go with it.
   */
  #otherSpeaker(mic, { id, start, end }) {
    if (!this.gate) return false;
    const deficit = this.gate.deficit(mic, start, end);
    const theirs = deficit > this.config.crosstalkDb * OTHER_SPEAKER;
    if (theirs && process.env.DEBUG) console.log(`[final #${id} mic ${mic + 1}] ${start.toFixed(1)}–${end.toFixed(1)} s not transcribed, another mic heard this speech ${deficit.toFixed(0)} dB more clearly`);
    return theirs;
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
      seg.echo = Boolean(seg.text) && this.#heardBetterElsewhere(seg);
      if (seg.echo && process.env.DEBUG) console.log(`[final #${seg.id} mic ${seg.mic + 1}] dropped, another mic heard it more clearly`);
      const text = seg.echo ? '' : seg.text;
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

  /**
   * At least half of this line's words were transcribed on another mic at the same time, and that mic heard this
   * stretch of speech more clearly. Half of this line's own words, not of the shorter line's: a few words of a long
   * sentence that leaked onto the other mic must never cancel the sentence (issue #3), only the other way round. The
   * other mic's overlapping lines count together (one long sentence can be two lines there), lines already dropped do
   * not count (one copy always stays), and clarity is compared over this line's own time, allowing for a mic that is
   * late.
   */
  #heardBetterElsewhere(seg) {
    if (!this.gate) return false;
    const mics = new Set(this.done.filter((o) => o.mic !== seg.mic && o.text && !o.echo && overlap(seg, o) > 0).map((o) => o.mic));
    for (const mic of mics) {
      const lines = this.done.filter((o) => o.mic === mic && o.text && !o.echo && overlap(seg, o) > 0).sort((a, b) => a.start - b.start);
      if (lines.reduce((sum, o) => sum + overlap(seg, o), 0) < MIN_OVERLAP_SEC) continue;
      const { count, share } = sharedWords(seg.text, lines.map((o) => o.text).join(' '));
      if (count < 2 || share < SAME_WORDS) continue;
      const theirs = this.gate.louder(mic, seg.mic, seg.start, seg.end);
      if (theirs > 0 || (theirs === 0 && mic < seg.mic)) return true; // a tie (the same mic picked twice) keeps one
    }
    return false;
  }

  #base() {
    if (!this.stamp) {
      fs.mkdirSync(this.config.transcriptsDir, { recursive: true });
      this.stamp = fileStamp(new Date());
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

  #audioWriter(mic) {
    if (this.audioFiles[mic]) return this.audioFiles[mic].writer;
    try {
      // One file per mic, opened once per transcript, so changing mics never overwrites a recording.
      const file = `${this.#base()}${this.mics.length > 1 ? `-mic${mic + 1}` : ''}.wav`;
      this.audioFiles[mic] = { file, writer: new WavWriter(file) };
      this.send({ type: 'file', kind: 'audio', mic, path: path.relative(process.cwd(), file) });
      return this.audioFiles[mic].writer;
    } catch (err) {
      this.saveAudio = false;
      this.send({ type: 'error', message: `Could not save audio: ${err.message}` });
      return null;
    }
  }

  #closeFiles() {
    for (const audio of this.audioFiles) audio?.writer.close();
    this.audioFiles = [];
    this.textFile = null;
    this.stamp = null;
  }
}
