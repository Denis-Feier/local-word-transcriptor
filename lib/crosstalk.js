import { FRAME } from './vad.js';
import { SAMPLE_RATE } from './wav.js';

const FRAME_SEC = FRAME / SAMPLE_RATE; // 32 ms
const HOLD = 8; // frames either side (~0.25 s): a Bluetooth mic delivers its audio up to this much later than a wired one
const OWN = 3; // frames either side (~0.1 s) for a mic's own level: one syllable, not the previous speaker's last words
const MIN_FLOOR = 0.0005; // -66 dBFS; mics with built-in noise cancelling can go almost silent between words
const NO_SIGNAL = 1e-5; // -100 dBFS: digital silence from a mic that is not connected (yet), not its room noise
const MIN_CLARITY = 10; // dB above a mic's noise; the detector stays on briefly after speech ends
const HISTORY = Math.round(120 / FRAME_SEC); // clarity is kept for 2 minutes, for deficit() and louder()
const QUIET_FRAMES = 50; // ~1.6 s of moments in which no mic heard speech: each mic's noise level is taken from these

const db = (level) => 20 * Math.log10(Math.max(level, 1e-9));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
const frames0 = (count) => Array.from({ length: count }, () => ({ speech: 0, kept: 0 }));

/**
 * A mic's background noise in dB: the 20th percentile of its levels (where the quietest fifth ends) over the last
 * QUIET_FRAMES frames in which no mic heard speech (CrosstalkGate.#learn). Not an average: the detector can take most
 * of a second to notice someone starting softly ("Era…"), and those frames, learned as noise, made a mic look 10–20 dB
 * noisier until the next long pause, so the other mic's bleed won (issue #3). Being louder than the room, they rarely
 * reach the quietest fifth, and neither do a door or a chair. Until the first quiet frame every mic counts as equally
 * noisy.
 */
class NoiseFloor {
  db = db(MIN_FLOOR);
  learned = false;
  levels = []; // dB, oldest first
  frames = []; // the frame index of each level

  push(level, index) {
    if (level < NO_SIGNAL) return;
    this.levels.push(db(Math.max(level, MIN_FLOOR)));
    this.frames.push(index);
    if (this.levels.length > QUIET_FRAMES) {
      this.levels.shift();
      this.frames.shift();
    }
    this.#update();
  }

  /** Speech noticed at frame `index`: the frames just before it were probably its start, not the room. */
  forget(index) {
    if (!(this.frames.at(-1) >= index)) return;
    while (this.frames.at(-1) >= index) {
      this.levels.pop();
      this.frames.pop();
    }
    this.#update();
  }

  #update() {
    this.learned = this.levels.length > 0;
    this.db = this.learned ? [...this.levels].sort((a, b) => a - b)[Math.floor((this.levels.length - 1) / 5)] : db(MIN_FLOOR);
  }
}

/**
 * Mics in one room all hear every speaker, the farther ones more quietly ("bleed"). Each mic should only
 * transcribe its own speaker, so a mic's frame keeps its speech only while that mic hears it nearly as clearly
 * as the clearest other mic does around the same moment (within marginDb).
 *
 * Clarity is a mic's level above its own background noise, which cancels out the different volumes of, say,
 * a Bluetooth headset and a wired mic. Decisions come HOLD frames late, so a mic that delivers its audio later
 * is still compared with the same moment on the others.
 */
export class CrosstalkGate {
  /** floors: each mic's noise as learned before the mics changed (the same devices, most likely), kept if given. */
  constructor(count, marginDb, floors = []) {
    this.marginDb = marginDb;
    this.floors = Array.from({ length: count }, (_, mic) => floors[mic] ?? new NoiseFloor());
    this.history = Array.from({ length: count }, () => new Float32Array(HISTORY).fill(NaN));
    this.heard = Array.from({ length: count }, () => new Uint8Array(HISTORY)); // the detector's verdict, before the gate
    this.latest = -1; // index of the newest frame in history
    this.past = []; // decided entries, kept as look-back
    this.ahead = []; // entries waiting for look-ahead: { frames, speech, clarity }
    this.counts = frames0(count); // speech frames per mic, and how many were kept, for report()
  }

  setMargin(marginDb) {
    this.marginDb = marginDb;
  }

