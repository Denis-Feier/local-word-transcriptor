// The WebSocket contract between server.ts / lib/session.ts and web/app.ts, and the BroadcastChannel contract
// between the main window and its caption windows (/?display). Phase 1 of docs/typescript-migration.md: written from
// every send() site and the page's switch, and read against the PROT-* tests.
//
// Binary frames (page → server): Float32 PCM at 16 kHz. On /ws?mics each frame starts with a Uint32 mic count, then
// each mic's samples in turn, all from the same moment; other clients (test/stream-wav.ts) send plain mono audio.
import type { Tuning, TuningPatch, TuningRanges } from './config.ts';
import type { EngineKind, Tier } from './model.ts';
import type { TranscriberStatus } from './engine.ts';
import type { DetectorName } from './audio.ts';

// ---------- server → page ----------

/** One entry of the `models` message: a model as the Model menu shows it (server.ts modelsMessage). */
export interface ModelInfo {
  id: string;
  label: string;
  engine: EngineKind;
  tier: Tier;
  reason: string;
  size: string;
  /** What the download is ('1.1 GB'): `downloadSize` when the model is converted locally, else `size`. */
  download: string;
  notes: string;
  /** The audio leaves the computer: the page says so. */
  cloud: boolean;
  installed: boolean;
  /** Download progress 0..1 while it downloads, else null. */
  progress: number | null;
}

/** The models this computer can run, and the active one. Sent on connect and after every change. */
export interface ModelsMessage {
  type: 'models';
  active: string | null;
  models: ModelInfo[];
}

/** The transcriber's state (Transcriber.status()) plus the language; the first one of a connection names the detector. */
export interface StatusMessage extends TranscriberStatus {
  type: 'status';
  language: string;
  detector?: DetectorName;
}

/** The live settings: current values, defaults and slider ranges. Sent on connect and after every change. */
export interface TuningMessage {
  type: 'tuning';
  values: Tuning;
  defaults: Tuning;
  ranges: TuningRanges;
}

/** How many mics may be used at once (MAX_MICS). */
export interface MicsMessage {
  type: 'mics';
  max: number;
}

/** A model download advanced (whole percents only). */
export interface ProgressMessage {
  type: 'progress';
  id: string;
  progress: number;
}

/** Shown in the page's error bar. */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** Someone started or stopped speaking on a mic; `id` is the sentence's. */
export interface VadMessage {
  type: 'vad';
  mic: number;
  speaking: boolean;
  id: number;
}

/** A live guess of the sentence `id` so far (with Steady live text, only the words two guesses agree on). */
export interface PartialMessage {
  type: 'partial';
  mic: number;
  id: number;
  /** Seconds since the session started. */
  start: number;
  text: string;
}

/**
 * The sentence `id` is over. With `text`, its final line; with `text: ''` the line is taken back (a click, the other
 * speaker heard through this mic, or a model error). A sentence dropped before it was transcribed carries only
 * mic, id and text; one that was transcribed carries its times, and the model and its time when it answered.
 */
export interface FinalMessage {
  type: 'final';
  mic: number;
  id: number;
  text: string;
  start?: number;
  end?: number;
  model?: string;
  ms?: number;
}

/** A transcript or audio file was opened; `name` is the transcript's stamp, which a reconnect sends back (`resume`). */
export interface FileMessage {
  type: 'file';
  kind: 'text' | 'audio';
  /** Audio files only: one per mic. */
  mic?: number;
  name: string;
  /** Relative to the server's working directory. */
  path: string;
}

/** The model is slower than the talk: lines are this many seconds late; 0 when it has caught up. */
export interface BehindMessage {
  type: 'behind';
  seconds: number;
}

/** The server turned saving audio off (a full disk): the page unticks the box. */
export interface ServerOptionsMessage {
  type: 'options';
  saveAudio: boolean;
}

export type ServerMessage =
  | ModelsMessage
  | StatusMessage
  | TuningMessage
  | MicsMessage
  | ProgressMessage
  | ErrorMessage
  | VadMessage
  | PartialMessage
  | FinalMessage
  | FileMessage
  | BehindMessage
  | ServerOptionsMessage;

// ---------- page → server ----------

/** The page's options for this connection; sent on connect and when a box is ticked. */
export interface ClientOptionsMessage {
  type: 'options';
  saveAudio?: boolean;
  steadyLive?: boolean;
}

/**
 * Sent right after (re)connecting (#10): carry on the transcript `name` (null if nothing was saved yet) and set the
 * clock to `samples` per mic already sent. Only before the connection's first audio.
 */
export interface ResumeMessage {
  type: 'resume';
  name: string | null;
  samples: number;
}

/** Stop pressed: end the sentences being spoken now. */
export interface FlushMessage {
  type: 'flush';
}

/** Clear pressed: forget the context and start new files. */
export interface ResetMessage {
  type: 'reset';
}

/** Switch to an installed model. */
export interface SelectMessage {
  type: 'select';
  id: string;
}

/** Download a model; it is selected when done. */
export interface InstallMessage {
  type: 'install';
  id: string;
}

/** A slider moved (`values`), or Reset to defaults (`reset`). */
export interface TuningChangeMessage {
  type: 'tuning';
  values?: TuningPatch;
  reset?: boolean;
}

export type ClientMessage =
  | ClientOptionsMessage
  | ResumeMessage
  | FlushMessage
  | ResetMessage
  | SelectMessage
  | InstallMessage
  | TuningChangeMessage;

// ---------- shared by the server and the page ----------

/**
 * What spokenOrder() (web/order.ts) compares: the page's lines and the server's held lines both have these, so
 * the transcript and the .txt come out in one order (#7, #50).
 */
export interface Spoken {
  /** The connection's number; ids restart with every connection. Missing counts as 0. */
  connection?: number;
  /** Seconds since the session started. */
  start: number;
  id: number;
}

// ---------- main window ↔ caption windows (BroadcastChannel 'transcriber-captions') ----------

/** One line of the projector view: a final sentence or the one being spoken; `mic` only with several mics. */
export interface CaptionRow {
  /** The page's line key (connection and sentence id). */
  key: number;
  text: string;
  mic: number | null;
}

/** What the projector view and the caption windows show (web/app.ts snapshot(), web/stage.ts update()). */
export interface StageSnapshot {
  /** The newest final lines, oldest first. */
  finals: CaptionRow[];
  /** The sentence being spoken on each mic, in key order. */
  partials: CaptionRow[];
  recording: boolean;
  speaking: boolean;
  /** A caption window with no main window to feed it. */
  waiting?: boolean;
}

export type CaptionMessage =
  /** A caption window opened, or answers `here`. */
  | { type: 'hello'; id: string }
  /** A caption window closed. */
  | { type: 'gone'; id: string }
  /** The main window (re)opened: caption windows say hello again. */
  | { type: 'here' }
  /** The main window closed: caption windows show "waiting". */
  | { type: 'bye' }
  /** The projector content, whenever it changes while a caption window listens. */
  | ({ type: 'snapshot' } & StageSnapshot);
