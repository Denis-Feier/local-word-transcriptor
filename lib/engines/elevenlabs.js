import { SAMPLE_RATE, concatFloat32 } from '../wav.js';
import { sleep } from './sidecar.js';

// @elevenlabs/elevenlabs-js costs ~150 MB of memory and up to a second to load: only when the cloud model is chosen.
let sdk = null;

const MIN_CHUNK = SAMPLE_RATE / 10; // ElevenLabs asks for chunks of 0.1–1 s
const MAX_CHUNK = SAMPLE_RATE;
const COMMIT_TIMEOUT_MS = 10000; // the committed text normally comes ~150 ms after the commit

const HINTS = {
  auth_error: 'Check ELEVENLABS_API_KEY in .env.local.',
  quota_exceeded: 'The ElevenLabs account has no credits left for this.',
  unaccepted_terms: 'Accept the ElevenLabs terms of service on elevenlabs.io first.',
};

/** A server message ({ message_type, error }) or a WebSocket error as one line for the page. */
function describe(err) {
  if (err?.message_type) return [`ElevenLabs: ${(err.error || err.message_type).replace(/([^.!?])$/, '$1.')}`, HINTS[err.message_type]].filter(Boolean).join(' ');
  const text = `ElevenLabs: ${err?.message ?? err}`;
  return /\b40[13]\b/.test(text) ? `${text} ${HINTS.auth_error}` : text;
}

/** Float32 samples -> 16-bit PCM (pcm_16000), base64. */
function toBase64(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767);
  return Buffer.from(pcm.buffer).toString('base64');
}

/**
 * One sentence on its own realtime connection: the audio is sent while it is spoken, ElevenLabs answers with live
 * text (onPartial), and commit() resolves to the final { text }. A connection per sentence sends only speech
 * (ElevenLabs bills every second it receives, silence too), never meets its 15 s idle limit, and can take the
 * transcript so far as context (previous_text, accepted only with a connection's first audio).
 */
class Sentence {
  #connection = null;
  #started = false;
  #done = false;
  #audio = []; // not sent yet: before the session starts, and less than MIN_CHUNK
  #waiting = 0;
  #sent = false;
  #texts = []; // committed by ElevenLabs; it also commits by itself after ~36 s of audio
  #timer = null;
  #ready;
  #result;

