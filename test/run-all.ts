// Runs the test plan (TESTING.md) and writes a report to test-results/<date>_<commit>/.
//
//   npm test                       standard tier (~5 min): static, unit, protocol, smoke, scenarios, ui
//   npm run test:quick             quick tier (~1 min): static, unit, protocol
//   npm run test:full              full tier (~15 min): standard + every engine + 10-minute conversation
//   npm run test:stress            stress tier (~4.5 h, TESTING.md §14): long meetings and failures; --short ~25 min,
//                                  --hours 8, --only STRESS-<GROUP> (one group, e.g. MEET)
//   node test/run-all.ts --only ui            one suite: static, unit, protocol, smoke, scenarios, ui, engines, long
//   node test/run-all.ts full --recordings transcripts/a.wav,transcripts/b.wav   also real voices (stay local)
import { spawn, execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.ts';
import { staleWebFiles } from '../scripts/build-web.ts';
import type { SuiteResult, TestCase } from '../types/test.ts';

/** One suite's outcome in run-all.ts. */
export interface RunResult {
  suite: string;
  cases: TestCase[];
  seconds: number;
  code: number | null;
}

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const tier = ['quick', 'standard', 'full', 'stress'].find((x) => args.includes(x)) ?? 'standard';
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const only = option('--only');
const recordings = option('--recordings');
const git = (cmd: string) => {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT }).toString().trim();
  } catch {
    return '?';
  }
};
// The run's signature: the exact moment it started and the commit identify it (the report and its folder carry both).
const startedAt = new Date();
const sha = git('rev-parse --short HEAD');
const RUN_ID = `${startedAt.toISOString()}_${sha}`;
const stamp = startedAt.toISOString().slice(0, 19).replace(/[T:]/g, '-');
const OUT = path.join(ROOT, 'test-results', `${stamp}_${sha}`);
fs.mkdirSync(OUT, { recursive: true });
const results: RunResult[] = []; // one per suite

// A Mac on battery sleeps after a minute without a person at it, and every process stops with it: on 2026-11-04 the
// 10-minute conversation lost 590 s that way (TESTING.md §12). caffeinate holds the display and the system awake until
// this process exits (-w); a lid closed still sleeps. Nothing on other systems.
const awake = process.platform === 'darwin' ? spawn('caffeinate', ['-dis', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', () => {}) : null;
awake?.unref();

// The computer and the software the run used, for the report (nothing personal: no user name, no host name).
process.env.ENV_FILE ??= os.devNull; // the runner itself never reads the user's .env.local either (TESTING.md §2 rule 9); lib/config.ts loads it on import
const { machineInfo, describeMachine, describeSoftware } = await import('../lib/benchmark/machine.ts');
const machine = await machineInfo();
const { MODELS, isInstalled } = await import('../lib/models.ts');
const installedModels = MODELS.filter((m) => !m.cloud && isInstalled(m)).map((m) => m.id); // the cloud model needs the user's key, which the tests never read
console.log(`run ${RUN_ID}\non ${describeMachine(machine)}\nwith ${describeSoftware(machine)}`);

// One engine per runtime, for the full tier.
const ENGINES = ['canary-1b-v2', 'whisper-large-v3-turbo', 'jackrabbit-110m-ro', 'parakeet-redux']; // the last on sherpa-onnx (#60), on the CPU

/** One suite as a child process; its result file joins the report. */
function run(name: string, cmd: string, cmdArgs: string[], { minutes, env = {}, tag = false }: { minutes?: number, env?: Record<string, string>, tag?: boolean } = {}): Promise<void> {
  return new Promise((resolve) => {
    const resultFile = path.join(OUT, `${name}.json`);
    const log = fs.createWriteStream(path.join(OUT, `${name}.log`));
    // ENV_FILE: the suites never read the user's .env.local, which holds their real API keys (TESTING.md §2).
    const childEnv: NodeJS.ProcessEnv = { ...process.env, TEST_RESULT: resultFile, ENV_FILE: os.devNull, ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE; // set inside VS Code's terminal; it would turn Electron into plain Node
    delete childEnv.ELEVENLABS_API_KEY;
    const t0 = Date.now();
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, env: childEnv });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    let pending = ''; // output arrives in chunks that can split a line
    child.stdout.on('data', (d) => {
      const lines = (pending + d).split('\n');
      pending = lines.pop() as string; // split() gives at least one piece
      for (const l of lines) if (/^[✔✖◌–]/.test(l)) process.stdout.write(`  ${tag ? `[${name}] ` : ''}${l}\n`); // tag: lanes run in parallel
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), (minutes as number) * 60000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - t0) / 1000);
      let cases: TestCase[] = [];
      try {
        cases = (JSON.parse(fs.readFileSync(resultFile, 'utf8')) as SuiteResult).cases;
      } catch {
        // smoke.ts reports by exit code only; a crashed suite reports nothing
      }
      if (!cases.length || (code !== 0 && !cases.some((c) => c.status === 'fail'))) {
        const ok = code === 0;
        cases.push({ id: `${name.toUpperCase()}-RUN`, title: `${name} ran to the end`, status: ok ? 'pass' : 'fail', detail: ok ? '' : `exit ${code ?? signal}${signal === 'SIGKILL' ? ` (timed out after ${minutes} min)` : ''}; see ${name}.log` });
        console.log(`  ${ok ? '✔' : '✖'} ${name} ${ok ? 'passed' : `failed (exit ${code ?? signal})`}`);
      }
      results.push({ suite: name, cases, seconds, code });
      resolve();
    });
  });
}

