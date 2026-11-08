import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODELS_DIR, ROOT, config } from './config.ts';
import { convertHfWhisper } from './convert-whisper.ts';
import { ensurePythonEnv, pythonReady } from './python-env.ts';
import type { Model, ModelFile, OnProgress, WhisperConvert } from '../types/model.ts';

/** The voice detector's model file (lib/models.ts SILERO_VAD). */
export interface SileroVadFile {
  label: string;
  url: string;
  file: string;
}

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
const HF = 'https://huggingface.co/';
const SHERPA = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/';

const APPLE_SPEECH_SRC = path.join(ROOT, 'native', 'apple-speech'); // from source only: not in the installers

export const SILERO_VAD: SileroVadFile = { label: 'Silero VAD', url: `${SHERPA}silero_vad.onnx`, file: 'silero_vad.onnx' };
const MEL_FILTERS_URL = 'https://raw.githubusercontent.com/openai/whisper/main/whisper/assets/mel_filters.npz';

/**
 * Speech-to-text models the app can switch between, in ranking order. WER = word error rate on the FLEURS Romanian
 * benchmark (read speech; lower is better), from the sources noted in `notes`.
 * `tier` and `reason` (#28) come from the one-hour benchmark on an M5 (benchmarks/runs/2026-11-02_20-09_mac-m5:
 * the same 100 FLEURS clips for every model; WER with diacritics, speed, live-text steadiness, noise, silence):
 *   'recommended'  within reach of the best local model, steady live text, fast enough to refresh it every 0.5 s,
 *                  a license that allows the use; the menu lists them first
 *   'other'        the rest, each with its reason in one line (less accurate, slow, no punctuation, a license, Python)
 * Every model that can use the GPU does; the CPU is only the fallback when the GPU cannot load or run it.
 *   engine 'whisper.cpp':    a ggml file run by whisper-server on the GPU (Metal); `--no-gpu` if that fails.
 *   engine 'transcribe.cpp': a GGUF file run in-process by transcribe.cpp on the GPU (Metal); CPU if that fails.
 *   engine 'python-nemo':    NVIDIA NeMo files run by python/nemo_server.py (needs python/.venv), on the GPU through
 *                            PyTorch MPS, CPU if that fails; a language-model beam search stays on the CPU.
 *   engine 'sherpa-onnx':    a NeMo transducer exported to ONNX, run in-process by sherpa-onnx on the CPU: the one
 *                            engine without a GPU path (#60), so its models say "CPU" in their reason.
 *   engine 'apple-speech':   Apple's on-device recognizer (macOS 26), run by a small Swift helper that is
 *                            compiled once on this Mac; macOS downloads and manages the language model itself.
 *   engine 'elevenlabs':     ElevenLabs' realtime speech-to-text, in the cloud (`cloud`): the audio leaves the
 *                            computer. Nothing to download; offered only with an API key (ELEVENLABS_API_KEY).
 * Models with `convert` are Hugging Face Whisper fine-tunes: the safetensors are downloaded,
 * converted to whisper.cpp's format and quantized once, then only the result is kept.
 */
