// @ts-check
// What computer a benchmark ran on, for the exported results: OS, CPU, memory, GPU, Node and app versions.
// Nothing personal: no user name, no host name, no paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../config.js';

/** @typedef {{ name: string, cores?: number, memory?: string, memoryGb?: number | null, driver?: string }} Gpu */
/** @typedef {{ name: string, description?: string, kind?: string, memoryGb?: number | null, error?: string }} ComputeDevice  as transcribe.cpp (ggml) sees it */
/** @typedef {{ source: string, charge: number | null }} Power */
/** @typedef {{ python: string, nemo_toolkit?: string, torch?: string }} PythonEnv */
/**
 * Everything about a computer and a copy of the app that a result carries (machineInfo()). Nothing personal.
 * @typedef {{
 *   os: { platform: string, product: string | null, build: string | null, type: string, release: string, version: string, arch: string },
 *   cpu: { model: string, cores: number, speedMhz: number | null },
 *   ramGb: number | null,
 *   gpus: Gpu[],
 *   power: Power | null,
 *   compute: ComputeDevice[],
 *   node: string,
 *   app: { version: string, commit: string | null, branch: string | null, dirty: boolean },
 *   runtimes: { 'transcribe-cpp': string | null, 'sherpa-onnx-node': string | null, electron: string | null, ws: string | null, 'whisper.cpp': string | null, python: PythonEnv | null },
 * }} MachineInfo
 */

/**
 * @template T
 * @param {string} cmd
 * @param {string[]} args
 * @param {(out: string) => T} parse
 * @returns {T | null}
 */
function tryRun(cmd, args, parse) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return parse(out);
  } catch {
    return null;
  }
}

/**
 * @param {number} x
 * @param {number} [digits]
 */
const round = (x, digits = 1) => Math.round(x * 10 ** digits) / 10 ** digits;
/** @param {number | undefined} bytes */
const gb = (bytes) => (bytes ? round(bytes / 1024 ** 3) : null);

/**
 * Graphics processors the OS reports. Empty when nothing could be read.
 * @returns {Gpu[]}
 */
export function detectGpus() {
  if (process.platform === 'darwin') {
    return tryRun('system_profiler', ['SPDisplaysDataType', '-json'], (out) => (JSON.parse(out).SPDisplaysDataType ?? []).map((/** @type {any} */ g) => ({
      name: g.sppci_model ?? g._name,
      cores: g.sppci_cores ? Number(g.sppci_cores) : undefined,
      memory: g.spdisplays_vram ?? g.spdisplays_vram_shared ?? undefined,
    }))) ?? [];
  }
  if (process.platform === 'win32') {
    const list = tryRun('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress'], (out) => {
      const json = JSON.parse(out.trim());
      return (Array.isArray(json) ? json : [json]).map((/** @type {any} */ g) => ({ name: g.Name, memoryGb: gb(g.AdapterRAM), driver: g.DriverVersion }));
    });
    return list ?? [];
  }
  const nvidia = tryRun('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], (out) => out.trim().split('\n').filter(Boolean).map((line) => {
    const [name, memory, driver] = line.split(',').map((s) => s.trim());
    return { name, memoryGb: round(parseFloat(memory) / 1024), driver };
  }));
  if (nvidia?.length) return nvidia;
  const pci = tryRun('lspci', [], (out) => out.split('\n').filter((l) => /VGA|3D|Display/i.test(l)).map((l) => ({ name: l.replace(/^[^:]*:[^:]*: /, '').trim() })));
  return pci ?? [];
}

/**
 * The compute devices transcribe.cpp (ggml) sees: the GPU it will use, or only the CPU.
 * @returns {Promise<ComputeDevice[]>}
 */
export async function computeDevices() {
  try {
    const { getAvailableBackendsAsync } = await import('transcribe-cpp');
    return (await getAvailableBackendsAsync()).map((d) => ({ name: d.name, description: d.description, kind: d.kind, memoryGb: gb(d.memoryTotal) }));
  } catch (/** @type {any} */ err) {
    return [{ name: 'unknown', error: err.message }];
  }
}

/** @param {string[]} args */
function git(args) {
  return tryRun('git', ['-C', ROOT, ...args], (out) => out.trim());
}

/** The OS as people name it ("macOS 26.7.1", "Windows 11 …", "Ubuntu 24.04") and, on a Mac, its build; nulls when unreadable. */
function osProduct() {
  if (process.platform === 'darwin') {
    const version = tryRun('sw_vers', ['-productVersion'], (out) => out.trim());
    return { product: version ? `macOS ${version}` : null, build: tryRun('sw_vers', ['-buildVersion'], (out) => out.trim()) };
  }
  if (process.platform === 'win32') return { product: os.version() || null, build: null };
  try {
    return { product: fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] ?? null, build: null };
  } catch {
    return { product: null, build: null };
  }
}

/**
 * Where the power comes from, on a Mac: 'battery' or 'AC' and the charge, 0–100; null elsewhere or when unreadable. A
 * laptop on battery runs slower.
 * @returns {Power | null}
 */
function powerSource() {
  if (process.platform !== 'darwin') return null;
  return tryRun('pmset', ['-g', 'batt'], (out) => {
    const source = /'Battery Power'/.test(out) ? 'battery' : /'AC Power'/.test(out) ? 'AC' : null;
    const charge = out.match(/(\d+)%/)?.[1];
    return source ? { source, charge: charge ? Number(charge) : null } : null;
  });
}

