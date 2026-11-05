import fs from 'node:fs';
import path from 'node:path';
import { Segmenter } from './segmenter.js';
import { createDetector, FRAME } from './vad.js';
import { CrosstalkGate } from './crosstalk.js';
import { resultToText, contextTail } from './text.js';
import { SteadyText } from './steady.js';
import { sharedWords, comparedWords, words } from './wer.js';
import { WavWriter, concatFloat32, SAMPLE_RATE } from './wav.js';
import { spokenOrder } from '../public/order.js';

const MIN_PARTIAL_SEC = 0.6;
const MIN_OVERLAP_SEC = 0.5; // sentences on two mics overlapping less than this are just people taking turns
const SAME_WORDS = 0.5; // share of a line's words another mic must have caught too for the line to be a copy
const SAME_MIN = 2; // and at least this many words: a line with fewer is never a copy
const OTHER_SPEAKER = 0.5; // share of "Mic separation": a whole sentence another mic heard this much more clearly is the other person's
const PIECE_SLACK_SEC = 1.5; // how far off a word's moment, estimated from its place in a line, may be (pieceOf)
const ENDED_SEC = 0.15; // the other speaker's pause, right where a one-word line ends, that makes it their last word (#waiting)
const KEEP_SEC = 120; // published sentences are kept this long to compare later ones against
const BEHIND_SEC = 30; // tell the page once the oldest sentence waiting for the model ended this long ago (#9)
const CAUGHT_UP_SEC = 10; // and clear the warning once it is back within this
const BEHIND_STEP_SEC = 5; // while behind, update the page when the delay changes by this much
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
const NAME = /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(-\d+)?$/; // what claimName() gives, and nothing that leaves the folder

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

/**
 * Adds `text` to the end of `file`, whole or not at all. A disk that fills up takes part of a write without an error and
 * fails the rest (ENOSPC); that part is cut off again, so the file only ever has whole lines. Opened for writing rather
 * than appending, because Windows cuts a file only through a handle that may write anywhere in it.
 */
function appendWhole(file, text) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT);
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.from(text);
    let written = 0;
    try {
      while (written < buf.length) {
        const n = fs.writeSync(fd, buf, written, buf.length - written, size + written);
        if (n === 0) throw new Error('the disk took no more data'); // never loop forever
        written += n;
      }
    } catch (err) {
      if (written) {
        try {
          fs.ftruncateSync(fd, size);
        } catch {
          // the drive is gone, and the file with it
        }
      }
      throw err;
    }
  } finally {
    fs.closeSync(fd);
  }
}

const overlap = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start);

/**
 * The mics' noise levels of transcripts whose connection closed, for the connection that resumes them (#44): after a
 * network drop the page reconnects within seconds, in the same room with the same mics, and a gate that had to learn the
 * levels again could only compare raw volume until the next long pause, so the louder mic took the next sentences. By
 * the transcript's path; the newest KEPT_FLOORS, a few kB each.
 */
const KEPT_FLOORS = 32;
const keptFloors = new Map();

function keepFloors(key, floors) {
  keptFloors.delete(key);
  keptFloors.set(key, floors);
  if (keptFloors.size > KEPT_FLOORS) keptFloors.delete(keptFloors.keys().next().value);
}

function takeFloors(key) {
  const floors = keptFloors.get(key);
  keptFloors.delete(key);
  return floors;
}

/**
 * The line `seg` is a piece of `lines` (another mic's, in order): all of its words, word for word, said there at the
 * same moment, give or take PIECE_SLACK_SEC, and they have more to say (issue #46). The last word of a sentence can
 * reach a far mic almost as clearly as the near one and become a line there ("curățenie.", "în octombrie."); with
 * one word in common, sharing words is not enough to tell it from a reply that happens to repeat a word of a sentence
 * being said, nor from "Da." with one word of the other person's sentence before it. The model gives no times, so a
 * word's moment is estimated from its place in its line.
 */
