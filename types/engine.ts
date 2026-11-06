// What lib/transcriber.js needs from a speech engine, and what it gives the session. Phase 1 of
// docs/typescript-migration.md: written from the engines in lib/engines/ and the transcriber as they are.
import type { Model } from './model.ts';

export interface TranscribeOptions {
  /** The end of the transcript so far (or the initial prompt), for engines that take one. */
  prompt?: string;
  /** whisper.cpp: retry at higher temperatures (off for throwaway live guesses). */
  fallback?: boolean;
}

/** What an engine answers for a sentence. */
export interface TranscribeResult {
  text: string;
}

/** What Transcriber.transcribe() and a stream's commit() resolve to: the engine's answer, timed and attributed. */
export interface TimedResult extends TranscribeResult {
  /** Inference time. */
  ms: number;
  /** The id of the model that answered. */
  model: string;
}

export interface StreamOptions {
  prompt?: string;
  /** The live text so far, as the model sends it. */
  onPartial?: (text: string) => void;
}

/**
 * A sentence sent to a streaming engine while it is spoken (lib/engines/elevenlabs.js Sentence): push(samples) as the
 * audio comes, commit() at the end for its text, cancel() to drop it.
 */
export interface StreamingSentence {
  push(samples: Float32Array): void;
  commit(): Promise<TranscribeResult>;
  cancel(): void;
  /** Finished, one way or the other. */
  readonly closed: boolean;
  /** commit() was called; the text is on its way. */
  readonly committing: boolean;
  /** Resolves once the service is listening (used to check the key); rejects when the connection fails. */
  readonly ready: Promise<void>;
  readonly result: Promise<TranscribeResult>;
}

/** The transcriber's handle on a streamed sentence, as lib/session.js uses it (Transcriber.stream()). */
export interface SessionStream {
  push(samples: Float32Array): void;
  cancel(): void;
  /** Still open: the model was not switched and the connection did not fail. */
  live(): boolean;
  commit(): Promise<TimedResult>;
}

/** One speech engine: owns one loaded model. */
export interface Engine {
  /** Takes a previous-text prompt (whisper.cpp, ElevenLabs). */
  readonly supportsPrompt: boolean;
  /** Where the model runs once loaded: 'GPU (Metal)', 'CPU', …; null or unset before load(). */
  device?: string | null;
  /** Why the GPU was not used, when it was not. */
  fallback?: string | null;
  load(): Promise<void>;
  unload(): Promise<void>;
  /** Synchronous last-resort cleanup for process exit. */
  kill(): void;
  transcribe(samples: Float32Array, opts?: TranscribeOptions): Promise<TranscribeResult>;
  /** Streaming engines only (ElevenLabs): a sentence to send while it is spoken. */
  stream?(opts?: StreamOptions): StreamingSentence;
}

/** How an engine served by a separate process is started (lib/engines/sidecar.js command()). */
export interface SidecarCommand {
  /** For the log lines. */
  name: string;
  bin: string;
  args: string[];
  /** What to tell the user when `bin` is not there. */
  missing: string;
  env?: Record<string, string>;
}

/** The answer of a POST to a sidecar process. */
export interface SidecarResponse {
  ok: boolean;
  status: number;
  text: string;
}

/** What a SidecarEngine subclass provides. */
export interface SidecarHooks {
  /** Start again on the CPU when the GPU start fails. */
  cpuFallback?: boolean;
  /** The device when the process says nothing about it. */
  defaultDevice?: string;
  command(port: number, opts: { cpu?: boolean }): SidecarCommand;
  /** The device named in a log line, or null when the line says nothing about it. */
  deviceFromLog?(line: string): string | null;
}

/** Called once when an engine's process dies, before the request it was serving fails (#45). */
export type OnCrash = (message: string) => void;

export type TranscriberState = 'idle' | 'loading' | 'ready' | 'error';

/** Transcriber.status(), also the body of the `status` message to the page. */
export interface TranscriberStatus {
  state: TranscriberState;
  message: string;
  /** The id of the chosen model. */
  model: string | null;
  device: string | null;
  fallback: string | null;
}

/** The transcriber's events: 'state' carries its status. */
export interface TranscriberEvents {
  state: [status: TranscriberStatus];
}

/** Transcriber.createEngine: a test stands in a fake engine by replacing it. */
export type CreateEngine = (model: Model, onCrash: OnCrash) => Engine;
