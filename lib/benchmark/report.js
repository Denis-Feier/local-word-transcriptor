// The Markdown report of a benchmark run (benchmarks/runs/<name>/report.md), from its run.json.
import { describeMachine } from './machine.js';
import { CONDITIONS, LENGTHS } from './suite.js';

const pct = (x, d = 2) => (x == null || Number.isNaN(x) ? '—' : `${x.toFixed(d)} %`);
const num = (x, d = 0) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
const flag = (m) => (m.truncated ? ' ⏱' : '');

export function renderReport(run) {
  const models = run.models ?? [];
  const ok = models.filter((m) => !m.error && m.stages?.accuracy);
  const failed = models.filter((m) => m.error);
  const lines = [];
  lines.push(`# Benchmark: ${run.name}`, '');
  lines.push(`Measured on ${run.startedAt.slice(0, 10)} with Live Transcriber ${run.machine.app.version} (${run.machine.app.commit ?? '?'}${run.machine.app.dirty ? ', uncommitted changes' : ''}).`);
  lines.push('', `**Computer:** ${describeMachine(run.machine)}; Node ${run.machine.node}.`);
  if (run.machine.compute?.length) lines.push(`**Compute devices seen by transcribe.cpp:** ${run.machine.compute.map((d) => `${d.name}${d.description ? ` (${d.description.trim()})` : ''}${d.memoryGb ? `, ${d.memoryGb} GB` : ''}`).join('; ')}.`);
  lines.push('', `**Run:** ${models.length} models, ${run.parallel} at a time, budget ${run.minutes} min, took ${num((run.seconds ?? 0) / 60)} min. ${run.dataset.clips} FLEURS Romanian clips available; stages sized per model to fit the budget (⏱ = a stage stopped at the deadline, so that model's numbers cover fewer clips).`);
  if (run.parallel > 1) lines.push('', '> Models ran side by side and shared the processor, so the speeds are lower than one model alone would get; the error rates are not affected.');

  // 1. Ranking: accuracy and speed.
  lines.push('', '## Accuracy and speed (FLEURS Romanian, read speech)', '');
  lines.push('| # | Model | Runs on | WER (with diacritics) | WER (diacritics ignored) | WER (no digits) | Clips | Speed | Per sentence | Load |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  [...ok].sort((a, b) => a.stages.accuracy.werStrict - b.stages.accuracy.werStrict).forEach((m, i) => {
    const a = m.stages.accuracy;
    lines.push(`| ${i + 1} | ${m.label}${flag(m)} | ${m.load.device ?? '—'}${m.load.fallback ? ' (GPU failed)' : ''} | ${pct(a.werStrict)} | ${pct(a.werPlain)} | ${pct(a.werNoDigits)} | ${a.done}${a.truncated ? `/${a.clips}` : ''} | ${num(a.speed)}× real-time | ${num(a.msPerClip)} ms (max ${num(a.msMax)}) | ${num(m.load.seconds, 1)} s, +${m.load.rssMb} MB |`);
  });
  if (ok.length) {
    lines.push('', 'Speed by sentence length (ms per sentence; × = times faster than real time):', '');
    lines.push(`| Model | ${ok[0].stages.accuracy.byLength.map((b) => `${b.seconds} s`).join(' | ')} | ${LENGTHS.map((l) => `~${l} s joined`).join(' | ')} |`);
    lines.push(`|---|${ok[0].stages.accuracy.byLength.map(() => '---').join('|')}|${LENGTHS.map(() => '---').join('|')}|`);
    for (const m of ok) {
      const long = LENGTHS.map((l) => m.stages.length?.lengths.find((x) => x.target === l)).map((x) => (x ? `${x.msPerSentence} ms (${num(x.speed)}×), WER ${pct(x.werPlain, 1)}${x.empty ? `, ${x.empty} empty` : ''}` : '—'));
      lines.push(`| ${m.label} | ${m.stages.accuracy.byLength.map((b) => (b.clips ? `${b.msPerClip} ms (${b.speed}×), n=${b.clips}` : '—')).join(' | ')} | ${long.join(' | ')} |`);
    }
  }

  // 2. Live text.
  const live = ok.filter((m) => m.stages.live?.sentences?.length);
  if (live.length) {
    lines.push('', '## Live text: how much it rewrites itself (#27)', '');
    lines.push('Each sentence replayed on the app\'s live-guess schedule (first guess at 0.6 s, then every 0.5 s or twice the model\'s own time, while it is free). *Erasure*: words shown and then taken back, per word of the final line (0 = never). *Coverage*: words of the final line already on screen when it arrived. *Raw*: the model\'s guesses as written; *steady*: with Steady live text (the default).', '');
    lines.push('| Model | Sentences | Guesses / sentence | Erasure raw | Erasure steady | Rewrites raw | Rewrites steady | Coverage raw | Coverage steady | First words raw | First words steady | Final after pause |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const m of [...live].sort((a, b) => a.stages.live.steady.normalizedErasure - b.stages.live.steady.normalizedErasure)) {
      const l = m.stages.live;
      lines.push(`| ${m.label}${l.truncated ? ' ⏱' : ''} | ${l.done} | ${num(l.guessesPerSentence, 1)} | ${num(l.raw.normalizedErasure, 2)} | ${num(l.steady.normalizedErasure, 2)} | ${pct(100 * l.raw.rewriteShare, 0)} | ${pct(100 * l.steady.rewriteShare, 0)} | ${pct(100 * l.raw.coverage, 0)} | ${pct(100 * l.steady.coverage, 0)} | ${num(l.firstLiveSec.raw, 1)} s | ${num(l.firstLiveSec.steady, 1)} s | ${num(l.finalMs)} ms |`);
    }
  }

  // 3. Robustness.
  const robust = ok.filter((m) => m.stages.robustness?.conditions);
  if (robust.length) {
    lines.push('', '## Noise, a quiet speaker, a mic across the room', '');
    lines.push('Word error rate (diacritics ignored) on the same clips, clean and with each condition added; in brackets the change against clean.', '');
    lines.push(`| Model | Clips | clean | ${CONDITIONS.map((c) => c.label).join(' | ')} |`);
    lines.push(`|---|---|---|${CONDITIONS.map(() => '---').join('|')}|`);
    for (const m of robust) {
      const r = m.stages.robustness;
      const cell = (id) => {
        const c = r.conditions[id];
        return c ? `${pct(c.werPlain, 1)} (${c.delta >= 0 ? '+' : ''}${num(c.delta, 1)})${c.empty ? `, ${c.empty} empty` : ''}` : '—';
      };
      lines.push(`| ${m.label}${r.truncated ? ' ⏱' : ''} | ${r.clips} | ${pct(r.conditions.clean?.werPlain, 1)} | ${CONDITIONS.map((c) => cell(c.id)).join(' | ')} |`);
    }
  }

  // 4. Silence.
  const quiet = ok.filter((m) => m.stages.silence?.inputs?.length);
  if (quiet.length) {
    lines.push('', '## Silence and noise alone', '');
    lines.push('Nothing is said; every word written is invented (a hallucination). The app drops some known ones; these are what is left.', '');
    lines.push(`| Model | ${quiet[0].stages.silence.inputs.map((i) => i.label).join(' | ')} |`);
    lines.push(`|---|${quiet[0].stages.silence.inputs.map(() => '---').join('|')}|`);
    for (const m of quiet) {
      lines.push(`| ${m.label} | ${m.stages.silence.inputs.map((i) => (i.words ? `${i.words} words, ${i.ms} ms: “${i.text}”` : `nothing, ${i.ms} ms`)).join(' | ')} |`);
    }
  }

  if (failed.length) {
    lines.push('', '## Models that could not run', '');
    for (const m of failed) lines.push(`- ${m.label}: ${m.error}`);
  }

  lines.push('', '## How it was measured', '');
  lines.push('- Audio: the FLEURS Romanian test set (Google, CC-BY-4.0), a fixed selection spread evenly over the 883 clips; the same selection on every computer. Noise, the quiet speaker, the room and the silences are synthetic and seeded.');
  lines.push('- Word error rate: corpus level (all errors / all reference words), lowercased, punctuation removed. "With diacritics" counts "sa" for "să" as an error. "No digits" leaves out the sentences whose reference has digits (a model that writes "o sută" for "100" is not penalised).');
  lines.push('- Speed: the model\'s own time per sentence, on the device shown, after a warm-up; load is the time to ready and the memory this process grew by (a Python model\'s own memory is not counted).');
  lines.push('- Everything goes through the app\'s own transcriber, so a number here is what the app gets.');
  lines.push(`- Raw data: \`run.json\` next to this report, with every clip's text per model.`);
  return `${lines.join('\n')}\n`;
}
