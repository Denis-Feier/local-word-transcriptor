// The page's shapes shared between its modules (web/*.ts): the projector view, the settings panel, mics and speaker.
// Web project only (tsconfig.web.json): these use the DOM's types. Phase 1 of docs/typescript-migration.md; the shapes
// one module alone uses live in that module since Phase 5.
import type { StageSnapshot, TuningMessage } from './protocol.ts';
import type { DetectorName } from './audio.ts';

declare global {
  interface AudioContext {
    /** Chromium's choice of audio output (speaker.ts); the page checks for it first (`canChooseOutput`). */
    setSinkId(sinkId: string | { type: 'none' }): Promise<void>;
  }
}

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

/** openCapture(): the mics recording. */
export interface Capture extends MicFeed {
  slots: MicSlot[];
}

/** openSpeaker(): the mics playing on an output. */
export interface Speaker extends MicFeed {
  slots: MicSlot[];
  sinkId: string;
  setVolume(value: number): void;
  /** Each mic's RMS level over the last ~0.1 s; 0 for a missing mic. */
  levels(): number[];
}