function pieceOf(seg, lines) {
  const mine = words(seg.text, { diacritics: false });
  const theirs = lines.flatMap(({ text, start, end }) => {
    const ws = words(text, { diacritics: false });
    const total = ws.reduce((n, w) => n + w.length + 1, 0);
    let at = 0;
    return ws.map((w) => {
      const t = start + ((at + (w.length + 1) / 2) / total) * (end - start);
      at += w.length + 1;
      return { w, t };
    });
  });
  if (!mine.length || theirs.length <= mine.length) return false;
  return theirs.some((_, k) => mine.every((w, i) => theirs[k + i]?.w === w)
    && theirs[k].t <= seg.end + PIECE_SLACK_SEC && theirs[k + mine.length - 1].t >= seg.start - PIECE_SLACK_SEC);
}

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
    this.unsaved = []; // lines the disk had no room for yet, oldest first
    this.held = []; // published lines not yet in the .txt: { id, start, line }, waiting for sentences spoken earlier
    this.textErrorSent = false; // the page knows the transcript cannot be saved, and no save has worked since
    this.stopped = false; // Stop pressed: the next audio is a new recording
    this.heard = false; // audio has come: too late to resume
    this.resumed = false; // continuing another connection's transcript: its WAVs are carried on, not refused
    this.saveAudio = false;
    this.steadyLive = true; // Steady live text (#26): show a live word only once two guesses agree
    this.steady = new Map(); // sentence id -> SteadyText, while its live text is shown
    this.audioFiles = []; // per mic: { file, writer }
    this.nextId = 1; // shared by all mics, so ids follow the order people started speaking
    this.mics = []; // per mic: { mic, segmenter, lastPartialAt, partialWall }
    this.gate = null; // with several mics: decides which mic each bit of speech belongs to
    this.floors = []; // each mic's background noise as the gate learned it, kept when the mics change or the page reconnects
    this.transcribing = new Map(); // id -> { mic, start, end } waiting for the model
    this.done = []; // transcribed sentences, until published and then for KEEP_SEC
    this.behindSec = 0; // the delay last reported to the page (0: not behind)
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
    this.heard = true;
    if (this.stopped) {
      // Start hides the page's errors: a transcript that still cannot be saved is reported again.
      this.stopped = false;
      this.textErrorSent = false;
    }
    if (count !== this.mics.length) this.#layout(count);
    const length = samples.length / count;
    const chunks = this.mics.map((_, mic) => samples.subarray(mic * length, (mic + 1) * length));
    if (this.saveAudio) this.#saveAudio(chunks);
    if (this.gate) {
      const frames = this.mics.map(({ segmenter }, mic) => segmenter.analyze(chunks[mic]));
      for (let i = 0; i < frames[0].length; i++) this.#feed(this.gate.push(frames.map((f) => f[i])));
      // A line of one word may stop waiting once the other mic's speaker goes on talking (#waiting).
      if (this.done.some((seg) => !seg.published)) this.#settle();
      if (process.env.DEBUG && frames[0].length && frames[0].at(-1).index % REPORT_FRAMES < frames[0].length) {
        console.log(`[mics] ${this.gate.report()}`);
      }
    } else {
      this.mics[0].segmenter.push(chunks[0]);
    }
    this.#feedStreams();
    this.#maybePartial();
    this.#checkBehind();
  }

  /** Speech-detection settings changed in the Settings panel: apply them without restarting. */
  retune() {
    for (const { segmenter } of this.mics) {
      segmenter.setTiming(this.config.vad);
      segmenter.detector.setThreshold?.(this.config.vad.sileroThreshold);
    }
    this.gate?.setMargin(this.config.crosstalkDb);
  }

  setOptions({ saveAudio, steadyLive }) {
    if (saveAudio !== undefined) this.saveAudio = Boolean(saveAudio);
    if (steadyLive !== undefined && Boolean(steadyLive) !== this.steadyLive) {
      this.steadyLive = Boolean(steadyLive);
      this.steady.clear();
    }
  }

  /**
   * The page reconnected after the server restarted or the network dropped (#10): carry on its transcript. `name` is
   * the transcript it was saving to (none if nothing was saved yet), `samples` how much audio per mic it had sent, so
   * the clock goes on from there. Only before this connection's first audio; a name that is not an existing transcript
   * here, or that another open connection is writing, starts a new one as before. A reload sends nothing: the page is
   * empty again, and so is its new file. The mics' noise levels come along when this server heard the transcript last
   * (a network drop, not a restart), as they do when the mics change (#44).
   */
  resume({ name, samples }, others = []) {
    if (this.closed || this.heard) return;
    if (Number.isSafeInteger(samples) && samples > 0) {
      for (const { segmenter } of this.mics) {
        segmenter.frameIndex = Math.floor(samples / FRAME);
        segmenter.leftover = new Float32Array(samples % FRAME);
      }
    }
    if (typeof name !== 'string' || !NAME.test(name) || this.stamp) return;
    if (others.some((s) => s !== this && s.stamp === name)) return;
    if (!fs.existsSync(path.join(this.config.transcriptsDir, `${name}.txt`))) return;
    this.stamp = name;
    this.resumed = true;
    this.floors = takeFloors(path.join(this.config.transcriptsDir, name)) ?? this.floors;
  }

  /** End the current utterances now (Stop pressed). */
  flush() {
    this.#endSpeech();
    this.stopped = true;
    this.#saveLines(); // the disk may have room again
  }

  /** End the current utterances: Stop, or the number of mics changed. */
  #endSpeech() {
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
    this.flush(); // still transcribe and save the last utterance (and try once more the lines waiting for room)
    const floors = this.gate?.floors ?? this.floors;
    if (this.stamp && floors.some((floor) => floor.learned)) keepFloors(path.join(this.config.transcriptsDir, this.stamp), floors);
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
    this.#endSpeech();
    this.#releaseDetectors(); // first, so the new mics get them back
    this.mics = Array.from({ length: count }, (_, mic) => this.#channel(mic, startFrame, leftovers[mic] ?? new Float32Array(unframed)));
    // The mics' noise levels carry over: learning them again needs a long pause, which a lively meeting may not have.
    this.floors = this.gate?.floors ?? this.floors;
    this.gate = count > 1 ? new CrosstalkGate(count, this.config.crosstalkDb, this.floors) : null;
  }

  /** Give the mics' voice detectors back for reuse (#4): a dropped one keeps ~3 MB until V8 happens to collect it. */
  #releaseDetectors() {
    for (const { segmenter } of this.mics) segmenter.detector.release?.();
  }

  #channel(mic, startFrame, leftover) {
    // stream: the sentence a streaming model is hearing (id streamId); sentFrame: the last frame index sent to one.
    const ch = { mic, lastPartialAt: 0, partialWall: 0, stream: null, streamId: 0, sentFrame: -1 };
    const discard = (id) => {
      if (ch.streamId === id) ch.stream?.cancel();
      ch.stream = null;
      this.#endLive(id);
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
        this.#openStream(ch, id);
      },
      onSegment: (seg) => {
        this.send({ type: 'vad', mic, speaking: false, id: seg.id });
        if (this.#otherSpeaker(mic, seg)) discard(seg.id);
        else this.#finalize(mic, this.#withoutTheirs(mic, seg), this.#endStream(ch, seg.id));
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

  /**
   * With several mics: the sentence without the other person's speech that went on after it (issue #46). Someone
   * stops, the person on another mic goes on, and the gate lets through enough of their words on this mic to keep the
   * sentence going. Where another mic heard the rest clearly better (by more than half of "Mic separation", as
   * #otherSpeaker measures it) and this mic heard it that much more quietly than the sentence before it, the rest is
   * cut off before the model runs (CrosstalkGate.theirsFrom). A streaming model has heard it already.
   */
  #withoutTheirs(mic, seg) {
    const cut = this.gate?.theirsFrom(mic, seg.start, seg.end, this.config.crosstalkDb * OTHER_SPEAKER) ?? null;
    if (cut === null) return seg;
    if (process.env.DEBUG) console.log(`[final #${seg.id} mic ${mic + 1}] ${cut.toFixed(1)}–${seg.end.toFixed(1)} s cut off, another mic heard this speech more clearly`);
    return { ...seg, end: cut, samples: seg.samples.subarray(0, Math.round((cut - seg.start) * SAMPLE_RATE)) };
  }

  #feed(frames) {
    frames?.forEach((frame, mic) => this.mics[mic].segmenter.feed(frame));
  }

  /** A streaming model (ElevenLabs) hears each sentence while it is spoken; its live text replaces the guesses. */
  #openStream(ch, id) {
    const { start } = ch.segmenter.current();
    ch.stream = this.transcriber.stream?.({
      prompt: this.#prompt(),
      onPartial: (raw) => {
        const text = resultToText({ text: raw });
        if (text && !this.finalized.has(id)) this.#partial(ch.mic, id, start, text);
      },
    }) ?? null;
    ch.streamId = id;
  }

  #feedStreams() {
    for (const ch of this.mics) {
      const cur = ch.segmenter.current();
      if (ch.stream && cur?.id === ch.streamId) this.#sendFrames(ch, ch.stream, cur.frames, cur.settled);
    }
  }

  /**
   * Send a sentence its frames up to `end` that it has not had; the cloud bills every second it gets. A frame is sent
   * once, ever: the end of the last sentence (kept as this one's lead-in) and speech after a split point already went
   * out. The pause that ends a sentence is not sent (`settled`), the same audio a local model would get.
   */
  #sendFrames(ch, stream, frames, end) {
    let from = end;
    while (from > 0 && frames[from - 1].index > ch.sentFrame) from--;
    if (from === end) return;
    stream.push(concatFloat32(frames.slice(from, end).map((f) => f.samples)));
    ch.sentFrame = frames[end - 1].index;
  }

  /** The sentence ended: send it the rest of its audio. Null when it has no stream, or lost it (sent whole instead). */
  #endStream(ch, id) {
    const { stream } = ch;
    if (!stream || ch.streamId !== id) return null;
    ch.stream = null;
    if (!stream.live()) return null; // the model was switched, or the connection failed, mid-sentence
    const { frames, settled } = ch.segmenter.current();
    this.#sendFrames(ch, stream, frames, settled);
    return stream;
  }

  /** Seconds of audio this session has received so far. */
  #clock() {
    return (Math.max(...this.mics.map(({ segmenter }) => segmenter.frameIndex)) * FRAME) / SAMPLE_RATE;
  }

  /**
   * A model slower than the talk queues every sentence (none is dropped), so lines come later and later. Tell the
   * page when the oldest sentence still waiting for the model ended more than BEHIND_SEC ago, and when it catches up.
   */
  #checkBehind() {
    let oldest = Infinity;
    for (const seg of this.transcribing.values()) oldest = Math.min(oldest, seg.end);
    const behind = oldest === Infinity ? 0 : Math.max(0, this.#clock() - oldest);
    const seconds = Math.round(behind);
    if (!this.behindSec) {
      if (behind <= BEHIND_SEC) return;
    } else if (behind < CAUGHT_UP_SEC) {
      this.behindSec = 0;
      return this.send({ type: 'behind', seconds: 0 });
    } else if (Math.abs(seconds - this.behindSec) < BEHIND_STEP_SEC) {
      return;
    }
    this.behindSec = seconds;
    this.send({ type: 'behind', seconds });
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
        if (text) this.#partial(ch.mic, cur.id, cur.start, text);
      })
      .catch(() => {}) // a failed live guess is harmless; the final will report errors
      .finally(() => {
        this.partialBusy = false;
      });
  }

  /**
   * A live guess of the sentence `id` so far. With Steady live text on, only the words two guesses in a row agree on,
   * and never fewer than already shown; the final line replaces it at the end. The page, the projector and the caption
   * windows all show what is sent here.
   */
  #partial(mic, id, start, text) {
    if (this.steadyLive) {
      if (!this.steady.has(id)) this.steady.set(id, new SteadyText());
      text = this.steady.get(id).update(text);
      if (!text) return;
    }
    this.send({ type: 'partial', mic, id, start, text });
  }

  /** The sentence gets no more live guesses: its final line (or none) is next. */
  #endLive(id) {
    this.finalized.add(id);
    this.steady.delete(id);
  }

  async #finalize(mic, { id, samples, start, end }, stream = null) {
    this.#endLive(id);
    this.finalsPending++;
    const seg = { id, mic, start, end, text: '' };
    this.transcribing.set(id, seg);
    try {
      const whole = () => this.transcriber.transcribe(samples, { prompt: this.#prompt(), fallback: true });
      // A streamed sentence whose connection fails at the end is sent once more, whole.
      const result = await (stream ? stream.commit().catch(whole) : whole());
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
      this.#checkBehind();
    }
    this.done.push(seg);
    this.#settle();
  }

  /**
   * Publish transcribed sentences. With several mics, a sentence may first wait until the sentences overlapping it on
   * another mic are transcribed too: when two mics caught the same words, only the mic that heard them more clearly
   * keeps them, because the other one just picked up the other speaker (#waiting says when that can happen).
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
      this.held.push({ id, start, line: `[${fmtTime(start)}] ${this.mics.length > 1 ? `Mic ${mic + 1}: ` : ''}${text}\n` });
    }
    this.#writeHeld();
    const latest = Math.max(...this.done.map((seg) => seg.end));
    this.done = this.done.filter((seg) => !seg.published || seg.end > latest - KEEP_SEC);
  }

  /**
   * Lines go to the .txt in the order they were spoken, by the page's own rule (public/order.js; #7, #50): a line
   * waits until every sentence that started before it, on any mic, is published (or dropped). A short line on one mic
   * is otherwise finished, and written, before a longer one that started earlier on the other. `all` writes every
   * waiting line (Clear).
   */
  #writeHeld(all = false) {
    if (!this.held.length) return;
    const open = all ? [] : [
      ...[...this.transcribing.values()].map((seg) => seg.start),
      ...this.done.filter((seg) => !seg.published).map((seg) => seg.start),
      ...this.mics.map(({ segmenter }) => segmenter.current()?.start ?? Infinity),
    ];
    const earliest = Math.min(...open);
    this.held.sort(spokenOrder);
    const ready = this.held.filter((l) => l.start < earliest);
    if (!ready.length) return;
    this.held = this.held.slice(ready.length);
    this.#saveLine(ready.map((l) => l.line).join(''));
  }

  /**
   * Another mic is still speaking, or still being transcribed, at the same time as this sentence, and its line could
   * still make this one a copy (#heardBetterElsewhere). Only then does the line wait (D5, #6): a line with no word to
   * share, a line of one word that ended while the other mic's speaker talked on, or one whose own mic heard its time
   * more clearly than that mic, is never dropped because of it, so it is published at once (#47). Before, a "Da." said
   * in someone else's sentence waited for the rest of their turn, and a line overlapped at its end by the next speaker
   * waited for the whole of their turn. audio() asks again as the other mic's sentence grows.
   */
  #waiting(seg) {
    const shared = this.gate ? comparedWords(seg.text).length : 0;
    if (!shared) return false;
    const speaking = this.mics.filter(({ mic, segmenter }) => {
      const cur = segmenter.current();
      return mic !== seg.mic && cur && seg.end - Math.max(seg.start, cur.start) >= MIN_OVERLAP_SEC;
    });
    const transcribing = [...this.transcribing.values()].filter((t) => t.mic !== seg.mic && overlap(seg, t) >= MIN_OVERLAP_SEC);
    // A line of one word can be a copy only as a piece of the other mic's sentence (#pieceOf): a sentence's last word
    // that reached this mic too (#46). That word ends where its speaker pauses, at the end of their sentence, even when
    // they go on with the next one in the same breath. So the line waits when the other mic's speaker paused right where
    // it ended; a reply ("Bine.") said while they talk on comes at once (#47).
    return [...speaking, ...transcribing].some(({ mic }) => this.#asClear(mic, seg)
      && (shared >= SAME_MIN || this.gate.pauseAfter(mic, seg.mic, seg.start, seg.end) >= ENDED_SEC));
  }

  /**
   * Mic `other` heard the time of `seg` at least as clearly as seg's own mic: only then can seg be a copy of what
   * `other` caught. The gate keeps each moment's clarity as it was heard, so waiting would not change the answer. A
   * tie (the same mic picked twice) keeps the line of the lower mic. A mic the gate does not have (the mics changed
   * since) cannot be compared: the line is kept.
   */
  #asClear(other, seg) {
    const count = this.gate.floors.length;
    if (other >= count || seg.mic >= count) return false;
    const theirs = this.gate.louder(other, seg.mic, seg.start, seg.end);
    return theirs > 0 || (theirs === 0 && other < seg.mic);
  }

  /**
   * At least half of this line's words were transcribed on another mic at the same time, and that mic heard this
   * stretch of speech more clearly. Half of this line's own words, not of the shorter line's: a few words of a long
   * sentence that leaked onto the other mic must never cancel the sentence (issue #3), only the other way round. Two
   * words in common at least, or else the line is one word of the other mic's lines, said there at the same moment
   * (#pieceOf). The other mic's overlapping lines count together (one long sentence can be two lines there), lines
   * already dropped do not count (one copy always stays), and clarity is compared over this line's own time, allowing
   * for a mic that is late.
   */
  #heardBetterElsewhere(seg) {
    if (!this.gate) return false;
    const mics = new Set(this.done.filter((o) => o.mic !== seg.mic && o.text && !o.echo && overlap(seg, o) > 0).map((o) => o.mic));
    for (const mic of mics) {
      const lines = this.done.filter((o) => o.mic === mic && o.text && !o.echo && overlap(seg, o) > 0).sort((a, b) => a.start - b.start);
      if (lines.reduce((sum, o) => sum + overlap(seg, o), 0) < MIN_OVERLAP_SEC) continue;
      const { count, share } = sharedWords(seg.text, lines.map((o) => o.text).join(' '));
      if (!(count >= SAME_MIN && share >= SAME_WORDS) && !(count === 1 && pieceOf(seg, lines))) continue;
      if (this.#asClear(mic, seg)) return true;
    }
    return false;
  }

  #base() {
    if (!this.stamp) {
      fs.mkdirSync(this.config.transcriptsDir, { recursive: true });
      this.stamp = claimName(this.config.transcriptsDir, fileStamp(new Date()), this.config.maxMics); // creates the .txt
    }
    return path.join(this.config.transcriptsDir, this.stamp);
  }

  /**
   * Adds a line to the .txt. When the disk is full (or the drive is gone) the lines wait here and go first at the next
   * try, so the file catches up once there is room. The page is told once, and again only after a save has worked,
   * after Start (which hides the page's errors) or after Clear (a new file).
   */
  #saveLine(line) {
    this.unsaved.push(line);
    this.#saveLines();
  }

  #saveLines() {
    if (!this.unsaved.length) return;
    try {
      if (!this.textFile) {
        this.textFile = `${this.#base()}.txt`;
        this.send({ type: 'file', kind: 'text', name: this.stamp, path: path.relative(process.cwd(), this.textFile) });
      }
      appendWhole(this.textFile, this.unsaved.join(''));
      this.unsaved = [];
      this.textErrorSent = false;
    } catch (err) {
      if (!this.textErrorSent) this.send({ type: 'error', message: `Could not save transcript: ${err.message}` });
      this.textErrorSent = true;
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
      this.send({ type: 'options', saveAudio: false }); // the page unticks Save audio
    }
  }

  #audioWriter(mic) {
    if (!this.audioFiles[mic]) {
      // One file per mic, opened once per transcript, so changing mics never overwrites a recording.
      const file = `${this.#base()}${this.mics.length > 1 ? `-mic${mic + 1}` : ''}.wav`;
      this.audioFiles[mic] = { file, writer: new WavWriter(file, { resume: this.resumed }) };
      this.send({ type: 'file', kind: 'audio', mic, name: this.stamp, path: path.relative(process.cwd(), file) });
    }
    return this.audioFiles[mic].writer;
  }

  #closeFiles() {
    for (const audio of this.audioFiles) audio?.writer.close();
    this.audioFiles = [];
    this.#writeHeld(true); // lines still waiting for an earlier sentence belong to this transcript
    this.#saveLines(); // a last try: lines still without room belong to no file after Clear, as on the page
    this.unsaved = [];
    this.textErrorSent = false;
    this.textFile = null;
    this.stamp = null;
    this.resumed = false;
  }
}
