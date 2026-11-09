// Gathers what the installers carry beside the app, so that the installed app works the first time with nothing to
// install and nothing to download. `npm run dist:mac` and `npm run dist:win` run it before electron-builder:
//
//   bundle/models/       the default model (Canary) and the Silero voice detector, in both installers
//                        (package.json build.extraResources → <app>/resources/models, read through BUNDLED_MODELS_DIR)
//   bundle/vc-runtime/   Windows only: the Visual C++ runtime that transcribe.cpp's DLLs need, 14.40 or newer, put next
//                        to the app's .exe (build.win.extraFiles), where Windows looks before its own folders
//
//   node scripts/bundle.ts --mac | --win
//
// The models are copied from models/ when they are there (npm run setup), else downloaded; bundle/ keeps them for the
// next build. The runtime comes from Visual Studio's redistributable folder or, failing that, Windows' own copy;
// VC_RUNTIME_DIR=<a folder with the three DLLs> picks another.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MODELS_DIR, ROOT, config } from '../lib/config.ts';
import { SILERO_VAD, download, findModel } from '../lib/models.ts';

export const BUNDLE = path.join(ROOT, 'bundle');
/** The DLLs transcribe.cpp's prebuilt Windows libraries import besides Windows' own (MSVCP140, VCRUNTIME140, _1). */
export const VC_RUNTIME_DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'];
/** Older runtimes crash inside transcribe.cpp's backend start (its README: 14.40 or newer). */
export const VC_RUNTIME_MIN = [14, 40, 0, 0];

/** The files the installers carry in bundle/models: the voice detector and the default model. */
export function bundledModelFiles(modelId: string = config.defaultModel): { file: string; url: string }[] {
  const model = findModel(modelId);
  if (!model?.file || !model.url) throw new Error(`The default model "${modelId}" is not one file to download, so the installers cannot carry it`);
  return [{ file: SILERO_VAD.file, url: SILERO_VAD.url }, { file: model.file, url: model.url }];
}

/** A Windows DLL's file version from its version resource (VS_FIXEDFILEINFO), e.g. [14, 44, 35211, 0]; null without one. */
export function fileVersion(dll: Buffer): number[] | null {
  const info = dll.indexOf(Buffer.from('VS_VERSION_INFO', 'utf16le'));
  if (info < 0) return null;
  const at = dll.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]), info); // dwSignature 0xFEEF04BD
  if (at < 0 || at + 16 > dll.length) return null;
  const ms = dll.readUInt32LE(at + 8); // dwFileVersionMS, then dwFileVersionLS
  const ls = dll.readUInt32LE(at + 12);
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
}

/** -1, 0 or 1 as version a is older than, the same as, or newer than b. */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Of the folders given, the one with all three runtime DLLs at the newest version (a folder counts at its oldest DLL),
 * if that is 14.40 or newer; otherwise null, with what was found in `seen`.
 */
export function pickRuntime(dirs: string[], seen: string[] = []): { dir: string; version: number[] } | null {
  let best: { dir: string; version: number[] } | null = null;
  for (const dir of dirs) {
    const versions = VC_RUNTIME_DLLS.map((dll) => {
      try {
        return fileVersion(fs.readFileSync(path.join(dir, dll)));
      } catch {
        return null; // not there
      }
    });
    if (versions.some((v) => !v)) {
      seen.push(`${dir}: ${VC_RUNTIME_DLLS.filter((_, i) => !versions[i]).join(', ')} missing`);
      continue;
    }
    const version = (versions as number[][]).reduce((a, b) => (compareVersions(a, b) <= 0 ? a : b));
    seen.push(`${dir}: ${version.join('.')}`);
    if (compareVersions(version, VC_RUNTIME_MIN) >= 0 && (!best || compareVersions(version, best.version) > 0)) best = { dir, version };
  }
  return best;
}

const subdirs = (dir: string) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
};

/** Where this Windows computer has the x64 runtime: every Visual Studio's redistributable folder, then System32. */
function runtimeFolders(): string[] {
  if (process.env.VC_RUNTIME_DIR) return [process.env.VC_RUNTIME_DIR];
  const folders: string[] = [];
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (fs.existsSync(vswhere)) {
    const installs = execFileSync(vswhere, ['-all', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    for (const vs of installs) {
      for (const version of subdirs(path.join(vs, 'VC', 'Redist', 'MSVC'))) {
        folders.push(...subdirs(path.join(version, 'x64')).filter((d) => /^Microsoft\.VC\d+\.CRT$/i.test(path.basename(d))));
      }
    }
  }
  folders.push(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'));
  return folders;
}

/** bundle/models: exactly the files the installers carry, copied from models/ or downloaded. */
async function bundleModels() {
  const dir = path.join(BUNDLE, 'models');
  fs.mkdirSync(dir, { recursive: true });
  const files = bundledModelFiles();
  for (const name of fs.readdirSync(dir)) {
    if (!files.some((f) => f.file === name)) fs.rmSync(path.join(dir, name), { recursive: true, force: true }); // an old default, a broken download
  }
  for (const { file, url } of files) {
    const dest = path.join(dir, file);
    const local = path.join(MODELS_DIR, file);
    if (fs.existsSync(dest)) {
      // kept from the last build
    } else if (fs.existsSync(local)) {
      const tmp = `${dest}.${process.pid}.part`;
      fs.copyFileSync(local, tmp, fs.constants.COPYFILE_FICLONE); // a clone where the disk can, else a copy
      fs.renameSync(tmp, dest);
    } else {
      let last = -1;
      await download(url, dest, (fraction) => {
        const pct = Math.floor(fraction * 100);
        if (pct !== last && pct % 10 === 0) console.log(`  ↓ ${file} ${pct}%`);
        last = pct;
      });
    }
    console.log(`✔ bundle/models/${file} (${(fs.statSync(dest).size / 1024 ** 2).toFixed(1)} MB)`);
  }
}

/** bundle/vc-runtime: the newest runtime on this computer, 14.40 or newer, or the build stops. */
function bundleRuntime() {
  const dir = path.join(BUNDLE, 'vc-runtime');
  fs.rmSync(dir, { recursive: true, force: true });
  const seen: string[] = [];
  const runtime = pickRuntime(runtimeFolders(), seen);
  if (!runtime) {
    throw new Error(`No Visual C++ x64 runtime ${VC_RUNTIME_MIN.slice(0, 2).join('.')} or newer on this computer. Install Visual Studio's C++ tools, or the Visual C++ Redistributable (https://aka.ms/vs/17/release/vc_redist.x64.exe), or set VC_RUNTIME_DIR.\n  ${seen.join('\n  ')}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const dll of VC_RUNTIME_DLLS) fs.copyFileSync(path.join(runtime.dir, dll), path.join(dir, dll));
  console.log(`✔ bundle/vc-runtime: Visual C++ runtime ${runtime.version.join('.')} from ${runtime.dir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'scripts', 'bundle.ts')) {
  const win = process.argv.includes('--win');
  try {
    if (win && process.platform !== 'win32') {
      // npm installs the speech engines' native libraries for the computer it runs on, so they would be the wrong ones.
      throw new Error('Build the Windows installer on Windows (npm run dist:win there, or the Desktop app workflow on GitHub).');
    }
    await bundleModels();
    if (win) bundleRuntime();
  } catch (err: any) {
    console.error(`✖ ${err.message}`);
    process.exit(1);
  }
}