/** whisper.cpp's version, from where its package manager keeps whisper-server (Homebrew: Cellar/whisper.cpp/1.9.5/…); "installed" when only that is known. */
function whisperCpp() {
  const bin = process.env.WHISPER_SERVER_BIN ?? 'whisper-server';
  const found = tryRun(process.platform === 'win32' ? 'where' : 'which', [bin], (out) => out.trim().split('\n')[0]);
  if (!found) return null;
  let real = found;
  try {
    real = fs.realpathSync(found);
  } catch {
    // not a link: the path itself may still name the version
  }
  return real.match(/whisper[.-]cpp[\\/]v?(\d[\d.]*\d)/)?.[1] ?? 'installed';
}

/**
 * The Python environment of the NeMo models: its interpreter, and the nemo_toolkit and torch in it (from their dist-info
 * folders, no import).
 * @returns {PythonEnv | null}
 */
function pythonEnv() {
  const venv = path.join(ROOT, 'python', '.venv');
  if (!fs.existsSync(venv)) return null;
  const interpreter = [path.join(venv, 'bin', 'python'), path.join(venv, 'Scripts', 'python.exe')].filter((p) => fs.existsSync(p))
    .map((p) => tryRun(p, ['--version'], (out) => out.trim()))[0] ?? 'present';
  const sites = [path.join(venv, 'Lib', 'site-packages')];
  const lib = path.join(venv, 'lib');
  if (fs.existsSync(lib)) for (const d of fs.readdirSync(lib)) sites.push(path.join(lib, d, 'site-packages'));
  /** @type {Record<string, string>} */
  const packages = {};
  for (const site of sites.filter((s) => fs.existsSync(s))) {
    for (const entry of fs.readdirSync(site)) {
      const m = entry.match(/^(nemo_toolkit|torch)-([^-]+)\.dist-info$/);
      if (m) packages[m[1]] = m[2];
    }
  }
  return { python: interpreter, ...packages };
}

/**
 * Everything about this computer and this copy of the app that a result needs to carry.
 * @returns {Promise<MachineInfo>}
 */
export async function machineInfo() {
  const cpus = os.cpus();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  /** @param {string} name */
  const dep = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  };
  const { product, build } = osProduct();
  return {
    os: { platform: process.platform, product, build, type: os.type(), release: os.release(), version: os.version(), arch: os.arch() },
    cpu: { model: cpus[0]?.model ?? 'unknown', cores: cpus.length, speedMhz: cpus[0]?.speed ?? null },
    ramGb: gb(os.totalmem()),
    gpus: detectGpus(),
    power: powerSource(),
    compute: await computeDevices(),
    node: process.version,
    app: { version: pkg.version, commit: git(['rev-parse', '--short', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])) },
    runtimes: { 'transcribe-cpp': dep('transcribe-cpp'), 'sherpa-onnx-node': dep('sherpa-onnx-node'), electron: dep('electron'), ws: dep('ws'), 'whisper.cpp': whisperCpp(), python: pythonEnv() },
  };
}

/**
 * One line for the report: "macOS 26.7.1 (build 25G241, Darwin 25.6.0, arm64), Apple M5 × 10, 24 GB RAM, GPU Apple M5 (10 cores)".
 * @param {MachineInfo} m
 */
export function describeMachine(m) {
  const osName = /** @type {Record<string, string>} */ ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[m.os.platform] ?? m.os.platform;
  const system = m.os.product ?? `${osName} ${m.os.release}`;
  const inside = [m.os.build && `build ${m.os.build}`, m.os.product && `${m.os.type} ${m.os.release}`, m.os.arch].filter(Boolean).join(', ');
  const gpu = m.gpus?.length ? m.gpus.map((g) => `${g.name}${g.cores ? ` (${g.cores} cores)` : g.memoryGb ? ` (${g.memoryGb} GB)` : ''}`).join(', ') : 'none detected';
  const power = m.power ? `, on ${m.power.source}${m.power.charge !== null && m.power.charge !== undefined ? ` (${m.power.charge} %)` : ''}` : '';
  return `${system} (${inside}), ${m.cpu.model.trim()} × ${m.cpu.cores}, ${m.ramGb} GB RAM, GPU ${gpu}${power}`;
}

/**
 * One line for the report: the app and every runtime it uses, with versions, from machineInfo()'s runtimes.
 * @param {MachineInfo} m
 */
export function describeSoftware(m) {
  const rt = /** @type {Partial<MachineInfo['runtimes']>} */ (m.runtimes ?? {}); // results written before the runtimes were recorded have none
  const py = rt.python;
  return [
    `Live Transcriber ${m.app.version}`, `Node ${m.node}`, rt.electron && `Electron ${rt.electron}`,
    rt['transcribe-cpp'] && `transcribe-cpp ${rt['transcribe-cpp']}`, rt['sherpa-onnx-node'] && `sherpa-onnx-node ${rt['sherpa-onnx-node']}`, rt.ws && `ws ${rt.ws}`,
    rt['whisper.cpp'] && `whisper.cpp ${rt['whisper.cpp']}`,
    py && `${py.python ?? 'Python'}${py.nemo_toolkit ? ` with nemo_toolkit ${py.nemo_toolkit}` : ''}${py.torch ? `${py.nemo_toolkit ? ' and' : ' with'} torch ${py.torch}` : ''}`,
  ].filter(Boolean).join(', ');
}