export const MODELS: Model[] = [
  {
    id: 'canary-1b-v2',
    label: 'NVIDIA Canary 1B v2',
    tier: 'recommended',
    reason: 'most accurate (6 % WER), fast, invents nothing on silence',
    engine: 'transcribe.cpp',
    size: '1.1 GB',
    notes: 'Default. Romanian WER 6.6 % (NVIDIA). Fast on the GPU.',
    file: 'canary-1b-v2-Q8_0.gguf',
    url: `${HF}handy-computer/canary-1b-v2-gguf/resolve/main/canary-1b-v2-Q8_0.gguf`,
  },
  {
    id: 'parakeet-ultra',
    label: 'Parakeet Ultra 0.6B',
    tier: 'recommended',
    reason: 'fast (72×), 10 % WER, CC-BY',
    engine: 'transcribe.cpp',
    size: '740 MB',
    notes: 'Moondream retrain of Parakeet v3. Romanian WER ~9–10 %. Very fast on the GPU.',
    file: 'parakeet-ultra-Q8_0.gguf',
    url: `${HF}handy-computer/parakeet-ultra-gguf/resolve/main/parakeet-ultra-Q8_0.gguf`,
  },
  {
    id: 'jackrabbit-110m-ro',
    label: 'Jackrabbit 110M Romanian (Surogate)',
    tier: 'other',
    reason: '7.8 % WER, steadiest live text; non-commercial, needs Python',
    engine: 'python-nemo',
    size: '2.5 GB',
    notes: 'Romanian-only (Sept 2026). FLEURS WER 5.7 % with its language model (authors). Non-commercial license. Python/NeMo on the GPU (MPS), its language model on the CPU; loads in ~1 min.',
    dir: 'jackrabbit-110m-ro',
    files: [
      { file: 'jackrabbit-110m-ro.nemo', mb: 466, url: `${HF}surogate/jackrabbit-110m-ro/resolve/main/jackrabbit-110m-ro.nemo` },
      { file: 'lm-4gram-ro.nemo', mb: 2068, url: `${HF}surogate/jackrabbit-110m-ro/resolve/main/lm-4gram-ro.nemo` },
    ],
    nemo: { model: 'jackrabbit-110m-ro.nemo', lm: 'lm-4gram-ro.nemo', decoder: 'ctc-lm' },
    python: true,
  },
  {
    id: 'whisper-large-v3',
    label: 'Whisper large-v3',
    tier: 'other',
    reason: '9 % WER but slow (7×): live text refreshes every ~3 s',
    engine: 'whisper.cpp',
    size: '1.1 GB',
    notes: 'Romanian WER ~8.2 %. Full decoder: a bit more accurate than turbo, ~2× slower.',
    file: 'ggml-large-v3-q5_0.bin',
    dockerSlow: true, // large Whisper decoders need the GPU; ~6 s per sentence on Docker's CPU
    url: `${HF_WHISPER}ggml-large-v3-q5_0.bin`,
  },
  {
    id: 'orukeet',
    label: 'Orukeet 0.6B',
    tier: 'other',
    reason: '10.2 % WER, fast (76×); like Parakeet Ultra, CC-BY-SA',
    engine: 'transcribe.cpp',
    size: '740 MB',
    notes: 'Parakeet-style multilingual model (Sept 2026). Romanian WER 9.3 % (authors). CC-BY-SA-4.0. GPU.',
    file: 'orukeet-transcribe-cpp-Q8_0.gguf',
    url: `${HF}oruk/orukeet/resolve/main/orukeet-transcribe-cpp-Q8_0.gguf`,
  },
  {
    id: 'ro-fast-conformer',
    label: 'FastConformer Romanian 114M (UPB NLP)',
    tier: 'other',
    reason: '11.3 % WER; lowercase, no punctuation; needs Python; no license',
    engine: 'python-nemo',
    size: '454 MB',
    notes: 'Romanian-only model from UPB (MDPI Appl. Sci. 16:1928). FLEURS WER 11.6 % (measured here). Lowercase, no punctuation. No license stated. Python/NeMo on the GPU (MPS).',
    dir: 'ro-fast-conformer',
    files: [
      { file: 'ro-fast-conformer.nemo', mb: 454, url: `${HF}upb-nlp/ro-fast-conformer/resolve/main/Speech_To_Text_Finetuning.nemo` },
    ],
    nemo: { model: 'ro-fast-conformer.nemo', decoder: 'rnnt' }, // RNNT 11.6 %, its CTC head 13.7 % on FLEURS
    python: true,
  },
  {
    id: 'whisper-large-v3-ro-buzzasr',
    label: 'Whisper large-v3 Romanian (BuzzASR)',
    tier: 'other',
    reason: '11.7 % WER, slowest (4×)',
    engine: 'whisper.cpp',
    size: '1.7 GB',
    downloadSize: '3.1 GB', // converted locally; only the 1.7 GB result is kept
    notes: 'Whisper large-v3 fine-tuned on Romanian. FLEURS WER 9.8 % (authors). MIT. Converted locally.',
    file: 'ggml-large-v3-ro-buzzasr-q8_0.bin',
    dockerSlow: true, // large Whisper decoders need the GPU; ~6 s per sentence on Docker's CPU
    convert: { repo: 'BuzzASR/romanian', revision: 'main', quantize: 'q8_0' },
  },
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper large-v3 turbo',
    tier: 'other',
    reason: '11.9 % WER: drops diacritics (9.2 % without them)',
    engine: 'whisper.cpp',
    size: '874 MB',
    notes: 'Romanian WER ~8–11 %. Writes proper names with capitals more reliably than Canary.',
    file: 'ggml-large-v3-turbo-q8_0.bin',
    dockerSlow: true, // large Whisper decoders need the GPU; ~6 s per sentence on Docker's CPU
    url: `${HF_WHISPER}ggml-large-v3-turbo-q8_0.bin`,
  },
  {
    id: 'parakeet-tdt-0.6b-v3', // same id as the sherpa-onnx (CPU) build it replaced, so a saved choice still works
    label: 'NVIDIA Parakeet TDT 0.6B v3',
    tier: 'other',
    reason: '12.1 % WER; Parakeet Ultra is its better retrain',
    engine: 'transcribe.cpp',
    size: '740 MB',
    notes: 'Romanian WER ~12.4 % (NVIDIA). Auto-detects language. GPU.',
    file: 'parakeet-tdt-0.6b-v3-Q8_0.gguf',
    url: `${HF}handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/main/parakeet-tdt-0.6b-v3-Q8_0.gguf`,
  },
  {
    id: 'parakeet-ro-110m',
    label: 'Parakeet Romanian 110M (Politehnica)',
    tier: 'other',
    reason: '12.6 % WER; fastest (216×); lowercase, no punctuation',
    engine: 'transcribe.cpp',
    size: '135 MB',
    notes: 'Romanian-only model from UPB (arXiv 2511.03361). FLEURS WER ~10.6 %. Lowercase, no punctuation. Tiny and fast.',
    file: 'Sped_ParakeetRomanian_110M_TDT-CTC-Q8_0.gguf',
    url: `${HF}jonah1024/Sped_ParakeetRomanian_110M_TDT-CTC_gguf/resolve/main/Sped_ParakeetRomanian_110M_TDT-CTC-Q8_0.gguf`,
  },
  {
    id: 'apple-dictation',
    label: 'Apple on-device dictation (macOS)',
    tier: 'other',
    reason: '16.7 % WER, 53 % in noise; no punctuation; macOS 26 only',
    engine: 'apple-speech',
    size: '~ macOS',
    notes: "Apple's own speech recognition (macOS 26 DictationTranscriber), fully on this Mac. macOS downloads the Romanian model the first time.",
    file: 'apple-speech-server',
    apple: { module: 'dictation' },
  },
  {
    id: 'whisper-small-ro-readerbench',
    label: 'Whisper small Romanian (readerbench)',
    tier: 'other',
    reason: '19.4 % WER; invents text on silence; fails on long sentences',
    engine: 'whisper.cpp',
    size: '260 MB',
    downloadSize: '967 MB', // converted locally; only the 260 MB result is kept
    notes: 'Whisper small fine-tuned on Romanian. FLEURS WER 10.9 % (authors). Apache-2.0. Converted locally.',
    file: 'ggml-small-ro-readerbench-q8_0.bin',
    convert: { repo: 'readerbench/whisper-ro', revision: 'refs/pr/2', quantize: 'q8_0' }, // PR 2 = safetensors
    noPrompt: true, // previous-text context makes this small model invent words ("in afecțiunea")
  },
  // #60: added from the November 2026 scan and not measured here yet, so they wait at the end of the local models
  // until `npm run benchmark:suite` places them by the #28 rules.
  {
    id: 'nemotron-unified-0.6b',
    label: 'NVIDIA Nemotron unified 0.6B',
    tier: 'other',
    reason: 'not measured here yet; 9.4 % WER (NVIDIA); needs Python',
    engine: 'python-nemo',
    size: '2.5 GB',
    notes: 'NVIDIA offline + streaming RNNT model (Oct 2026), 25 languages, told it hears Romanian. Romanian WER 9.4 % offline (NVIDIA, FLEURS, MCV and MLS averaged). OpenMDW-1.1. Python/NeMo on the GPU (MPS).',
    dir: 'nemotron-unified-0.6b',
    files: [
      { file: 'nemotron-labs-unified-asr-0.6b.nemo', mb: 2508, url: `${HF}nvidia/nemotron-labs-unified-asr-0.6b/resolve/main/nemotron-labs-unified-asr-0.6b.nemo` },
    ],
    nemo: { model: 'nemotron-labs-unified-asr-0.6b.nemo', decoder: 'rnnt', lang: 'ro' }, // target_lang="ro"; "auto" detects
    python: true,
  },
  {
    id: 'parakeet-redux',
    label: 'Parakeet Redux (Moondream)',
    tier: 'other',
    reason: 'not measured here yet; runs on the CPU (sherpa-onnx); CC-BY',
    engine: 'sherpa-onnx',
    size: '2.5 GB',
    notes: "Moondream's 1.58-bit Parakeet TDT v3 (Sept 2026), in sherpa-onnx's fp32 export (its int8 export is much less accurate). FLEURS Romanian WER 10.3 % (authors). CC-BY-4.0. CPU only.",
    dir: 'parakeet-redux',
    // fp32: the weights are stored dequantized, so the 1.58-bit model is as big on disk as Parakeet v3 in fp32.
    files: [
      { file: 'encoder.onnx', mb: 42, url: `${HF}csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-redux/resolve/main/encoder.onnx` },
      { file: 'encoder.weights', mb: 2435, url: `${HF}csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-redux/resolve/main/encoder.weights` }, // encoder.onnx's external data
      { file: 'decoder.onnx', mb: 47, url: `${HF}csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-redux/resolve/main/decoder.onnx` },
      { file: 'joiner.onnx', mb: 25, url: `${HF}csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-redux/resolve/main/joiner.onnx` },
      { file: 'tokens.txt', mb: 0.1, url: `${HF}csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-redux/resolve/main/tokens.txt` },
    ],
    sherpa: { encoder: 'encoder.onnx', decoder: 'decoder.onnx', joiner: 'joiner.onnx', tokens: 'tokens.txt', modelType: 'nemo_transducer' },
  },
  {
    id: 'fun-asr-mlt-nano',
    label: 'Fun-ASR-MLT-Nano 0.8B (Alibaba)',
    tier: 'other',
    reason: 'not measured here yet; LLM decoder; license unclear',
    engine: 'transcribe.cpp',
    size: '891 MB',
    notes: 'SenseVoice encoder + Qwen3-0.6B decoder, 31 languages (Dec 2025). No Romanian WER published. FunASR Model License v1.1 (the base card says Apache-2.0). GPU.',
    file: 'Fun-ASR-MLT-Nano-2512-Q8_0.gguf',
    url: `${HF}handy-computer/Fun-ASR-MLT-Nano-2512-gguf/resolve/main/Fun-ASR-MLT-Nano-2512-Q8_0.gguf`,
  },
  {
    id: 'elevenlabs-scribe-v2',
    label: 'ElevenLabs Scribe v2 Realtime (cloud)',
    tier: 'other',
    reason: 'cloud: not measured here; costs money, the audio leaves',
    engine: 'elevenlabs',
    size: 'cloud',
    notes: 'Sends the speech to ElevenLabs over the internet, with your API key; ElevenLabs bills each second it receives. Romanian is in its best group (≤ 5 % WER, ElevenLabs); not measured here.',
    cloud: true,
    elevenlabs: { modelId: 'scribe_v2_realtime' },
  },
];

