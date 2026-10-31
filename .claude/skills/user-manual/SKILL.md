---
name: user-manual
description: "Creates and updates the Live Transcriber user manual (docs/manual/: a short PDF in English and Romanian with screenshots of the app). Use before every new version tag or release, when the version in package.json changes or STATIC-05 fails, when the user asks to create, update, check or extend the user manual, or types /user-manual."
---

# User manual

The manual is for the people who use the desktop app, not for developers: how to use it, what every control and
setting does, and what to change for different kinds of speakers and rooms. The app is plug and play, so the manual
stays short: **at most 6 A4 pages per language** (5 today). It ships inside the installers (Help → *User manual*),
on every GitHub release, and is linked from the README.

| File | What it is |
|---|---|
| `docs/manual/manual.en.html`, `manual.ro.html` | The text, one file per language, same sections and facts |
| `docs/manual/manual.css` | Print styles shared by both |
| `docs/manual/img/*.png` | Screenshots, generated; never edit by hand |
| `docs/manual/Live-Transcriber-Manual-EN.pdf`, `-RO.pdf` | The output, committed |
| `docs/manual/manual.json` | Version and date of the last build; `STATIC-05` compares it with `package.json` |
| `scripts/manual.mjs` | `npm run manual`: screenshots, then the PDFs. `--pdf-only` skips the screenshots |
| `.claude/skills/user-manual/pdfpages.swift` | Renders PDF pages to PNG for review (the Read tool needs poppler for PDFs) |

## When

Before every version tag. The release order is: bump `version` in `package.json` → run this skill → `npm test` →
merge into main → tag → push the tag. The workflow then builds the installers with this manual inside and attaches
both PDFs to the release. `npm test` fails (`STATIC-05`) while the manual is built for an older version, so a tag
cannot be prepared without it.

## Procedure

1. **Branch.** Work on a branch (e.g. `docs/manual-<version>`), unless you are already on the release or feature
   branch the user is preparing.
2. **Version.** Read `version` in `package.json`. If the user is preparing a release and it was not bumped yet, ask
   which number (or use the one they gave) and bump it first.
3. **What changed for users** since the text last changed:
   ```bash
   since=$(git log -1 --format=%H -- docs/manual/manual.en.html)
   git log --oneline $since..HEAD -- public desktop/main.mjs lib/tuning.js lib/config.js lib/models.js server.js package.json .github/release-notes.md README.md
   git diff $since..HEAD -- public desktop/main.mjs lib/tuning.js lib/config.js lib/models.js
   ```
   Look for anything a user can see or do: new, renamed or removed controls, labels, hints, menu items, keys,
   defaults, ranges, warnings, behaviours, supported systems, install or first-start steps, models in the desktop
   app. The README sections on the desktop app, two microphones, the speaker and the projector describe each
   feature in plain words and are a good source.
4. **Decide.**
   - Nothing user-visible changed: only rebuild the PDFs so they carry the new version: `npm run manual -- --pdf-only`.
   - Something changed: update the text in both languages (rules below), add or change screenshots if a screen or
     control is new or looks different, then `npm run manual`.
5. **Check every fact against the code**, not against memory:
   - labels and tooltips: `public/index.html`; setting names and hints: `FIELDS` in `public/settings.js`;
     projector keys and colour names: `public/stage.js`; menus: `buildMenu()` in `desktop/main.mjs`;
   - defaults: `lib/config.js`; slider ranges: `TUNING` in `lib/tuning.js` (every recommended value must lie inside
     its range); first start and systems: `.github/release-notes.md`.
   - Every `<b class="ui">` label must appear in the UI exactly as written. A quick check:
     ```bash
     grep -o '<b class="ui">[^<]*' docs/manual/manual.en.html | sed 's/.*">//' | sort -u | while read -r l; do grep -rqF "$l" public desktop/main.mjs || echo "not in the UI: $l"; done
     ```
6. **Build:** `npm run manual` (about 40 s; needs `models/canary-1b-v2-Q8_0.gguf`, `npm run setup` downloads it).
   It starts its own server on a free port, so a running copy of the app is not touched.
7. **Review the output visually** (checklist below). Fix and rebuild until it passes.
8. **Test:** `npm run test:quick` (`STATIC-05` must pass). If `scripts/manual.mjs`, `desktop/main.mjs` or anything
   else beyond the manual changed, follow CLAUDE.md and TESTING.md §3 for the branch (`npm test`, plan updates).
9. **Commit** both HTML files, `manual.css`, `img/`, both PDFs and `manual.json` together, e.g. "Update the user
   manual for 1.2.0". Merge, push and tag only when the user asks.
