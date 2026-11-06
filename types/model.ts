// The speech models the app can switch between (lib/models.js MODELS), one shape per engine. Phase 1 of
// docs/typescript-migration.md: written from the catalogue as it is.

/** The five runtimes; lib/transcriber.js builds one engine per kind. */
export type EngineKind = 'whisper.cpp' | 'transcribe.cpp' | 'python-nemo' | 'apple-speech' | 'elevenlabs';

/** The Model menu's two groups (#28): 'recommended' first, then 'other', each in ranking order. */
export type Tier = 'recommended' | 'other';

/** One file of a model made of several (the NeMo models): downloaded into the model's folder. */
export interface ModelFile {
  file: string;
  /** Its size, for the progress bar. */
  mb: number;
  url: string;
}

/** A Hugging Face Whisper fine-tune: downloaded, converted to whisper.cpp's format and quantized once (lib/convert-whisper.js). */
export interface WhisperConvert {
  repo: string;
  revision: string;
  /** whisper-quantize's type, e.g. 'q8_0'; without it the f16 conversion is kept. */
  quantize?: string;
}

/** What python/nemo_server.py is started with. */
export interface NemoSpec {
  /** The .nemo file inside the model's folder. */
  model: string;
  /** A language model (.nemo) for the ctc-lm decoder. */
  lm?: string;
  decoder: 'ctc-lm' | 'ctc' | 'rnnt';
}

/** The Apple speech helper's module and preset (native/apple-speech). */
export interface AppleSpec {
  module: string;
  /** 'long' when omitted. */
  preset?: string;
}

export interface ElevenLabsSpec {
  modelId: string;
}

/** What every entry of MODELS has; the per-engine shapes below say which optional fields are present. */
export interface ModelBase {
  id: string;
  label: string;
  tier: Tier;
  /** One line on why the model is where it is in the ranking. */
  reason: string;
  engine: EngineKind;
  /** On disk, as people read it ('1.1 GB'); 'cloud' or '~ macOS' when nothing is downloaded. */
  size: string;
  notes: string;
  /** A single file in the models folder: modelPath() is MODELS_DIR/file. */
  file?: string;
  /** A folder in the models folder, for models made of several files: modelPath() is MODELS_DIR/dir. */
  dir?: string;
  /** Downloaded as it is into `file`. */
  url?: string;
  files?: ModelFile[];
  convert?: WhisperConvert;
  nemo?: NemoSpec;
  /** Needs python/.venv (set up by npm run setup). */
  python?: boolean;
  apple?: AppleSpec;
  elevenlabs?: ElevenLabsSpec;
  /** The audio leaves the computer; offered only with an API key. */
  cloud?: boolean;
  /** What the download is when it differs from `size` (converted locally). */
  downloadSize?: string;
  /** Too slow for live use on Docker's CPU: the menu says so. */
  dockerSlow?: boolean;
  /** Previous-text context makes this model invent words: it gets no prompt. */
  noPrompt?: boolean;
}

/** A GGUF file run in-process by transcribe.cpp. */
export interface TranscribeCppModel extends ModelBase {
  engine: 'transcribe.cpp';
  file: string;
  url: string;
}

/** A ggml file run by whisper-server; downloaded (`url`) or converted locally (`convert`). */
export interface WhisperCppModel extends ModelBase {
  engine: 'whisper.cpp';
  file: string;
}

/** NVIDIA NeMo files in a folder, run by python/nemo_server.py. */
export interface PythonNemoModel extends ModelBase {
  engine: 'python-nemo';
  dir: string;
  files: ModelFile[];
  nemo: NemoSpec;
  python: true;
}

/** Apple's on-device recognizer, run by a helper compiled into `file` (macOS 26, from source only). */
export interface AppleSpeechModel extends ModelBase {
  engine: 'apple-speech';
  file: string;
  apple: AppleSpec;
}

/** ElevenLabs' realtime speech-to-text in the cloud: nothing to download. */
export interface ElevenLabsModel extends ModelBase {
  engine: 'elevenlabs';
  cloud: true;
  elevenlabs: ElevenLabsSpec;
}

export type Model = TranscribeCppModel | WhisperCppModel | PythonNemoModel | AppleSpeechModel | ElevenLabsModel;

/** The voice detector's model file (lib/models.js SILERO_VAD). */
export interface SileroVadFile {
  label: string;
  url: string;
  file: string;
}

/** Download progress, 0..1. */
export type OnProgress = (fraction: number) => void;