// ---------- static checks: no server, no model ----------
function staticChecks() {
  const cases: TestCase[] = [];
  const check = (id: string, title: string, ok: boolean, detail: string = '') => {
    cases.push({ id, title, status: ok ? 'pass' : 'fail', detail });
    console.log(`  ${ok ? '✔' : '✖'} ${id} ${title}${detail ? ` — ${detail}` : ''}`);
  };
  const files: string[] = []; // every source file: the JavaScript for STATIC-01, all of them for STATIC-03's id scan
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(c|m)?[jt]s$/.test(e.name)) files.push(rel);
    }
  };
  for (const dir of ['lib', 'public', 'web', 'scripts', 'desktop', 'test']) walk(dir);
  const scripts = files.filter((f) => /\.(c|m)?js$/.test(f)); // node --check reads JavaScript only; tsc (STATIC-06) parses the .ts files
  const broken = scripts.filter((f) => {
    try {
      execSync(`"${process.execPath}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' });
      return false;
    } catch {
      return true;
    }
  });
  check('STATIC-01', 'every JavaScript file parses', broken.length === 0, broken.join(', ') || `${scripts.length} files (${files.length - scripts.length} .ts files: STATIC-06)`);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const packaged = pkg.build.files;
  check('STATIC-02', 'the installers include server.ts, lib/, public/ and web/', ['server.ts', 'lib/**', 'public/**', 'web/**', 'desktop/main.ts'].every((p) => packaged.includes(p)), packaged.join(' '));

  // Plug and play: scripts/bundle.ts gathers the default model, the voice detector and (Windows) the Visual C++ runtime
  // before electron-builder runs, the installers carry them, and the desktop app reads the models from its resources.
  type Copy = { from: string; to: string };
  const carries = (list: Copy[] | undefined, from: string, to: string) => (list ?? []).some((e) => e.from === from && e.to === to);
  const desktopMain = fs.readFileSync(path.join(ROOT, 'desktop', 'main.ts'), 'utf8');
  const unbundled = [
    !/^node scripts\/bundle\.ts --mac && electron-builder --mac\b/.test(pkg.scripts['dist:mac'] ?? '') && 'dist:mac does not run scripts/bundle.ts --mac first',
    !/^node scripts\/bundle\.ts --win && electron-builder --win\b/.test(pkg.scripts['dist:win'] ?? '') && 'dist:win does not run scripts/bundle.ts --win first',
    !carries(pkg.build.extraResources, 'bundle/models', 'models') && 'build.extraResources lacks bundle/models → models',
    !carries(pkg.build.win?.extraFiles, 'bundle/vc-runtime', '.') && 'build.win.extraFiles lacks bundle/vc-runtime → .',
    !/BUNDLED_MODELS_DIR: app\.isPackaged \? path\.join\(process\.resourcesPath, 'models'\)/.test(desktopMain) && 'desktop/main.ts does not pass BUNDLED_MODELS_DIR',
  ].filter(Boolean);
  check('STATIC-08', 'the installers carry the default model, the voice detector and, on Windows, the Visual C++ runtime', !unbundled.length,
    unbundled.join('; ') || 'scripts/bundle.ts before electron-builder; bundle/models → resources/models; bundle/vc-runtime → beside the .exe');

  // A new version needs its manual rebuilt (npm run manual, or the user-manual skill) before it is tagged.
  let manual: { version?: string } = {};
  try {
    manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'manual', 'manual.json'), 'utf8'));
  } catch {
    // never built
  }
  const noPdf = ['EN', 'RO'].map((l) => `docs/manual/Live-Transcriber-Manual-${l}.pdf`).filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check('STATIC-05', 'the user manual is built for this version and ships with the installers', manual.version === pkg.version && !noPdf.length && packaged.includes('docs/manual/*.pdf'),
    `manual ${manual.version ?? 'not built'}, app ${pkg.version}${noPdf.length ? `; missing ${noPdf.join(', ')}` : ''}`);

  // The server serves only the page files it lists; a new one left out breaks the page without an error.
  const served = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8');
  const unserved = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f !== 'index.html' && !served.includes(`'/${f}': ['${f}'`));
  check('STATIC-04', 'the server serves every file in public/', unserved.length === 0, unserved.join(', ') || 'all listed in server.ts');

  // The types (docs/typescript-migration.md): every project passes tsc without emitting: the server side (tsconfig.json:
  // server.ts, lib/, scripts/, desktop/, types/), the page (tsconfig.web.json: web/) and the tests (tsconfig.test.json:
  // test/). Node runs .ts files itself and node --check cannot parse them, so this is also the syntax check for every .ts file.
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const typeErrors = ['tsconfig.json', 'tsconfig.web.json', 'tsconfig.test.json'].flatMap((project) => {
    try {
      execFileSync(process.execPath, [tsc, '--noEmit', '-p', path.join(ROOT, project)], { cwd: ROOT, stdio: 'pipe' });
      return [];
    } catch (err: any) {
      const lines = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').filter(Boolean);
      return [`${project}: ${lines[0] ?? err.message}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ''}`];
    }
  });
  check('STATIC-06', 'the types check: tsc passes on the server side, the page and the tests', typeErrors.length === 0, typeErrors.join('; ') || 'tsconfig.json, tsconfig.web.json, tsconfig.test.json');

  // The page is emitted from web/*.ts into public/*.js, which is committed (docs/typescript-migration.md, D2): a stale file
  // would ship old code while the source says otherwise. A fresh emit (into a temporary folder) is compared with public/.
  let stale: string[];
  try {
    stale = staleWebFiles();
  } catch (err: any) {
    stale = [err.message]; // tsc failed: STATIC-06 says where
  }
  check('STATIC-07', 'the committed page (public/*.js) is a fresh emit of web/*.ts', stale.length === 0, stale.length ? `${stale.join(', ')}; npm run build:web` : `${fs.readdirSync(path.join(ROOT, 'web')).length} files`);

  // The plan and the tests must agree: every test id in the code is described in TESTING.md, and every
  // automated id in TESTING.md exists in the code.
  const plan = fs.readFileSync(path.join(ROOT, 'TESTING.md'), 'utf8');
  const ID = /\b(?:STATIC|UNIT|PROT|SMOKE|SCN|KNOWN|UI|STRESS)-[A-Z0-9]+(?:-[0-9]+)?\b/g;
  const inCode = new Set(files.filter((f) => f.startsWith('test')).flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').match(ID) ?? []));
  for (const c of cases) inCode.add(c.id);
  const planRows = plan.split('\n').filter((l) => /^\| `?[A-Z]+-[A-Z0-9-]+`? \|/.test(l));
  const automated = new Set(planRows.filter((l) => /\| auto \|/.test(l)).map((l) => l.match(ID)?.[0]).filter(Boolean) as string[]);
  const described = new Set(planRows.map((l) => l.match(ID)?.[0]).filter(Boolean) as string[]);
  const undocumented = [...inCode].filter((id) => !described.has(id) && !id.endsWith('-RUN'));
  const missing = [...automated].filter((id) => !inCode.has(id) && !/^SMOKE-/.test(id));
  check('STATIC-03', 'TESTING.md lists every test in the code, and every automated test in it exists', !undocumented.length && !missing.length,
    [undocumented.length && `not in TESTING.md: ${undocumented.join(', ')}`, missing.length && `in TESTING.md but not in the code: ${missing.join(', ')}`].filter(Boolean).join('; '));
  results.push({ suite: 'static', cases, seconds: 0, code: cases.some((c) => c.status === 'fail') ? 1 : 0 });
}

// ---------- the stress tier (TESTING.md §14) ----------
const node = process.execPath;
const electron = require('electron') as unknown as string; // in Node this is the path to the Electron binary

/** Phase A: lanes in parallel (steady loads); phase B: alone (it measures limits). --only STRESS-<GROUP>: that group. */
async function stressTier() {
  const short = args.includes('--short');
  const hours = Number(option('--hours') ?? 4);
  const pass = [...(short ? ['--short'] : []), ...(option('--hours') ? ['--hours', String(hours)] : []), ...(recordings ? ['--recordings', recordings] : [])];
  const env = { STRESS_OUT: path.join(OUT, 'stress'), NODE_BIN: node };
  const server = (group: string, minutes: number) => () => run(`stress-${group.replace(/,/g, '-')}`, node, ['test/stress.ts', '--group', group, ...pass], { minutes, env, tag: true });
  const page = (group: string, minutes: number) => () => run(`stress-${group}`, electron, ['test/ui/stress.ts', '--group', group, ...pass], { minutes, env, tag: true });
  // The groups whose speed is judged first wait, up to 15 minutes, for the Mac to cool down (coolDown(), §14.5 #24).
  const COOL = 15;
  const groups: Record<string, () => Promise<void>> = {
    soak: page('soak', 150),
    meet: server('meet', (short ? 20 : (hours * 60) / 8 + 30) + COOL),
    mic3: server('mic3', 40 + COOL),
    page: page('page', 20 + COOL),
    'conn,conc,tune,disk': server('conn,conc,tune,disk', short ? 30 : 90),
    net: page('net', short ? 20 : 100),
    cap: server('cap', 240),
    load: server('load', 90),
    eng: server('eng', 120),
  };
  const area = only?.startsWith('STRESS-') ? only.split('-')[1].toLowerCase() : null;
  if (area) {
    const key = Object.keys(groups).find((g) => g.split(',').includes(area));
    if (!key) return console.log(`  no stress group for ${only}`);
    return key.includes(',') ? server(area, 60)() : groups[key]();
  }
  // Only steady loads share the computer: bursts (several clients, overload, crashes) would slow the model in the
  // middle of the long meeting and make its trend checks fail for the wrong reason (first run, TESTING.md §12).
  const lanes = short ? [['meet', 'page', 'net']] : [['soak'], ['meet', 'mic3', 'page', 'net']];
  console.log(`  phase A: ${lanes.map((l) => l.join(' → ')).join('  ∥  ')}`);
  await Promise.all(lanes.map(async (lane) => {
    for (const g of lane) await groups[g]();
  }));
  const alone = short ? ['conn,conc,tune,disk', 'load'] : ['conn,conc,tune,disk', 'cap', 'load', 'eng'];
  console.log(`  phase B (alone): ${alone.join(' → ')}`);
  for (const g of alone) await groups[g]();
}

// ---------- the tiers ----------
const plan: [name: string, level: string, step: () => unknown][] = [
  ['static', 'quick', () => staticChecks()],
  ['unit', 'quick', () => run('unit', node, ['test/unit.ts'], { minutes: 3 })],
  ['protocol', 'quick', () => run('protocol', node, ['test/protocol.ts'], { minutes: 8 })],
  ['smoke', 'standard', () => run('smoke', node, ['test/smoke.ts'], { minutes: 15, env: { SMOKE_MODELS_DIR: process.env.SMOKE_MODELS_DIR ?? path.join(ROOT, 'models') } })],
  ['scenarios', 'standard', () => run('scenarios', node, ['test/scenarios.ts'], { minutes: 15 })],
  ['ui', 'standard', () => run('ui', electron, ['test/ui/run.ts'], { minutes: 10, env: { NODE_BIN: node, UI_OUT: path.join(OUT, 'screenshots') } })],
  ['engines', 'full', async () => {
    const { MODELS, isInstalled, isAvailable } = await import('../lib/models.ts');
    for (const id of ENGINES) {
      const m = MODELS.find((x) => x.id === id);
      if (!m || !isAvailable(m) || !isInstalled(m)) {
        results.push({ suite: `scenarios-${id}`, cases: [{ id: 'SCN-ENGINE', title: `two-mic scenarios on ${id}`, status: 'skip', detail: 'not installed or not runnable here' }], seconds: 0, code: 0 });
        console.log(`  – scenarios on ${id} — skipped: not installed or not runnable here`);
        continue;
      }
      await run(`scenarios-${id}`, node, ['test/scenarios.ts', '--model', id], { minutes: 30 });
    }
  }],
  ['long', 'full', () => run('long', node, ['test/scenarios.ts', '--long', '--only', 'SCN-07'], { minutes: 20 })],
  ['recordings', 'full', () => (recordings ? run('recordings', node, ['test/scenarios.ts', '--recordings', recordings], { minutes: 20 }) : null)],
  ['stress', 'stress', stressTier],
];
const rank: Record<string, number> = { quick: 0, standard: 1, full: 2, stress: 3 };
// The stress tier runs alone (with the static checks); --only STRESS-<GROUP> runs one of its groups.
const wanted = (name: string, level: string) => (only?.startsWith('STRESS-') ? name === 'stress' : only ? name === only : tier === 'stress' ? ['static', 'stress'].includes(name) : rank[level] <= rank[tier]);
for (const [name, level, step] of plan) {
  if (!wanted(name, level)) continue;
  console.log(`\n▸ ${name}`);
  await step();
}

// ---------- report ----------
const all = results.flatMap((r) => r.cases.map((c) => ({ ...c, suite: r.suite })));
const count = (s: TestCase['status']) => all.filter((c) => c.status === s).length;
const dirty = git('status --porcelain') ? ' (uncommitted changes)' : '';
const finishedAt = new Date();
/** "2026-11-04 18:27:03.512 (UTC+02:00)": the moment as a clock on this computer showed it. */
const local = (d: Date) => {
  const pad = (n: number, w: number = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} (UTC${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)})`;
};
const elapsed = finishedAt.getTime() - startedAt.getTime();
const compute = machine.compute?.length ? machine.compute.map((d) => `${d.name}${d.description ? ` (${d.description.trim()})` : ''}${d.memoryGb ? `, ${d.memoryGb} GB` : ''}`).join('; ') : 'none';
const signature = `run \`${RUN_ID}\`, started ${local(startedAt)}`;
const branch = git('rev-parse --abbrev-ref HEAD');
const verdict = count('fail') ? 'FAIL' : 'PASS';
const tally = `${count('pass')} passed, ${count('fail')} failed, ${count('known')} known limits, ${count('skip')} skipped`;
const stressReports = fs.existsSync(path.join(OUT, 'stress')) ? fs.readdirSync(path.join(OUT, 'stress')).filter((f) => f.endsWith('.md')).sort().map((f) => `stress/${f}`) : [];
const lines = [
  `# Test run ${startedAt.toISOString()}`,
  '',
  `**Signature:** ${signature}; finished ${local(finishedAt)} after ${Math.floor(elapsed / 60000)} min ${Math.round((elapsed % 60000) / 1000)} s.`,
  '',
  `- Commit: \`${sha}\` on \`${branch}\`${dirty}`,
  `- Tier: ${only ? `only ${only}` : tier}${args.includes('--short') ? ' (short)' : ''}${recordings ? ' + real recordings' : ''}`,
  `- Result: **${verdict}** — ${tally}`,
  `- Computer: ${describeMachine(machine)}; compute devices seen by transcribe.cpp: ${compute}${awake ? '; kept awake by caffeinate' : ''}`,
  `- Software: ${describeSoftware(machine)}`,
  `- Models installed: ${installedModels.join(', ')} (${installedModels.length})`,
  '',
  '| Suite | Id | Test | Result | Detail |',
  '|---|---|---|---|---|',
  ...all.map((c) => `| ${c.suite} | ${c.id} | ${c.title} | ${{ pass: '✔', fail: '✖ FAIL', known: '◌ known', skip: '– skip' }[c.status]} | ${String(c.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} |`),
  '',
  `Logs and screenshots: \`${path.relative(ROOT, OUT)}/\`${stressReports.length ? `; reports: ${stressReports.map((r) => `\`${r}\``).join(', ')}` : ''}; this report as data: \`run.json\`.`,
  '',
  `Signed: ${signature}, on ${describeMachine(machine)}.`,
];
fs.writeFileSync(path.join(OUT, 'summary.md'), `${lines.join('\n')}\n`);
// The same as data, for tools and for comparing runs. The recordings option is recorded as yes/no only: never their paths.
fs.writeFileSync(path.join(OUT, 'run.json'), `${JSON.stringify({
  id: RUN_ID, startedAt: startedAt.toISOString(), startedAtLocal: local(startedAt), finishedAt: finishedAt.toISOString(), durationSec: Math.round(elapsed / 1000),
  commit: sha, branch, dirty: Boolean(dirty), tier, only, short: args.includes('--short'), recordings: Boolean(recordings),
  result: verdict, counts: { pass: count('pass'), fail: count('fail'), known: count('known'), skip: count('skip') },
  machine, modelsInstalled: installedModels, suites: results.map((r) => ({ suite: r.suite, seconds: r.seconds, code: r.code })), cases: all,
}, null, 1)}\n`);
console.log(`\n${count('fail') ? '✖ FAIL' : '✔ PASS'}: ${tally}`);
console.log(`report: ${path.relative(ROOT, path.join(OUT, 'summary.md'))} (signed: ${signature})`);
process.exit(count('fail') ? 1 : 0);