export const findModel = (id: string) => MODELS.find((m) => m.id === id);

export const modelPath = (model: Model) => path.join(MODELS_DIR, (model.file ?? model.dir) as string); // every model has one of the two

export const isInstalled = (model: Model) => (model.cloud ? Boolean(config.elevenlabs.apiKey)
  : fs.existsSync(modelPath(model)) && (!model.python || pythonReady()));

function onPath(cmd: string) {
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => exts.some((ext) => fs.existsSync(path.join(dir, cmd + ext))));
}

/**
 * Whether this computer can run a model at all. Whisper models need whisper.cpp and Jackrabbit needs Python (or uv
 * to set it up). The desktop app ships neither, so on a plain computer only the transcribe.cpp models (Canary,
 * Parakeet...) are offered.
 */
export function isAvailable(model: Model, { whisperBin = 'whisper-server' }: { whisperBin?: string } = {}) {
  if (model.cloud) return isInstalled(model); // without a key it would only be a menu entry that cannot work
  if (model.engine === 'whisper.cpp') return onPath(whisperBin);
  // SpeechAnalyzer is macOS 26 (Darwin 25) and later. Building the helper needs the Xcode command-line tools and its
  // source, which the installers do not ship: the desktop app offers it only once the helper is built.
  if (model.engine === 'apple-speech') {
    return process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 25
      && (isInstalled(model) || (onPath('swiftc') && fs.existsSync(path.join(APPLE_SPEECH_SRC, 'AppleSpeechServer.swift'))));
  }
  if (model.python) return pythonReady() || onPath(process.env.UV_BIN ?? 'uv');
  return true;
}

