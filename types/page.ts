// The page's shapes (web/*.ts): the projector view, the settings panel, mics, speaker, backlog and transcript lines.
// Web project only (tsconfig.web.json): these use the DOM's types. Phase 1 of docs/typescript-migration.md.
import type { ClientMessage, Spoken, StageSnapshot, TuningMessage } from './protocol.ts';
import type { DetectorName } from './audio.ts';

export type { Backlog, BacklogTaken } from './audio.ts';

declare global {
  interface AudioContext {
    /** Chromium's choice of audio output (speaker.ts); the page checks for it first (`canChooseOutput`). */
    setSinkId(sinkId: string | { type: 'none' }): Promise<void>;
  }
}
import type { TranscriberState } from './engine.ts';

export type { CaptionRow, Spoken, StageSnapshot } from './protocol.ts';

// ---------- projector view (stage.ts) ----------

export type Theme = 'dark' | 'contrast' | 'light';

/** Stored in this browser (localStorage 'stage'); every window of the page follows it. */
export interface StagePrefs {
  /** Text size in % of the screen width. */
  size: number;
  /** Final lines shown, 1–5. */
  lines: number;
  theme: Theme;
}

/** Omitted hooks hide their buttons. */
export interface StageHooks {
  /** Start / Stop. */
  onToggle?(): void;
  onSettings?(): void;
  onClose?(): void;
}

/** createStage(): the projector view and the caption-only window. */
export interface Stage {
  readonly open: boolean;
  show(opts?: { fullscreen?: boolean }): void;
  hide(): void;
  update(snapshot: StageSnapshot): void;
  readonly prefs: StagePrefs;
  setPrefs(patch: Partial<StagePrefs>): void;
}

// ---------- settings panel (settings.ts) ----------

export interface SettingsHooks {
  send(msg: ClientMessage): void;
  onDisplayPrefs(patch: Partial<StagePrefs>): void;
  onOpenDisplay(): void;
}

/** createSettings(). */
export interface SettingsPanel {
  open(): void;
  close(): void;
  toggle(): void;
  setTuning(msg: TuningMessage): void;
  /** The threshold slider does nothing with the loudness detector. */
  setDetector(name: DetectorName): void;
  /** Mic separation does nothing with one mic. */
  setMics(count: number): void;
}

// ---------- microphones and speaker (mics.ts, speaker.ts) ----------

/** A chosen mic, in order (Mic 1, Mic 2, …); id '' is the system default. Remembered without its mute. */
export interface MicPick {
  id: string;
  /** The device's name, to find it again if its id changes (a re-paired Bluetooth device). */
  label: string;
  muted?: boolean;
}

/** The chosen output; id '' is the system default. */
export interface SpeakerPick {
  id: string;
  label: string;
}

/** The browser's noiseSuppression and autoGainControl for one use of a mic. */
export interface MicProcessing {
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

/** One opened mic (openMics). A mic that could not be opened has no stream and an error. */
export interface MicSlot {
  deviceId: string;
  stream: MediaStream | null;
  source: MediaStreamAudioSourceNode | null;
  /** The track's sample rate, once attached. */
  rate: number | null;
  error: unknown;
  muted: boolean;
  /** A reattach is in progress. */
  opening?: boolean;
}

/** feedMics(): the mics kept fed into an AudioContext. */
export interface MicFeed {
  /** Try again to open a mic that is missing. */
  reattach(input: number, deviceId: string): Promise<void>;
  /** Muted, a mic sends silence but stays open. */
  mute(input: number, muted: boolean): void;
  close(): void;
}

export interface CaptureOptions {
  noiseSuppression: boolean;
  /** Per mic. */
  muted: boolean[];
  /** Each ~100 ms chunk (see pcm-worklet.ts): a Uint32 mic count, then each mic's 1600 samples. */
  onChunk(buffer: ArrayBuffer): void;
  /** A mic disconnected or came back. */
  onChange(): void;
}

/** openCapture(): the mics recording. */
export interface Capture extends MicFeed {
  slots: MicSlot[];
}

export interface SpeakerOptions {
  /** The output; '' is the system default. */
  sinkId: string;
  /** 0–1. */
  volume: number;
  muted: boolean[];
  onChange(): void;
}

/** openSpeaker(): the mics playing on an output. */
export interface Speaker extends MicFeed {
  slots: MicSlot[];
  sinkId: string;
  setVolume(value: number): void;
  /** Each mic's RMS level over the last ~0.1 s; 0 for a missing mic. */
  levels(): number[];
}

/** listInputs(): the audio inputs and the one behind "System default". */
export interface Inputs {
  inputs: MediaDeviceInfo[];
  defaultId: string;
}

// ---------- transcript (app.ts, order.ts) ----------

/** One line of the transcript as the page keeps it (the `lines` map), live or final. */
export interface Line extends Spoken {
  el: HTMLElement;
  connection: number;
  text: string;
  end?: number;
  mic: number;
  /** Shows its mic's name and colour (several mics). */
  labeled: boolean;
  final: boolean;
  /** The other mics spoken at the same time as this line. */
  with?: Set<number>;
}

/** The page's view of the server's transcriber: the last status message, or the connecting placeholder. */
export interface EngineView {
  state: TranscriberState;
  message: string;
  model: string | null;
  device?: string | null;
  fallback?: string | null;
}

/** The page's wrapper over localStorage: JSON values, a fallback when there is none or storage is blocked. */
export interface Store {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}
