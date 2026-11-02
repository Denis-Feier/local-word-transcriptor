# Benchmark: 2026-11-02_20-09_mac-m5

Measured on 2026-11-02 with Live Transcriber 1.0.1 (a2f8257, uncommitted changes).

**Computer:** macOS 25.6.0 (arm64), Apple M5 × 10, 24 GB RAM, GPU Apple M5 (10 cores); Node v24.21.0.
**Compute devices seen by transcribe.cpp:** MTL0 (Apple M5), 17.8 GB; CPU (Apple M5), 24 GB.

**Run:** 12 models, 1 at a time, budget 120 min, took 44 min. 883 FLEURS Romanian clips available; stages sized per model to fit the budget (⏱ = a stage stopped at the deadline, so that model's numbers cover fewer clips).

## Accuracy and speed (FLEURS Romanian, read speech)

| # | Model | Runs on | WER (with diacritics) | WER (diacritics ignored) | WER (no digits) | Clips | Speed | Per sentence | Load |
|---|---|---|---|---|---|---|---|---|---|
| 1 | NVIDIA Canary 1B v2 | GPU (Metal) | 5.98 % | 5.57 % | 5.34 % | 100 | 55× real-time | 175 ms (max 277) | 0.3 s, +130 MB |
| 2 | Jackrabbit 110M Romanian (Surogate) | GPU (MPS) | 7.77 % | 7.58 % | 6.03 % | 100 | 25× real-time | 382 ms (max 822) | 11.6 s, +48 MB |
| 3 | Whisper large-v3 | GPU (Metal) | 9.05 % | 8.54 % | 7.95 % | 100 | 7× real-time | 1362 ms (max 1956) | 0.5 s, +53 MB |
| 4 | Parakeet Ultra 0.6B | GPU (Metal) | 10.00 % | 9.68 % | 8.80 % | 100 | 72× real-time | 132 ms (max 245) | 0.3 s, +251 MB |
| 5 | Orukeet 0.6B | GPU (Metal) | 10.19 % | 9.87 % | 8.43 % | 100 | 76× real-time | 126 ms (max 213) | 0.2 s, +257 MB |
| 6 | FastConformer Romanian 114M (UPB NLP) | GPU (MPS) | 11.28 % | 10.96 % | 7.84 % | 100 | 93× real-time | 103 ms (max 167) | 6.6 s, +52 MB |
| 7 | Whisper large-v3 Romanian (BuzzASR) | GPU (Metal) | 11.68 % | 11.41 % | 9.04 % | 78 | 4× real-time | 2277 ms (max 3701) | 1.0 s, +53 MB |
| 8 | Whisper large-v3 turbo | GPU (Metal) | 11.92 % | 9.18 % | 8.70 % | 100 | 17× real-time | 552 ms (max 756) | 0.5 s, +58 MB |
| 9 | NVIDIA Parakeet TDT 0.6B v3 | GPU (Metal) | 12.06 % | 11.69 % | 11.15 % | 100 | 86× real-time | 111 ms (max 186) | 0.2 s, +255 MB |
| 10 | Parakeet Romanian 110M (Politehnica) | GPU (Metal) | 12.56 % | 11.92 % | 8.70 % | 100 | 216× real-time | 44 ms (max 66) | 0.1 s, +151 MB |
| 11 | Apple on-device dictation (macOS) | the chip macOS picks | 16.72 % | 16.40 % | 15.90 % | 100 | 62× real-time | 154 ms (max 314) | 0.3 s, +56 MB |
| 12 | Whisper small Romanian (readerbench) | GPU (Metal) | 19.37 % | 19.05 % | 16.06 % | 100 | 26× real-time | 366 ms (max 727) | 0.3 s, +58 MB |

Speed by sentence length (ms per sentence; × = times faster than real time):

| Model | 0–6 s | 6–10 s | 10–15 s | 15+ s | ~20 s joined | ~40 s joined |
|---|---|---|---|---|---|---|
| NVIDIA Canary 1B v2 | 109 ms (47×), n=8 | 146 ms (54×), n=49 | 217 ms (56×), n=40 | 266 ms (60×), n=3 | 490 ms (54×), WER 1.8 % | 859 ms (52×), WER 4.9 % |
| Jackrabbit 110M Romanian (Surogate) | 223 ms (23×), n=8 | 310 ms (25×), n=49 | 479 ms (25×), n=40 | 676 ms (24×), n=3 | 942 ms (28×), WER 2.8 % | 1547 ms (29×), WER 6.0 % |
| Whisper large-v3 turbo | 484 ms (10×), n=8 | 528 ms (15×), n=49 | 590 ms (20×), n=40 | 632 ms (25×), n=3 | 1037 ms (25×), WER 7.9 % | 1723 ms (26×), WER 4.9 % |
| Whisper large-v3 | 1024 ms (5×), n=8 | 1262 ms (6×), n=49 | 1528 ms (8×), n=40 | 1664 ms (10×), n=3 | 2967 ms (9×), WER 6.1 % | 5091 ms (9×), WER 7.0 % |
| Whisper large-v3 Romanian (BuzzASR) | 1897 ms (3×), n=6 | 1981 ms (4×), n=41 | 2571 ms (5×), n=23 | 3234 ms (5×), n=8 | 2691 ms (8×), WER 14.8 % | 5561 ms (7×), WER 18.5 % |
| Whisper small Romanian (readerbench) | 234 ms (22×), n=8 | 335 ms (23×), n=49 | 419 ms (29×), n=40 | 524 ms (30×), n=3 | 923 ms (28×), WER 92.6 % | 2988 ms (15×), WER 58.1 % |
| Parakeet Ultra 0.6B | 77 ms (66×), n=8 | 112 ms (70×), n=49 | 162 ms (74×), n=40 | 219 ms (73×), n=3 | 339 ms (77×), WER 7.4 % | 645 ms (69×), WER 9.1 % |
| Orukeet 0.6B | 78 ms (65×), n=8 | 107 ms (73×), n=49 | 155 ms (78×), n=40 | 194 ms (82×), n=3 | 314 ms (84×), WER 8.7 % | 574 ms (78×), WER 8.8 % |
| Parakeet Romanian 110M (Politehnica) | 29 ms (174×), n=8 | 39 ms (203×), n=49 | 53 ms (228×), n=40 | 63 ms (253×), n=3 | 104 ms (252×), WER 13.1 % | 203 ms (219×), WER 7.6 % |
| FastConformer Romanian 114M (UPB NLP) | 67 ms (76×), n=8 | 88 ms (89×), n=49 | 125 ms (96×), n=40 | 162 ms (99×), n=3 | 278 ms (94×), WER 10.0 % | 470 ms (95×), WER 8.0 % |
| Apple on-device dictation (macOS) | 75 ms (68×), n=8 | 118 ms (67×), n=49 | 203 ms (59×), n=40 | 293 ms (54×), n=3 | 376 ms (70×), WER 14.0 % | 584 ms (76×), WER 13.7 % |
| NVIDIA Parakeet TDT 0.6B v3 | 70 ms (72×), n=8 | 93 ms (84×), n=49 | 136 ms (89×), n=40 | 167 ms (95×), n=3 | 355 ms (74×), WER 11.2 % | 581 ms (77×), WER 14.1 % |

## Live text: how much it rewrites itself (#27)

Each sentence replayed on the app's live-guess schedule (first guess at 0.6 s, then every 0.5 s or twice the model's own time, while it is free). *Erasure*: words shown and then taken back, per word of the final line (0 = never). *Coverage*: words of the final line already on screen when it arrived. *Raw*: the model's guesses as written; *steady*: with Steady live text (the default).

