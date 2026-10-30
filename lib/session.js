import fs from 'node:fs';
import path from 'node:path';
import { Segmenter } from './segmenter.js';
import { createDetector } from './vad.js';
import { resultToText, contextTail } from './text.js';
import { WavWriter } from './wav.js';

const MIN_PARTIAL_SEC = 0.6;

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

/**
 * One browser connection: receives 16 kHz Float32 audio, segments it into utterances,
 * sends rolling live guesses while someone speaks and a final transcript after each pause.
 * Final lines go to transcripts/<stamp>.txt; with "save audio" on, the audio goes to <stamp>.wav.
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
    this.lastPartialAt = 0;
    this.stamp = null;
    this.textFile = null;
    this.saveAudio = false;
    this.audioFile = null;

    this.segmenter = new Segmenter({
      ...config.vad,
      detector: createDetector(config.vad),
      onSpeechStart: (id) => {
        this.lastPartialAt = 0;
        this.send({ type: 'vad', speaking: true, id });
      },
      onSegment: (seg) => {
        this.send({ type: 'vad', speaking: false, id: seg.id });
        this.#finalize(seg);
      },
      onDiscard: (id) => {
        this.finalized.add(id);
        this.send({ type: 'vad', speaking: false, id });
        this.send({ type: 'final', id, text: '' });
      },
    });
  }

  get detector() {
    return this.segmenter.detector.name;
  }

  audio(samples) {
    if (this.saveAudio) this.#audioWriter()?.append(samples);
    this.segmenter.push(samples);
    this.#maybePartial();
  }

  /** Speech-detection settings changed in the Settings panel: apply them without restarting. */
  retune() {
    this.segmenter.setTiming(this.config.vad);
    this.segmenter.detector.setThreshold?.(this.config.vad.sileroThreshold);
  }

  setOptions({ saveAudio }) {
    if (saveAudio !== undefined) this.saveAudio = Boolean(saveAudio);
  }

  /** End the current utterance now (Stop pressed). */
  flush() {
    this.segmenter.flush();
  }

  /** Clear pressed: forget the context and start new transcript/audio files. */
  reset() {
    this.transcript = '';
    this.#closeFiles();
  }

  close() {
    this.send = () => {};
    this.segmenter.flush(); // still transcribe and save the last utterance
    this.audioFile?.writer.close();
    this.audioFile = null;
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
    const cur = this.segmenter.current();
    if (!cur || cur.duration < MIN_PARTIAL_SEC) return;
    if (cur.duration - this.lastPartialAt < this.#partialInterval()) return;
    if (this.partialBusy || this.finalsPending > 0) return;

    const job = this.transcriber.tryTranscribe(cur.samples(), { prompt: this.#prompt(), fallback: false });
    if (!job) return; // model busy; try again on the next audio chunk
    this.partialBusy = true;
    this.lastPartialAt = cur.duration;
    job
      .then((result) => {
        if (this.finalized.has(cur.id)) return;
        const text = resultToText(result);
        if (text) this.send({ type: 'partial', id: cur.id, start: cur.start, text });
      })
      .catch(() => {}) // a failed live guess is harmless; the final will report errors
      .finally(() => {
        this.partialBusy = false;
      });
  }

  async #finalize({ id, samples, start, end }) {
    this.finalized.add(id);
    this.finalsPending++;
    try {
      const result = await this.transcriber.transcribe(samples, { prompt: this.#prompt(), fallback: true });
      const text = resultToText(result);
      if (process.env.DEBUG) {
        console.log(`[final #${id}] ${result.model} ${(end - start).toFixed(1)} s audio, ${Math.round(result.ms)} ms: ${text || '(empty)'}`);
      }
      this.send({ type: 'final', id, start, end, text, model: result.model, ms: Math.round(result.ms) });
      if (text) {
        this.transcript = `${this.transcript} ${text}`.trim();
        this.#saveLine(`[${fmtTime(start)}] ${text}\n`);
      }
    } catch (err) {
      this.send({ type: 'final', id, text: '' });
      this.send({ type: 'error', message: err.message });
    } finally {
      this.finalsPending--;
    }
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

  #audioWriter() {
    if (this.audioFile) return this.audioFile.writer;
    try {
      const file = `${this.#base()}.wav`;
      this.audioFile = { file, writer: new WavWriter(file) };
      this.send({ type: 'file', kind: 'audio', path: path.relative(process.cwd(), file) });
      return this.audioFile.writer;
    } catch (err) {
      this.saveAudio = false;
      this.send({ type: 'error', message: `Could not save audio: ${err.message}` });
      return null;
    }
  }

  #closeFiles() {
    this.audioFile?.writer.close();
    this.audioFile = null;
    this.textFile = null;
    this.stamp = null;
  }
}
