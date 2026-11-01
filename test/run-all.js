// Runs the test plan (TESTING.md) and writes a report to test-results/<date>_<commit>/.
//
//   npm test                       standard tier (~5 min): static, unit, protocol, smoke, scenarios, ui
//   npm run test:quick             quick tier (~1 min): static, unit, protocol
//   npm run test:full              full tier (~15 min): standard + every engine + 10-minute conversation
//   npm run test:stress            stress tier (~4.5 h, TESTING.md §14): long meetings and failures; --short ~25 min,
//                                  --hours 8, --only STRESS-<GROUP> (one group, e.g. MEET)
//   node test/run-all.js --only ui            one suite: static, unit, protocol, smoke, scenarios, ui, engines, long
//   node test/run-all.js full --recordings transcripts/a.wav,transcripts/b.wav   also real voices (stay local)
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './helpers.js';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const tier = ['quick', 'standard', 'full', 'stress'].find((x) => args.includes(x)) ?? 'standard';
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const only = option('--only');
const recordings = option('--recordings');
const git = (cmd) => {
  try {
    return execSync(`git ${cmd}`, { cwd: ROOT }).toString().trim();
  } catch {
    return '?';
  }
};
const sha = git('rev-parse --short HEAD');
const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
const OUT = path.join(ROOT, 'test-results', `${stamp}_${sha}`);
fs.mkdirSync(OUT, { recursive: true });
const results = []; // { suite, cases: [{ id, title, status, detail }] , seconds, code }

// One engine per runtime, for the full tier.
const ENGINES = ['canary-1b-v2', 'whisper-large-v3-turbo', 'parakeet-tdt-0.6b-v3', 'jackrabbit-110m-ro'];