10. **A tag that is already released** with an old manual: the installers of that tag keep it, but the release page
    can get the new PDFs. This is outward-facing, so ask first:
    `gh release upload v<version> docs/manual/Live-Transcriber-Manual-EN.pdf docs/manual/Live-Transcriber-Manual-RO.pdf --clobber`.

## Writing rules

- **Reader:** someone who installed the desktop app and wants to run a meeting, a class or an interview. No
  developer words: no npm, environment variables, Docker, engines, WER, port numbers, or file paths other than
  *Documents → Live Transcriber* and `server.log`. Describe only the desktop app (the Whisper and Jackrabbit models
  exist only in the developer setup).
- **Short.** Explain each control once. A table row beats a paragraph. No marketing, no history, no "new in this
  version". If an addition would push a language past 6 pages, tighten other text first.
- **Exact labels.** UI labels in `<b class="ui">…</b>`, exactly as the app shows them (English in both languages,
  because the app is in English). Menu values and states in italics: *None*, *System default*, *not connected*,
  *speech*. OS menu paths in italics as the release notes write them.
- **Section 7, "Adjusting for different speakers and rooms", is the heart of the manual.** Each row is a symptom
  the user can see, then one concrete change with a value. When a feature or setting changes how to handle a kind
  of speaker, room or microphone, add or update its row in both languages.
- **The numbered list in section 2 matches the purple markers** in `img/main.png`: same count, same order as the
  `badges([...])` call in `scripts/manual.mjs`. Change both together.
- **Romanian** (`manual.ro.html`): the same sections, rows and facts as English, in natural Romanian, formal address
  (*apăsați*, *alegeți*), ș and ț with a comma below (never ş or ţ: `grep -c "[şţŞŢ]"` must print 0), decimal comma
  (0,7 s; 1,1 GB), quotes „…”. Every change goes into both files in the same commit.
- Keep the HTML structure: `<h2><span class="n">N</span>…</h2>` sections, `figure.w85/.w80/.w70` for widths,
  `.side` for a table beside a tall screenshot, `<span data-version>` and `<span data-date>` filled at build time.

## Screenshots

`scripts/manual.mjs` drives the real page in Electron against its own server, with the UI test's fake microphones
(`test/ui/preload.cjs`) playing the synthetic test voice (`test/fixtures/ro.wav`), the light theme and the device
names in `DEVICES`. The live line in `main.png` is a real live guess, so a wrong word in it is normal.

- **Privacy (TESTING.md §2):** never use the user's recordings, transcripts or settings, never open a real
  microphone, never capture the user's screen. Everything shown must come from the script.
- **Adding a screenshot:** add a step in `screenshots()` that brings the page into the state to show, then
  `shot(name)` for the window or `shot(name, selector)` for the area around some elements; reference
  `img/<name>.png` from both HTML files. Wait for page state with `until(...)`, never with fixed sleeps alone.
- Badges are placed by `[selector, number, dx, dy]`; after a UI change, check each still sits next to its control
  without hiding it.

## Review checklist

Render both PDFs to PNG and look at every page:

```bash
out=<scratchpad>/manual-pages; mkdir -p $out/en $out/ro
swift .claude/skills/user-manual/pdfpages.swift docs/manual/Live-Transcriber-Manual-EN.pdf $out/en
swift .claude/skills/user-manual/pdfpages.swift docs/manual/Live-Transcriber-Manual-RO.pdf $out/ro
```

- Version and date on page 1 match `package.json` and today; the footer reads "Live Transcriber <version> · n / N".
- At most 6 pages per language; no page ends with a large gap (a `.side` block or figure cannot split, so shrink a
  figure class rather than adding page breaks); no heading alone at the bottom of a page.
- Every screenshot is current, sharp, in the light theme, shows no temporary paths or personal data, and the
  markers in `main.png` match the numbered list.
- English and Romanian have the same sections in the same order; the Romanian diacritics render.
- Open the PDF links mentally: the release URL is `https://github.com/Denis-Feier/local-word-transcriptor/releases/latest`.

## Gotchas

- Run the script through `npm run manual`: it restarts itself in Electron without `ELECTRON_RUN_AS_NODE`, which VS
  Code's terminal sets.
- Electron drops buffered console output when it exits; the script logs with `fs.writeSync` for that reason. Keep
  it that way when adding log lines.
- The projector view normally asks for real full screen; the script stubs `requestFullscreen` so it cannot take
  over this computer's display.
