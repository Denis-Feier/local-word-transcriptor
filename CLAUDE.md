## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

## Testing

The test plan is TESTING.md, written for agents. Follow its rules (§2) whenever you test this app.
- Before merging a feature branch into main: run `npm test` (and `npm run test:full` for audio, voice-detection,
  crosstalk, session, engine or transcriber changes), and update TESTING.md in the same branch: new test ids in §7,
  coverage in §11, a line in §13. `npm run test:quick` fails (STATIC-03) when the plan and the tests disagree.
- After every merge into main: run `npm run test:full` on main and add the result to TESTING.md §12.
- Tests never use the user's `transcripts/`, `.settings.json` or a real microphone; `transcripts/*.wav` are private
  recordings and never leave this computer.