const downloads = new Map<string, Promise<void>>(); // id -> the install in progress

/** Download (and unpack) a model. onProgress(fraction 0..1). Concurrent calls share one download. */
export function installModel(model: Model, onProgress: OnProgress = () => {}): Promise<void> {
  if (isInstalled(model)) return Promise.resolve();
  if (model.cloud) return Promise.reject(new Error('Nothing to download: put your API key in .env.local as ELEVENLABS_API_KEY=… (see .env.example).'));
  if (!downloads.has(model.id)) {
    const install: (model: Model, onProgress: OnProgress) => Promise<void> = model.engine === 'apple-speech' ? buildAppleSpeech
      : model.convert ? installConverted
      : model.files ? installFiles
      : (m, p) => download(m.url as string, modelPath(m), p); // the rest have a url
    const job = install(model, onProgress).finally(() => downloads.delete(model.id));
    downloads.set(model.id, job);
  }
  return downloads.get(model.id) as Promise<void>;
}

export const isDownloading = (model: Model) => downloads.has(model.id);

/** Compiles native/apple-speech into models/apple-speech-server (a few seconds; nothing is downloaded). */
async function buildAppleSpeech(model: Model, onProgress: OnProgress) {
  const src = APPLE_SPEECH_SRC;
  const dest = modelPath(model);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  const args = [
    '-O', '-parse-as-library', '-o', tmp, path.join(src, 'AppleSpeechServer.swift'),
    // An embedded Info.plist gives the helper a bundle id and the speech-recognition usage text macOS asks for.
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(src, 'Info.plist'),
  ];
  const output = await new Promise((resolve, reject) => {
    const child = spawn('swiftc', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT' ? new Error('swiftc not found. Install the Xcode command-line tools: xcode-select --install') : err));
    child.on('exit', (code) => (code === 0 ? resolve(log) : reject(new Error(`Building the Apple speech helper failed:\n${log.slice(-2000)}`))));
  });
  if (process.env.DEBUG && output) console.log(output);
  fs.renameSync(tmp, dest);
  onProgress(1);
}

export async function download(url: string, dest: string, onProgress: OnProgress = () => {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream); // fetch's stream is the same stream
  body.on('data', (chunk) => {
    received += chunk.length;
    if (total) onProgress(received / total);
  });
  // Per-process temp name: the page and `npm run setup` downloading the same model must not share a file.
  const tmp = `${dest}.${process.pid}.part`;
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

/** Hugging Face Whisper fine-tune -> whisper.cpp ggml, quantized. Sources are kept until the end, so a retry resumes. */
async function installConverted(model: Model, onProgress: OnProgress) {
  const { repo, revision, quantize } = model.convert as WhisperConvert;
  const sources = path.join(MODELS_DIR, '.sources', model.id);
  fs.mkdirSync(sources, { recursive: true });
  const fetchSource = async (name: string, url: string, progress?: OnProgress) => {
    const dest = path.join(sources, name);
    if (!fs.existsSync(dest)) await download(url, dest, progress);
  };
  const hf = (name: string) => `${HF}${repo}/resolve/${encodeURIComponent(revision)}/${name}`;
  await fetchSource('config.json', hf('config.json'));
  await fetchSource('vocab.json', hf('vocab.json'));
  await fetchSource('mel_filters.npz', MEL_FILTERS_URL);
  await fetchSource('model.safetensors', hf('model.safetensors'), (f) => onProgress(f * 0.8));

  const f16 = path.join(sources, `ggml-f16.${process.pid}.bin`);
  await convertHfWhisper({ sourceDir: sources, melFilters: path.join(sources, 'mel_filters.npz'), out: f16, onProgress: (f) => onProgress(0.8 + f * 0.1) });
  let result = f16;
  if (quantize) {
    const quantized = path.join(sources, `ggml-${quantize}.${process.pid}.bin`);
    try {
      await run(process.env.WHISPER_QUANTIZE_BIN ?? 'whisper-quantize', [f16, quantized, quantize]);
      result = quantized;
    } catch (err: any) {
      console.error(`  Could not quantize (${err.message}); keeping the larger f16 model.`);
    }
  }
  fs.renameSync(result, modelPath(model));
  fs.rmSync(sources, { recursive: true, force: true });
  try {
    fs.rmdirSync(path.dirname(sources)); // models/.sources, once nothing else is being converted
  } catch {
    // another conversion is still using it
  }
  onProgress(1);
}

/** A model made of several files in one folder (e.g. NeMo model + language model), plus the Python env if needed. */
async function installFiles(model: Model, onProgress: OnProgress) {
  const dest = modelPath(model);
  if (!fs.existsSync(dest)) {
    const staging = path.join(MODELS_DIR, `.download-${model.id}-${process.pid}`);
    fs.mkdirSync(staging, { recursive: true });
    const files = model.files as ModelFile[]; // installModel picks this installer for models that have them
    const total = files.reduce((n, f) => n + f.mb, 0);
    let done = 0;
    for (const f of files) {
      await download(f.url, path.join(staging, f.file), (x) => onProgress((0.9 * (done + x * f.mb)) / total));
      done += f.mb;
    }
    fs.renameSync(staging, dest);
  }
  if (model.python) await ensurePythonEnv(); // PyTorch + NeMo, ~1.4 GB, first time only
  onProgress(1);
}
