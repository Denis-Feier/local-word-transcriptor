// What computer a benchmark ran on, for the exported results: OS, CPU, memory, GPU, Node and app versions.
// Nothing personal: no user name, no host name, no paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../config.js';

function tryRun(cmd, args, parse) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return parse(out);
  } catch {
    return null;
  }
}

const round = (x, digits = 1) => Math.round(x * 10 ** digits) / 10 ** digits;
const gb = (bytes) => (bytes ? round(bytes / 1024 ** 3) : null);

/** Graphics processors the OS reports: [{ name, memoryGb? , cores? }]. Empty when nothing could be read. */
export function detectGpus() {
  if (process.platform === 'darwin') {
    return tryRun('system_profiler', ['SPDisplaysDataType', '-json'], (out) => (JSON.parse(out).SPDisplaysDataType ?? []).map((g) => ({
      name: g.sppci_model ?? g._name,
      cores: g.sppci_cores ? Number(g.sppci_cores) : undefined,
      memory: g.spdisplays_vram ?? g.spdisplays_vram_shared ?? undefined,
    }))) ?? [];
  }
  if (process.platform === 'win32') {
    const list = tryRun('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress'], (out) => {
      const json = JSON.parse(out.trim());
      return (Array.isArray(json) ? json : [json]).map((g) => ({ name: g.Name, memoryGb: gb(g.AdapterRAM), driver: g.DriverVersion }));
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

/** The compute devices transcribe.cpp (ggml) sees: the GPU it will use, or only the CPU. */
export async function computeDevices() {
  try {
    const { getAvailableBackendsAsync } = await import('transcribe-cpp');
    return (await getAvailableBackendsAsync()).map((d) => ({ name: d.name, description: d.description, kind: d.kind, memoryGb: gb(d.memoryTotal) }));
  } catch (err) {
    return [{ name: 'unknown', error: err.message }];
  }
}

function git(args) {
  return tryRun('git', ['-C', ROOT, ...args], (out) => out.trim());
}

/** Everything about this computer and this copy of the app that a result needs to carry. */
export async function machineInfo() {
  const cpus = os.cpus();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dep = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {
      return null;
    }
  };
  const whisper = tryRun(process.env.WHISPER_SERVER_BIN ?? 'whisper-server', ['--help'], () => 'installed');
  return {
    os: { platform: process.platform, type: os.type(), release: os.release(), version: os.version(), arch: os.arch() },
    cpu: { model: cpus[0]?.model ?? 'unknown', cores: cpus.length, speedMhz: cpus[0]?.speed ?? null },
    ramGb: gb(os.totalmem()),
    gpus: detectGpus(),
    compute: await computeDevices(),
    node: process.version,
    app: { version: pkg.version, commit: git(['rev-parse', '--short', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])) },
    runtimes: { 'transcribe-cpp': dep('transcribe-cpp'), 'sherpa-onnx-node': dep('sherpa-onnx-node'), 'whisper-server': whisper, python: fs.existsSync(path.join(ROOT, 'python', '.venv')) ? 'python/.venv present' : null },
  };
}

/** One line for the report: "macOS 26.1 (arm64), Apple M5, 32 GB, GPU Apple M5 (10 cores)". */
export function describeMachine(m) {
  const osName = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[m.os.platform] ?? m.os.platform;
  const gpu = m.gpus?.length ? m.gpus.map((g) => `${g.name}${g.cores ? ` (${g.cores} cores)` : g.memoryGb ? ` (${g.memoryGb} GB)` : ''}`).join(', ') : 'none detected';
  return `${osName} ${m.os.release} (${m.os.arch}), ${m.cpu.model.trim()} × ${m.cpu.cores}, ${m.ramGb} GB RAM, GPU ${gpu}`;
}