| Model | Sentences | Guesses / sentence | Erasure raw | Erasure steady | Rewrites raw | Rewrites steady | Coverage raw | Coverage steady | First words raw | First words steady | Final after pause |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Apple on-device dictation (macOS) | 40 | 19.2 | 0.35 | 0.04 | 19 % | 1 % | 100 % | 91 % | 1.1 s | 2.2 s | 190 ms |
| Whisper large-v3 Romanian (BuzzASR) | 31 | 1.9 | 0.31 | 0.05 | 30 % | 5 % | 81 % | 32 % | 6.4 s | 10.7 s | 2788 ms |
| Jackrabbit 110M Romanian (Surogate) | 40 | 17.2 | 1.17 | 0.09 | 37 % | 3 % | 99 % | 82 % | 1.1 s | 2.0 s | 421 ms |
| Whisper large-v3 | 40 | 3.4 | 0.35 | 0.13 | 37 % | 6 % | 91 % | 60 % | 3.6 s | 6.4 s | 1749 ms |
| Orukeet 0.6B | 40 | 19.2 | 1.86 | 0.28 | 55 % | 5 % | 99 % | 83 % | 1.1 s | 2.2 s | 156 ms |
| NVIDIA Canary 1B v2 | 40 | 19.2 | 2.07 | 0.28 | 50 % | 6 % | 99 % | 73 % | 0.6 s | 2.2 s | 228 ms |
| Whisper large-v3 turbo | 40 | 7.7 | 0.98 | 0.29 | 50 % | 7 % | 95 % | 79 % | 1.8 s | 3.3 s | 744 ms |
| FastConformer Romanian 114M (UPB NLP) | 40 | 19.2 | 2.20 | 0.30 | 55 % | 6 % | 99 % | 80 % | 1.1 s | 1.6 s | 118 ms |
| Whisper small Romanian (readerbench) | 40 | 11.2 | 3.83 | 0.31 | 70 % | 7 % | 96 % | 74 % | 1.2 s | 2.7 s | 464 ms |
| Parakeet Romanian 110M (Politehnica) | 40 | 19.2 | 2.07 | 0.31 | 48 % | 3 % | 99 % | 93 % | 1.1 s | 1.6 s | 47 ms |
| Parakeet Ultra 0.6B | 40 | 19.2 | 2.34 | 0.39 | 53 % | 6 % | 99 % | 79 % | 1.1 s | 2.2 s | 155 ms |
| NVIDIA Parakeet TDT 0.6B v3 | 40 | 19.2 | 3.76 | 0.41 | 63 % | 7 % | 98 % | 75 % | 0.6 s | 2.2 s | 141 ms |

