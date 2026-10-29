import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MODELS_DIR = path.join(ROOT, 'models');

const env = process.env;
const num = (value, fallback) => (value === undefined || value === '' ? fallback : Number(value));

export const config = {
  host: env.HOST ?? '127.0.0.1',
  port: num(env.PORT, 3000),
  transcriptsDir: env.TRANSCRIPTS_DIR ?? path.join(ROOT, 'transcripts'),
  settingsFile: path.join(ROOT, '.settings.json'),

  defaultModel: env.MODEL ?? 'canary-1b-v2',
  language: env.LANGUAGE ?? 'ro',
  threads: num(env.THREADS, 4),

  whisper: {
    bin: env.WHISPER_SERVER_BIN ?? 'whisper-server',
    port: num(env.WHISPER_PORT, 0), // 0 = pick a free port, so several instances never collide
    // Optional names/jargon for the first sentence. Empty by default: when audio starts mid-sentence
    // Whisper can copy a generic prompt into the transcript.
    initialPrompt: env.INITIAL_PROMPT ?? '',
  },

  vad: {
    engine: env.VAD ?? 'silero', // 'silero' (neural, robust in rooms) or 'energy' (loudness threshold)
    sileroModel: path.join(MODELS_DIR, 'silero_vad.onnx'),
    sileroThreshold: num(env.VAD_THRESHOLD, 0.5), // lower (e.g. 0.35) picks up quieter, farther voices
    minRms: num(env.VAD_MIN_RMS, 0.006), // energy detector only
    noiseRatio: num(env.VAD_NOISE_RATIO, 3), // energy detector only
    silenceMs: num(env.VAD_SILENCE_MS, 700), // pause length that ends a sentence
    preRollMs: 300,
    minSpeechMs: 250,
    maxSegmentSec: num(env.VAD_MAX_SEGMENT_SEC, 20),
  },

  // Live guesses refresh at most this often; slower models automatically refresh less often.
  partialEverySec: num(env.PARTIAL_EVERY_SEC, 0.5),
};