  constructor(client, query, { prompt = '', onPartial = () => {} } = {}) {
    const { RealtimeEvents } = sdk;
    this.prompt = prompt;
    this.onPartial = onPartial;
    this.closed = false;
    this.committing = false;
    this.ready = new Promise((resolve, reject) => (this.#ready = { resolve, reject })); // ElevenLabs is listening
    this.result = new Promise((resolve, reject) => (this.#result = { resolve, reject }));
    // A sentence dropped (a cough) or failed before anyone waits for it is nobody's error.
    this.ready.catch(() => {});
    this.result.catch(() => {});
    client.speechToText.realtime.connect(query).then((connection) => {
      this.#connection = connection;
      // Listeners first, even for a sentence already over: the SDK re-emits socket errors as 'error' events, which
      // would crash the server with no listener.
      connection.on(RealtimeEvents.SESSION_STARTED, () => {
        this.#started = true;
        this.#ready.resolve();
        this.#send();
      });
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, ({ text }) => {
        if (text && !this.#done) this.onPartial([...this.#texts, text].join(' '));
      });
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text }) => {
        if (text) this.#texts.push(text);
        if (this.committing) this.#finish(null);
      });
      connection.on(RealtimeEvents.ERROR, (err) => this.#finish(new Error(describe(err))));
      connection.on(RealtimeEvents.CLOSE, () => this.#finish(new Error('ElevenLabs closed the connection.')));
      if (this.#done) connection.close(); // cancelled while connecting
    }, (err) => this.#finish(new Error(describe(err))));
  }

  push(samples) {
    if (this.#done || !samples.length) return;
    this.#audio.push(samples);
    this.#waiting += samples.length;
    this.#send();
  }

  /** The sentence is over: send what is left and wait for its text. */
  commit() {
    if (!this.#done && !this.committing) {
      this.committing = true;
      this.#timer = setTimeout(() => this.#finish(new Error(`ElevenLabs did not answer within ${COMMIT_TIMEOUT_MS / 1000} s.`)), COMMIT_TIMEOUT_MS);
      this.#send();
    }
    return this.result;
  }

  /** Close without a text (a click or a cough, or the model was switched). */
  cancel() {
    this.#finish(new Error('cancelled'));
  }

  #send() {
    if (!this.#started || this.#done) return;
    try {
      if (this.#waiting >= MIN_CHUNK || (this.committing && this.#waiting)) {
        const audio = concatFloat32(this.#audio);
        this.#audio = [];
        this.#waiting = 0;
        for (let at = 0; at < audio.length; at += MAX_CHUNK) {
          this.#connection.send({ audioBase64: toBase64(audio.subarray(at, at + MAX_CHUNK)), previousText: (!this.#sent && this.prompt) || undefined });
          this.#sent = true;
        }
      }
      if (!this.committing) return;
      if (this.#sent) this.#connection.commit();
      else this.#finish(null); // no audio ever came
    } catch (err) {
      this.#finish(new Error(describe(err)));
    }
  }

  #finish(err) {
    if (this.#done) return;
    this.#done = true;
    this.closed = true;
    clearTimeout(this.#timer);
    if (err) {
      this.#ready.reject(err);
      this.#result.reject(err);
    } else {
      this.#ready.resolve();
      this.#result.resolve({ text: this.#texts.join(' ') });
    }
    this.#connection?.close(); // its close event finds the sentence finished
  }
}

/**
 * ElevenLabs Scribe v2 Realtime, the one cloud model: the audio leaves the computer. Streams each sentence while it is
 * spoken (stream()); transcribe() sends a whole sentence the same way, for the batch tools and as a retry.
 */
export class ElevenLabsEngine {
  supportsPrompt = true; // previous_text: the end of the transcript so far

  constructor({ apiKey, baseUrl, modelId, language }) {
    Object.assign(this, { apiKey, baseUrl, modelId, language });
    this.client = null;
    this.open = new Set();
  }

  /** Checks the key by starting a session and closing it at once: no audio is sent, so nothing is billed. */
  async load() {
    if (!this.apiKey) throw new Error('No ElevenLabs API key: put it in .env.local as ELEVENLABS_API_KEY=… (see .env.example).');
    sdk ??= await import('@elevenlabs/elevenlabs-js');
    this.client = new sdk.ElevenLabsClient({ apiKey: this.apiKey, baseUrl: this.baseUrl });
    this.query = {
      modelId: this.modelId,
      languageCode: this.language,
      audioFormat: sdk.AudioFormat.PCM_16000,
      sampleRate: SAMPLE_RATE,
      commitStrategy: sdk.CommitStrategy.MANUAL,
    };
    const probe = this.stream();
    try {
      await probe.ready;
    } finally {
      probe.cancel();
    }
  }

  /** After load(): a sentence to send while it is spoken: push(samples), commit() -> { text }, cancel(); onPartial(text) live. */
  stream(opts) {
    const sentence = new Sentence(this.client, this.query, opts);
    this.open.add(sentence);
    sentence.result.finally(() => this.open.delete(sentence)).catch(() => {});
    return sentence;
  }

  transcribe(samples, { prompt } = {}) {
    const sentence = this.stream({ prompt });
    sentence.push(samples);
    return sentence.commit();
  }

  /** Sentences being committed still get their text; the others are dropped, and the session sends them on whole. */
  async unload() {
    for (const sentence of this.open) if (!sentence.committing) sentence.cancel();
    await Promise.race([Promise.allSettled([...this.open].map((s) => s.result)), sleep(COMMIT_TIMEOUT_MS)]);
  }

  kill() {
    for (const sentence of this.open) sentence.cancel();
  }
}