## Noise, a quiet speaker, a mic across the room

Word error rate (diacritics ignored) on the same clips, clean and with each condition added; in brackets the change against clean.

| Model | Clips | clean | noise, SNR 20 dB | noise, SNR 10 dB | quiet speaker, −20 dB | mic across the room |
|---|---|---|---|---|---|---|
| NVIDIA Canary 1B v2 | 25 | 5.2 % | 8.8 % (+3.6) | 20.1 % (+14.9) | 5.2 % (+0.0) | 8.4 % (+3.2) |
| Jackrabbit 110M Romanian (Surogate) | 25 | 4.5 % | 8.6 % (+4.1) | 12.2 % (+7.7) | 6.5 % (+2.0) | 7.7 % (+3.2) |
| Whisper large-v3 turbo | 25 | 9.5 % | 11.3 % (+1.8) | 29.4 % (+19.9) | 9.7 % (+0.2) | 10.8 % (+1.3) |
| Whisper large-v3 | 25 | 8.2 % | 9.9 % (+1.6) | 24.2 % (+15.9) | 8.1 % (-0.2) | 9.7 % (+1.4) |
| Whisper large-v3 Romanian (BuzzASR) | 19 | 8.7 % | 9.2 % (+0.4) | 21.7 % (+12.9) | 8.3 % (-0.4) | 9.2 % (+0.4) |
| Whisper small Romanian (readerbench) | 25 | 19.7 % | 26.9 % (+7.2) | 49.6 % (+29.9) | 17.6 % (-2.2) | 20.3 % (+0.5) |
| Parakeet Ultra 0.6B | 25 | 8.2 % | 12.7 % (+4.5) | 27.2 % (+19.0) | 7.9 % (-0.4) | 8.8 % (+0.5) |
| Orukeet 0.6B | 25 | 9.3 % | 14.0 % (+4.7) | 31.0 % (+21.7) | 9.1 % (-0.2) | 10.4 % (+1.1) |
| Parakeet Romanian 110M (Politehnica) | 25 | 7.9 % | 9.7 % (+1.8) | 17.9 % (+10.0) | 8.2 % (+0.4) | 9.7 % (+1.8) |
| FastConformer Romanian 114M (UPB NLP) | 25 | 9.0 % | 9.5 % (+0.5) | 20.6 % (+11.6) | 9.1 % (+0.2) | 10.2 % (+1.3) |
| Apple on-device dictation (macOS) | 25 | 14.9 % | 24.9 % (+10.0) | 52.9 % (+38.0) | 20.6 % (+5.7) | 28.3 % (+13.4) |
| NVIDIA Parakeet TDT 0.6B v3 | 25 | 10.6 % | 13.6 % (+3.0) | 33.3 % (+22.8) | 9.9 % (-0.7) | 11.3 % (+0.7) |

