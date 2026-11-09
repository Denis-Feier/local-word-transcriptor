// End-to-end check that runs on any OS (CI runs it before building the installers): starts the server with
// a fresh models folder, lets it download the small Romanian model by itself, streams test/fixtures/ro.wav
// and requires the expected words in the transcript. Then streams it again as two mics, where the second mic only
// hears the speaker from across the room, and requires every sentence on mic 1.
//
//   node test/smoke.ts                          (SMOKE_MODEL=canary-1b-v2 to test another model)
//
// SMOKE-03, the installed app (CI runs it after building each installer): `--app dist` runs the server inside the app
// that electron-builder left in dist/, with that app's own Electron as Node, its own libraries, the model it carries and
// an empty models folder, as on a computer that never had the app. The fixture must come out with nothing downloaded,
// and on Windows the Visual C++ runtime must be the app's own copy, not whatever Windows has.
//
//   node test/smoke.ts --app dist
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as import('node:net').AddressInfo; // listening on a TCP port
      probe.close(() => resolve(port));
    });
  });
}

/** The unpacked app electron-builder leaves in dist/ for this OS: its folder, executable and resources folder. */
function findApp(dist: string): { dir: string; exe: string; resources: string } {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (process.platform === 'darwin') {
    // dist/mac-arm64/Live Transcriber.app (dist/mac/ for Intel); Contents/MacOS holds only the app's executable
    const bundle = [dist, ...fs.readdirSync(dist).map((d) => path.join(dist, d))]
      .flatMap((d) => (fs.statSync(d).isDirectory() ? fs.readdirSync(d).filter((f) => f.endsWith('.app')).map((f) => path.join(d, f)) : []))[0];
    if (!bundle) throw new Error(`no .app in ${dist}`);
    const macos = path.join(bundle, 'Contents', 'MacOS');
    return { dir: bundle, exe: path.join(macos, fs.readdirSync(macos)[0] as string), resources: path.join(bundle, 'Contents', 'Resources') };
  }
  const dir = path.join(dist, process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked');
  const exe = [`${pkg.productName}.exe`, pkg.productName, pkg.name].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
  if (!exe) throw new Error(`no app executable in ${dir}`);
  return { dir, exe, resources: path.join(dir, 'resources') };
}

/** Windows: the files the process has loaded for the Visual C++ runtime (msvcp140.dll, vcruntime140*.dll). */
function loadedRuntime(pid: number): string[] {
  const script = `(Get-Process -Id ${pid}).Modules | Where-Object { $_.ModuleName -match '^(msvcp140|vcruntime140(_1)?)\\.dll$' } | ForEach-Object { $_.FileName }`;
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const appIdx = process.argv.indexOf('--app');
const app = appIdx >= 0 ? findApp(path.resolve(ROOT, process.argv[appIdx + 1] ?? 'dist')) : null;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'transcriber-smoke-'));
const port = await freePort();
const modelsDir = app ? path.join(tmp, 'models') : process.env.SMOKE_MODELS_DIR ?? path.join(tmp, 'models');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PORT: String(port),
  MODEL: process.env.SMOKE_MODEL ?? 'parakeet-ro-110m', // 135 MB, so CI downloads stay small
  AUTO_INSTALL: '1',
  MODELS_DIR: modelsDir,
  SETTINGS_FILE: path.join(tmp, 'settings.json'),
  TRANSCRIPTS_DIR: path.join(tmp, 'transcripts'),
};
if (app) {
  delete env.MODEL; // the app's default model, the one it carries
  env.ELECTRON_RUN_AS_NODE = '1'; // the app's executable runs server.ts as Node, as its utility process does
  env.BUNDLED_MODELS_DIR = path.join(app.resources, 'models'); // what desktop/main.ts passes
  console.log(`  The installed app: ${app.exe}`);
}

const serverFile = app ? path.join(app.resources, 'app', 'server.ts') : path.join(ROOT, 'server.ts');
const server = spawn(app ? app.exe : process.execPath, [serverFile], { env, stdio: ['ignore', 'inherit', 'inherit'] });
let code = 1;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
    } catch {
      if (i > 120) throw new Error('server did not start');
      await sleep(250);
    }
  }
  const stream = (args: string[], minutes: number): Promise<number> => {
    const test = spawn(process.execPath, [path.join(ROOT, 'test', 'stream-wav.ts'), path.join(ROOT, 'test', 'fixtures', 'ro.wav'), ...args], { env, stdio: 'inherit' });
    const timer = setTimeout(() => test.kill(), minutes * 60 * 1000);
    return (new Promise((resolve) => test.on('exit', (c) => resolve(c ?? 1))) as Promise<number>).finally(() => clearTimeout(timer));
  };
  if (app) {
    code = await stream(['--speed', '2', '--expect', 'munții'], 10); // the default model may be on the CPU here
    const downloaded = fs.existsSync(modelsDir) ? fs.readdirSync(modelsDir) : [];
    const problems = [code !== 0 && 'the fixture did not come out', downloaded.length && `it downloaded ${downloaded.join(', ')}`];
    if (process.platform === 'win32') {
      const runtime = loadedRuntime(server.pid as number);
      const foreign = runtime.filter((f) => path.dirname(f).toLowerCase() !== app.dir.toLowerCase());
      console.log(`  Visual C++ runtime loaded: ${runtime.join(', ') || 'none'}`);
      problems.push(!runtime.some((f) => /msvcp140\.dll$/i.test(f)) && 'msvcp140.dll is not loaded', foreign.length && `from outside the app: ${foreign.join(', ')}`);
    }
    const failed = problems.filter(Boolean);
    console.log(`  ${failed.length ? '✖' : '✔'} SMOKE-03 the installed app transcribes with the model it carries, nothing downloaded${process.platform === 'win32' ? ', its own Visual C++ runtime' : ''}${failed.length ? ` — ${failed.join('; ')}` : ''}`);
    code = failed.length ? 1 : 0;
  } else {
    code = await stream(['--speed', '3', '--expect', 'munții'], 10); // includes the model download
    // Two mics: the second only hears the speaker from across the room (quieter, late like Bluetooth),
    // so every sentence must stay on mic 1.
    if (code === 0) code = await stream(['--mic2', 'silence', '--bleed', '12', '--lag', '150', '--only-mic', '1', '--speed', '3', '--expect', 'munții'], 2);
  }
} catch (err: any) {
  console.error(`✖ ${err.message}`);
} finally {
  server.kill();
  await sleep(500);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may still hold the model file for a moment; the OS cleans its temp folder
  }
}
console.log(code === 0 ? '✔ smoke test passed' : '✖ smoke test failed');
process.exit(code);
