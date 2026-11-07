// Emits the page: web/*.ts → public/*.js (docs/typescript-migration.md, D2). The emitted files are committed and served
// as they are, so a stale one would ship old code while the source says otherwise: STATIC-07 fails then, and
// `node scripts/build-web.ts` (npm run build:web) brings public/ up to date; `--check` only says which files differ.
// The page imports the shared types in types/, and tsc wants every source file under rootDir (the repository, then),
// so the emit goes to a temporary folder and only web/'s output is copied into public/.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/** The page as tsc emits it from web/*.ts: file name → JavaScript. Throws with tsc's first lines when the types do not check. */
export function emitWeb(): Map<string, string> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'live-transcriber-web-'));
  try {
    try {
      execFileSync(process.execPath, [TSC, '-p', path.join(ROOT, 'tsconfig.web.json'), '--noEmit', 'false', '--outDir', out], { cwd: ROOT, stdio: 'pipe' });
    } catch (err: any) {
      const lines = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').filter(Boolean);
      throw new Error(`tsc -p tsconfig.web.json failed: ${lines[0] ?? err.message}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ''}`);
    }
    const dir = path.join(out, 'web');
    return new Map(fs.readdirSync(dir).sort().map((name) => [name, fs.readFileSync(path.join(dir, name), 'utf8')]));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

/** What differs between the emit and public/: emitted files that are missing or different there, and public/*.js files with no source in web/. */
export function staleWebFiles(emitted: Map<string, string> = emitWeb()): string[] {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(ROOT, 'public', name), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout may have CRLF
    } catch {
      return null;
    }
  };
  const stale = [...emitted].filter(([name, js]) => read(name) !== js).map(([name]) => name);
  const orphans = fs.readdirSync(path.join(ROOT, 'public')).filter((name) => name.endsWith('.js') && !emitted.has(name));
  return [...stale, ...orphans.map((name) => `${name} (no source in web/)`)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const emitted = emitWeb();
  const stale = staleWebFiles(emitted);
  if (process.argv.includes('--check')) {
    console.log(stale.length ? `public/ is stale: ${stale.join(', ')} (npm run build:web)` : `public/ is current (${emitted.size} files)`);
    process.exit(stale.length ? 1 : 0);
  }
  for (const name of fs.readdirSync(path.join(ROOT, 'public'))) if (name.endsWith('.js') && !emitted.has(name)) fs.rmSync(path.join(ROOT, 'public', name));
  for (const [name, js] of emitted) fs.writeFileSync(path.join(ROOT, 'public', name), js);
  console.log(stale.length ? `public/: ${stale.join(', ')}` : `public/ was current (${emitted.size} files)`);
}