  /** One frame per mic, all from the same moment (Segmenter.analyze). Returns the frames from HOLD frames ago, decided, or null. */
  push(frames) {
    const speech = frames.map((f) => f.loud);
    const clarity = frames.map((f, mic) => {
      const value = db(f.level) - this.floors[mic].db;
      this.history[mic][f.index % HISTORY] = value;
      this.heard[mic][f.index % HISTORY] = f.loud ? 1 : 0;
      return value;
    });
    this.latest = frames[0].index;
    this.#learn(frames, speech);
    this.ahead.push({ frames, speech, clarity });
    return this.ahead.length > HOLD ? this.#decide() : null;
  }

  /** Decide the frames still waiting for look-ahead (Stop pressed). */
  drain() {
    const out = [];
    while (this.ahead.length) out.push(this.#decide());
    return out;
  }

  /** One line for the server log: each mic's noise and how much of the speech it heard was kept as its own. */
  report() {
    const line = this.floors.map((floor, mic) => {
      const { speech, kept } = this.counts[mic];
      return `mic ${mic + 1}: noise ${floor.learned ? `${floor.db.toFixed(0)} dB` : 'not measured yet'}, kept ${kept} of ${speech} speech frames`;
    });
    this.counts = frames0(this.floors.length);
    return line.join(' · ');
  }

  /**
   * How much less clearly a mic heard its speech between two session times (seconds) than the clearest other mic
   * heard the same moments, in dB: at every frame where this mic's detector heard speech, each mic's clearest moment
   * within HOLD frames (allowing for lag), and the median of the differences. Positive: another mic heard it better;
   * NaN if this mic heard no speech there. Over a whole sentence, the other person's words that got through for a
   * moment come out well above zero (5–10 dB in the tests), the mic's own speech below zero even where it overlaps the
   * other person, and the same audio on two mics exactly 0.
   */
  deficit(mic, start, end) {
    const from = Math.max(Math.floor(start / FRAME_SEC), this.latest - HISTORY + 1 + HOLD);
    const to = Math.min(Math.ceil(end / FRAME_SEC), this.latest + 1 - HOLD);
    const peak = (m, i) => {
      let best = -Infinity;
      for (let k = i - HOLD; k <= i + HOLD; k++) best = Math.max(best, this.history[m][k % HISTORY]);
      return best;
    };
    const gaps = [];
    for (let i = from; i < to; i++) {
      if (!this.heard[mic][i % HISTORY]) continue;
      const own = peak(mic, i);
      const rival = Math.max(...this.history.map((_, other) => (other === mic ? -Infinity : peak(other, i))));
      if (Number.isFinite(own) && Number.isFinite(rival)) gaps.push(rival - own);
    }
    return gaps.length ? median(gaps) : NaN;
  }

  /**
   * How much more clearly mic `a` heard the time between two session times than mic `b` (dB, may be negative): the
   * average power of each mic's clarity over that time, widened by the lag a mic may have. The same audio on both
   * mics gives exactly 0.
   */
  louder(a, b, start, end) {
    const from = Math.max(Math.floor(start / FRAME_SEC) - HOLD, this.latest - HISTORY + 1);
    const to = Math.min(Math.ceil(end / FRAME_SEC) + HOLD, this.latest + 1);
    const power = (mic) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += 10 ** ((this.history[mic][i % HISTORY] || 0) / 10);
      return 10 * Math.log10(sum / Math.max(1, to - from));
    };
    return power(a) - power(b);
  }

  /**
   * Each mic's background noise, from frames in which no mic hears speech, now or in the next HOLD frames: the detector
   * often notices speech a little after it starts (and after speech it stays on a little longer by itself).
   */
  #learn(frames, speech) {
    if (speech.some(Boolean)) this.floors.forEach((floor) => floor.forget(this.latest - HOLD));
    else frames.forEach((f, mic) => this.floors[mic].push(f.level, f.index));
  }

  #decide() {
    const entry = this.ahead.shift();
    const window = [...this.past, entry, ...this.ahead];
    // Each mic's clearest moment in the whole window (allowing for lag), against this mic's own current syllable.
    const peak = (w, mic) => Math.max(...w.map((x) => x.clarity[mic]));
    const at = this.past.length;
    const near = window.slice(Math.max(0, at - OWN), at + OWN + 1);
    entry.frames.forEach((frame, mic) => {
      const rival = Math.max(...entry.frames.map((_, other) => (other === mic ? -Infinity : peak(window, other))));
      if (entry.clarity[mic] < MIN_CLARITY || peak(near, mic) < rival - this.marginDb) frame.loud = false;
      this.counts[mic].speech += entry.speech[mic];
      this.counts[mic].kept += frame.loud;
    });
    this.past.push(entry);
    if (this.past.length > HOLD) this.past.shift();
    return entry.frames;
  }
}
