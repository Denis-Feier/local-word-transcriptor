// What lib/transcriber.ts needs from a speech engine, and what it gives the session. Phase 1 of
// docs/typescript-migration.md: written from the engines in lib/engines/ and the transcriber as they are.

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
 * A sentence sent to a streaming engine while it is spoken (lib/engines/elevenlabs.ts Sentence): push(samples) as the
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

/** The transcriber's handle on a streamed sentence, as lib/session.ts uses it (Transcriber.stream()). */
export interface SessionStream {
  push(samples: Float32Array): void;
  cancel(): void;
  /** Still open: the model was not switched and the connection did not fail. */
  live(): boolean;
  commit(): Promise<TimedResult>;
}

/** One speech engine: owns one loaded model. */
export interface Engine {
  /** Takes a previous-text prompt (whisper.cpp, ElevenLabs); unset counts as no. */
  readonly supportsPrompt?: boolean;
  /** Where the model runs once loaded: 'GPU (Metal)', 'CPU', …; null or unset before load(). */
  device?: string | null;
  /** Why the GPU was not used, when it was not; null or undefined when it was (the engines differ). */
  fallback?: string | null | undefined;
  load(): Promise<void>;
  unload(): Promise<void>;
  /** Synchronous last-resort cleanup for process exit. */
  kill(): void;
  transcribe(samples: Float32Array, opts?: TranscribeOptions): Promise<TranscribeResult>;
  /** Streaming engines only (ElevenLabs): a sentence to send while it is spoken. */
  stream?(opts?: StreamOptions): StreamingSentence;
}

/** How an engine served by a separate process is started (lib/engines/sidecar.ts command()). */
export interface SidecarCommand {
  /** For the log lines. */
  name: string;
  bin: string;
  args: string[];
  /** What to tell the user when `bin` is not there. */
  missing: string;
  env?: Record<string, string>;
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