## Silence and noise alone

Nothing is said; every word written is invented (a hallucination). The app drops some known ones; these are what is left.

| Model | 3 s of silence | 10 s of silence | 5 s of an empty room (−50 dBFS) | 5 s of a fan by the mic (−30 dBFS) |
|---|---|---|---|---|
| NVIDIA Canary 1B v2 | nothing, 59 ms | nothing, 90 ms | nothing, 72 ms | nothing, 74 ms |
| Jackrabbit 110M Romanian (Surogate) | nothing, 111 ms | nothing, 281 ms | nothing, 167 ms | nothing, 166 ms |
| Whisper large-v3 turbo | nothing, 524 ms | nothing, 572 ms | nothing, 570 ms | 1 words, 521 ms: “Mersi.” |
| Whisper large-v3 | nothing, 1669 ms | nothing, 1236 ms | nothing, 1131 ms | nothing, 1005 ms |
| Whisper large-v3 Romanian (BuzzASR) | nothing, 954 ms | nothing, 1151 ms | 4 words, 6072 ms: “Ceva de la tine” | nothing, 1789 ms |
| Whisper small Romanian (readerbench) | 16 words, 338 ms: “ca măsură de siguranță să nu rămână fără medicamente s-a decis sistarea operațiilor pentru câteva zile” | 16 words, 329 ms: “ca măsură de siguranță să nu rămână fără medicamente s-a decis sistarea operațiilor pentru câteva zile” | 3 words, 2383 ms: “subscribete se reprezintă” | 5 words, 1160 ms: “subscribute a fostul dvs bloggingh” |
| Parakeet Ultra 0.6B | nothing, 66 ms | nothing, 89 ms | nothing, 70 ms | nothing, 63 ms |
| Orukeet 0.6B | nothing, 75 ms | nothing, 101 ms | nothing, 62 ms | nothing, 67 ms |
| Parakeet Romanian 110M (Politehnica) | nothing, 27 ms | nothing, 51 ms | nothing, 32 ms | nothing, 32 ms |
| FastConformer Romanian 114M (UPB NLP) | nothing, 59 ms | nothing, 70 ms | nothing, 46 ms | nothing, 33 ms |
| Apple on-device dictation (macOS) | nothing, 45 ms | nothing, 113 ms | nothing, 62 ms | 1 words, 62 ms: “Da” |
| NVIDIA Parakeet TDT 0.6B v3 | nothing, 68 ms | nothing, 99 ms | nothing, 72 ms | nothing, 63 ms |

## How it was measured

- Audio: the FLEURS Romanian test set (Google, CC-BY-4.0), a fixed selection spread evenly over the 883 clips; the same selection on every computer. Noise, the quiet speaker, the room and the silences are synthetic and seeded.
- Word error rate: corpus level (all errors / all reference words), lowercased, punctuation removed. "With diacritics" counts "sa" for "să" as an error. "No digits" leaves out the sentences whose reference has digits (a model that writes "o sută" for "100" is not penalised).
- Speed: the model's own time per sentence, on the device shown, after a warm-up; load is the time to ready and the memory this process grew by (a Python model's own memory is not counted).
- Everything goes through the app's own transcriber, so a number here is what the app gets.
- Raw data: `run.json` next to this report, with every clip's text per model.
