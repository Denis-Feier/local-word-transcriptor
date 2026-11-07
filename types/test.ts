// What test/helpers.ts hands the test suites, as far as several of them use it. Phase 1 of docs/typescript-migration.md;
// the shapes one file alone uses live in that file since Phase 5.

export interface StartServerOptions {
  /** The model to start with; null starts without MODEL (the saved or default one). */
  model?: string | null;
  /** Extra environment; a value of undefined removes the variable. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Cap every file the server writes at this many blocks (ulimit -f), like a disk that fills up. */
  maxFileBlocks?: number | null;
}

/** startServer(): an isolated server.ts with its own settings and transcripts folders. */
export interface TestServer {
  port: number;
  pid: number | undefined;
  /** Its scratch folder; stop() removes it. */
  dir: string;
  url: string;
  ws(query?: string): string;
  /** Everything it printed so far. */
  log(): string;
  transcripts: string;
  settingsFile: string;
  stop(): Promise<void>;
}

/** One final line as test/stream-wav.ts prints it. */
export interface StreamedFinal {
  id: number;
  /** 1-based, as printed. */
  mic: number;
  start: number;
  end: number;
  ms: number;
  text: string;
}

/** streamWav(). */
export interface StreamResult {
  finals: StreamedFinal[];
  /** The mic (1-based) of each live guess. */
  partials: number[];
  code: number | null;
  out: string;
  timedOut: boolean;
  seconds: number;
}

/** One connection to the ElevenLabs stand-in, as it records it. */
export interface FakeConnection {
  index: number;
  key: string | string[] | undefined;
  query: Record<string, string>;
  /** Everything received, 16-bit. */
  audio: Int16Array;
  /** Samples per message. */
  chunks: number[];
  previousText: (string | null)[];
  commits: number;
  committed: boolean;
  closed: boolean;
}

/** fakeElevenLabs(). */
export interface FakeElevenLabs {
  url: string;
  connections: FakeConnection[];
  /** Resolves once the socket server has closed (with whatever its close callback was given). */
  close(): Promise<unknown>;
}

/** fakeServer(): serves the page and sends it whatever a test wants. */
export interface FakeServer {
  url: string;
  /** To the newest connection; anything a test wants the page to get, a real message or not. */
  send(msg: object): void;
  close(): Promise<unknown>;
}

export type CaseStatus = 'pass' | 'fail' | 'known' | 'skip';

export interface TestCase {
  id: string;
  title: string;
  status: CaseStatus;
  detail: string;
}

/** suite(): pass/fail bookkeeping; finish() writes the JSON result run-all.ts collects. */
export interface Suite {
  check(id: string, title: string, ok: boolean, detail?: string, opts?: { known?: boolean }): boolean;
  skip(id: string, title: string, reason: string): void;
  finish(): void;
}

/** What a suite writes to TEST_RESULT. */
export interface SuiteResult {
  name: string;
  cases: TestCase[];
}