function run(name, cmd, cmdArgs, { minutes, env = {}, tag = false } = {}) {
  return new Promise((resolve) => {
    const resultFile = path.join(OUT, `${name}.json`);
    const log = fs.createWriteStream(path.join(OUT, `${name}.log`));
    // ENV_FILE: the suites never read the user's .env.local, which holds their real API keys (TESTING.md §2).
    const childEnv = { ...process.env, TEST_RESULT: resultFile, ENV_FILE: os.devNull, ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE; // set inside VS Code's terminal; it would turn Electron into plain Node
    delete childEnv.ELEVENLABS_API_KEY;
    const t0 = Date.now();
    const child = spawn(cmd, cmdArgs, { cwd: ROOT, env: childEnv });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    let pending = ''; // output arrives in chunks that can split a line
    child.stdout.on('data', (d) => {
      const lines = (pending + d).split('\n');
      pending = lines.pop();
      for (const l of lines) if (/^[✔✖◌–]/.test(l)) process.stdout.write(`  ${tag ? `[${name}] ` : ''}${l}\n`); // tag: lanes run in parallel
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), minutes * 60000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const seconds = Math.round((Date.now() - t0) / 1000);
      let cases = [];
      try {
        cases = JSON.parse(fs.readFileSync(resultFile, 'utf8')).cases;
      } catch {
        // smoke.js reports by exit code only; a crashed suite reports nothing
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
  const cases = [];
  const check = (id, title, ok, detail = '') => {
    cases.push({ id, title, status: ok ? 'pass' : 'fail', detail });
    console.log(`  ${ok ? '✔' : '✖'} ${id} ${title}${detail ? ` — ${detail}` : ''}`);
  };
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(c|m)?js$/.test(e.name)) files.push(rel);
    }
  };
  for (const dir of ['lib', 'public', 'scripts', 'desktop', 'test']) walk(dir);
  files.push('server.js');
  const broken = files.filter((f) => {
    try {
      execSync(`"${process.execPath}" --check "${path.join(ROOT, f)}"`, { stdio: 'pipe' });
      return false;
    } catch {
      return true;
    }
  });
  check('STATIC-01', 'every JavaScript file parses', broken.length === 0, broken.join(', ') || `${files.length} files`);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const packaged = pkg.build.files;
  check('STATIC-02', 'the installers include server.js, lib/ and public/', ['server.js', 'lib/**', 'public/**', 'desktop/main.mjs'].every((p) => packaged.includes(p)), packaged.join(' '));

  // A new version needs its manual rebuilt (npm run manual, or the user-manual skill) before it is tagged.
  let manual = {};
  try {
    manual = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'manual', 'manual.json'), 'utf8'));
  } catch {
    // never built
  }
  const noPdf = ['EN', 'RO'].map((l) => `docs/manual/Live-Transcriber-Manual-${l}.pdf`).filter((f) => !fs.existsSync(path.join(ROOT, f)));
  check('STATIC-05', 'the user manual is built for this version and ships with the installers', manual.version === pkg.version && !noPdf.length && packaged.includes('docs/manual/*.pdf'),
    `manual ${manual.version ?? 'not built'}, app ${pkg.version}${noPdf.length ? `; missing ${noPdf.join(', ')}` : ''}`);

  // The server serves only the page files it lists; a new one left out breaks the page without an error.
  const served = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const unserved = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f !== 'index.html' && !served.includes(`'/${f}': ['${f}'`));
  check('STATIC-04', 'the server serves every file in public/', unserved.length === 0, unserved.join(', ') || 'all listed in server.js');

  // The plan and the tests must agree: every test id in the code is described in TESTING.md, and every
  // automated id in TESTING.md exists in the code.
  const plan = fs.readFileSync(path.join(ROOT, 'TESTING.md'), 'utf8');
  const ID = /\b(?:STATIC|UNIT|PROT|SMOKE|SCN|KNOWN|UI|STRESS)-[A-Z0-9]+(?:-[0-9]+)?\b/g;
  const inCode = new Set(files.filter((f) => f.startsWith('test')).flatMap((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').match(ID) ?? []));
  for (const c of cases) inCode.add(c.id);
  const planRows = plan.split('\n').filter((l) => /^\| `?[A-Z]+-[A-Z0-9-]+`? \|/.test(l));
  const automated = new Set(planRows.filter((l) => /\| auto \|/.test(l)).map((l) => l.match(ID)?.[0]).filter(Boolean));
  const described = new Set(planRows.map((l) => l.match(ID)?.[0]).filter(Boolean));
  const undocumented = [...inCode].filter((id) => !described.has(id) && !id.endsWith('-RUN'));
  const missing = [...automated].filter((id) => !inCode.has(id) && !/^SMOKE-/.test(id));
  check('STATIC-03', 'TESTING.md lists every test in the code, and every automated test in it exists', !undocumented.length && !missing.length,
    [undocumented.length && `not in TESTING.md: ${undocumented.join(', ')}`, missing.length && `in TESTING.md but not in the code: ${missing.join(', ')}`].filter(Boolean).join('; '));
  results.push({ suite: 'static', cases, seconds: 0, code: cases.some((c) => c.status === 'fail') ? 1 : 0 });
}

// ---------- the stress tier (TESTING.md §14) ----------
const node = process.execPath;
const electron = require('electron'); // in Node this is the path to the Electron binary

/** Phase A: lanes in parallel (steady loads); phase B: alone (it measures limits). --only STRESS-<GROUP>: that group. */
async function stressTier() {
  const short = args.includes('--short');
  const hours = Number(option('--hours') ?? 4);
  const pass = [...(short ? ['--short'] : []), ...(option('--hours') ? ['--hours', String(hours)] : []), ...(recordings ? ['--recordings', recordings] : [])];
  const env = { STRESS_OUT: path.join(OUT, 'stress'), NODE_BIN: node };
  const server = (group, minutes) => () => run(`stress-${group.replace(/,/g, '-')}`, node, ['test/stress.js', '--group', group, ...pass], { minutes, env, tag: true });
  const page = (group, minutes) => () => run(`stress-${group}`, electron, ['test/ui/stress.mjs', '--group', group, ...pass], { minutes, env, tag: true });
  const groups = {
    soak: page('soak', 150),
    meet: server('meet', short ? 20 : (hours * 60) / 8 + 30),
    mic3: server('mic3', 40),
    page: page('page', 20),
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
const plan = [
  ['static', 'quick', () => staticChecks()],
  ['unit', 'quick', () => run('unit', node, ['test/unit.js'], { minutes: 3 })],
  ['protocol', 'quick', () => run('protocol', node, ['test/protocol.js'], { minutes: 8 })],
  ['smoke', 'standard', () => run('smoke', node, ['test/smoke.js'], { minutes: 15, env: { SMOKE_MODELS_DIR: process.env.SMOKE_MODELS_DIR ?? path.join(ROOT, 'models') } })],
  ['scenarios', 'standard', () => run('scenarios', node, ['test/scenarios.js'], { minutes: 15 })],
  ['ui', 'standard', () => run('ui', electron, ['test/ui/run.mjs'], { minutes: 10, env: { NODE_BIN: node, UI_OUT: path.join(OUT, 'screenshots') } })],
  ['engines', 'full', async () => {
    const { MODELS, isInstalled, isAvailable } = await import('../lib/models.js');
    for (const id of ENGINES) {
      const m = MODELS.find((x) => x.id === id);
      if (!m || !isAvailable(m) || !isInstalled(m)) {
        results.push({ suite: `scenarios-${id}`, cases: [{ id: 'SCN-ENGINE', title: `two-mic scenarios on ${id}`, status: 'skip', detail: 'not installed or not runnable here' }], seconds: 0, code: 0 });
        console.log(`  – scenarios on ${id} — skipped: not installed or not runnable here`);
        continue;
      }
      await run(`scenarios-${id}`, node, ['test/scenarios.js', '--model', id], { minutes: 30 });
    }
  }],
  ['long', 'full', () => run('long', node, ['test/scenarios.js', '--long', '--only', 'SCN-07'], { minutes: 20 })],
  ['recordings', 'full', () => (recordings ? run('recordings', node, ['test/scenarios.js', '--recordings', recordings], { minutes: 20 }) : null)],
  ['stress', 'stress', stressTier],
];
const rank = { quick: 0, standard: 1, full: 2, stress: 3 };
// The stress tier runs alone (with the static checks); --only STRESS-<GROUP> runs one of its groups.
const wanted = (name, level) => (only?.startsWith('STRESS-') ? name === 'stress' : only ? name === only : tier === 'stress' ? ['static', 'stress'].includes(name) : rank[level] <= rank[tier]);
const t0 = Date.now();
for (const [name, level, step] of plan) {
  if (!wanted(name, level)) continue;
  console.log(`\n▸ ${name}`);
  await step();
}

// ---------- report ----------
const all = results.flatMap((r) => r.cases.map((c) => ({ ...c, suite: r.suite })));
const count = (s) => all.filter((c) => c.status === s).length;
const dirty = git('status --porcelain') ? ' (uncommitted changes)' : '';
const lines = [
  `# Test run ${stamp}`,
  '',
  `- Commit: \`${sha}\` on \`${git('rev-parse --abbrev-ref HEAD')}\`${dirty}`,
  `- Tier: ${only ? `only ${only}` : tier}${args.includes('--short') ? ' (short)' : ''}${recordings ? ' + real recordings' : ''}`,
  `- Machine: ${os.type()} ${os.release()} ${os.arch()}, Node ${process.version}, ${os.cpus()[0]?.model ?? ''}`,
  `- Time: ${Math.round((Date.now() - t0) / 60000)} min`,
  `- Result: **${count('fail') ? 'FAIL' : 'PASS'}** — ${count('pass')} passed, ${count('fail')} failed, ${count('known')} known limits, ${count('skip')} skipped`,
  '',
  '| Suite | Id | Test | Result | Detail |',
  '|---|---|---|---|---|',
  ...all.map((c) => `| ${c.suite} | ${c.id} | ${c.title} | ${{ pass: '✔', fail: '✖ FAIL', known: '◌ known', skip: '– skip' }[c.status]} | ${String(c.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 200)} |`),
  '',
  `Logs and screenshots: \`${path.relative(ROOT, OUT)}/\``,
];
fs.writeFileSync(path.join(OUT, 'summary.md'), `${lines.join('\n')}\n`);
console.log(`\n${count('fail') ? '✖ FAIL' : '✔ PASS'}: ${count('pass')} passed, ${count('fail')} failed, ${count('known')} known limits, ${count('skip')} skipped`);
console.log(`report: ${path.relative(ROOT, path.join(OUT, 'summary.md'))}`);
process.exit(count('fail') ? 1 : 0);
