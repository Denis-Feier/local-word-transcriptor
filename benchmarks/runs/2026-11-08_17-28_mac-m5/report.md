# Benchmark: 2026-11-08_17-28_mac-m5

Measured on 2026-11-08 with Live Transcriber 1.0.1 (9bac201, uncommitted changes).

**Computer:** macOS 26.7.1 (build 25G241, Darwin 25.6.0, arm64), Apple M5 × 10, 24 GB RAM, GPU Apple M5 (10 cores), on AC (100 %); Node v24.21.0.
**Compute devices seen by transcribe.cpp:** MTL0 (Apple M5), 17.8 GB; CPU (Apple M5), 24 GB.

**Run:** 5 models, 1 at a time, budget 60 min, took 12 min. 883 FLEURS Romanian clips available; stages sized per model to fit the budget (⏱ = a stage stopped at the deadline, so that model's numbers cover fewer clips).

## Accuracy and speed (FLEURS Romanian, read speech)

| # | Model | Runs on | WER (with diacritics) | WER (diacritics ignored) | WER (no digits) | Clips | Speed | Per sentence | Load |
|---|---|---|---|---|---|---|---|---|---|
| 1 | NVIDIA Canary 1B v2 | GPU (Metal) | 5.98 % | 5.57 % | 5.34 % | 100 | 56× real-time | 171 ms (max 271) | 0.2 s, +118 MB |
| 2 | Parakeet Ultra 0.6B | GPU (Metal) | 10.00 % | 9.68 % | 8.80 % | 100 | 98× real-time | 98 ms (max 152) | 0.2 s, +242 MB |
| 3 | NVIDIA Nemotron unified 0.6B | GPU (MPS) | 10.19 % | 9.91 % | 9.39 % | 100 | 48× real-time | 201 ms (max 460) | 11.1 s, +26 MB |
| 4 | Parakeet Redux (Moondream) | CPU | 11.42 % | 10.96 % | 10.35 % | 100 | 37× real-time | 257 ms (max 424) | 1.7 s, +2708 MB |

Speed by sentence length (ms per sentence; × = times faster than real time):

| Model | 0–6 s | 6–10 s | 10–15 s | 15+ s | ~20 s joined | ~40 s joined |
|---|---|---|---|---|---|---|
| NVIDIA Canary 1B v2 | 106 ms (48×), n=8 | 142 ms (55×), n=49 | 214 ms (56×), n=40 | 258 ms (62×), n=3 | 427 ms (61×), WER 1.8 % | 736 ms (61×), WER 4.9 % |
| Parakeet Ultra 0.6B | 62 ms (82×), n=8 | 82 ms (96×), n=49 | 120 ms (100×), n=40 | 145 ms (110×), n=3 | 305 ms (86×), WER 7.4 % | 581 ms (77×), WER 9.1 % |
| NVIDIA Nemotron unified 0.6B | 129 ms (39×), n=8 | 166 ms (47×), n=49 | 247 ms (49×), n=40 | 362 ms (44×), n=3 | 511 ms (51×), WER 9.7 % | 851 ms (52×), WER 11.2 % |
| Parakeet Redux (Moondream) | 163 ms (31×), n=8 | 218 ms (36×), n=49 | 312 ms (39×), n=40 | 398 ms (40×), n=3 | 645 ms (41×), WER 6.8 % | 1177 ms (38×), WER 10.4 % |

## Live text: how much it rewrites itself (#27)

Each sentence replayed on the app's live-guess schedule (first guess at 0.6 s, then every 0.5 s or twice the model's own time, while it is free). *Erasure*: words shown and then taken back, per word of the final line (0 = never). *Coverage*: words of the final line already on screen when it arrived. *Raw*: the model's guesses as written; *steady*: with Steady live text (the default).

| Model | Sentences | Guesses / sentence | Erasure raw | Erasure steady | Rewrites raw | Rewrites steady | Coverage raw | Coverage steady | First words raw | First words steady | Final after pause |
|---|---|---|---|---|---|---|---|---|---|---|---|
| NVIDIA Canary 1B v2 | 40 | 19.2 | 2.07 | 0.28 | 50 % | 6 % | 99 % | 73 % | 0.6 s | 2.2 s | 215 ms |
| NVIDIA Nemotron unified 0.6B | 40 | 19.2 | 1.25 | 0.35 | 48 % | 4 % | 99 % | 88 % | 1.2 s | 2.2 s | 244 ms |
| Parakeet Ultra 0.6B | 40 | 19.2 | 2.34 | 0.39 | 53 % | 6 % | 99 % | 79 % | 1.1 s | 2.1 s | 113 ms |
| Parakeet Redux (Moondream) | 40 | 18.8 | 2.00 | 0.40 | 53 % | 6 % | 99 % | 76 % | 1.2 s | 2.2 s | 314 ms |

## Noise, a quiet speaker, a mic across the room

Word error rate (diacritics ignored) on the same clips, clean and with each condition added; in brackets the change against clean.

| Model | Clips | clean | noise, SNR 20 dB | noise, SNR 10 dB | quiet speaker, −20 dB | mic across the room |
|---|---|---|---|---|---|---|
| NVIDIA Canary 1B v2 | 25 | 5.2 % | 8.8 % (+3.6) | 20.1 % (+14.9) | 5.2 % (+0.0) | 8.4 % (+3.2) |
| Parakeet Ultra 0.6B | 25 | 8.2 % | 12.7 % (+4.5) | 27.2 % (+19.0) | 7.9 % (-0.4) | 8.8 % (+0.5) |
| NVIDIA Nemotron unified 0.6B | 25 | 9.3 % | 12.0 % (+2.7) | 27.6 % (+18.3) | 9.7 % (+0.4) | 12.0 % (+2.7) |
| Parakeet Redux (Moondream) | 25 | 10.2 % | 12.5 % (+2.3) | 22.6 % (+12.4) | 10.0 % (-0.2) | 13.8 % (+3.6) |

## Silence and noise alone

Nothing is said; every word written is invented (a hallucination). The app drops some known ones; these are what is left.

| Model | 3 s of silence | 10 s of silence | 5 s of an empty room (−50 dBFS) | 5 s of a fan by the mic (−30 dBFS) |
|---|---|---|---|---|
| NVIDIA Canary 1B v2 | nothing, 57 ms | nothing, 86 ms | nothing, 67 ms | nothing, 68 ms |
| Parakeet Ultra 0.6B | nothing, 57 ms | nothing, 74 ms | nothing, 56 ms | nothing, 56 ms |
| NVIDIA Nemotron unified 0.6B | nothing, 73 ms | nothing, 135 ms | nothing, 82 ms | nothing, 73 ms |
| Parakeet Redux (Moondream) | nothing, 127 ms | nothing, 239 ms | nothing, 134 ms | nothing, 135 ms |

## Models that could not run

- Fun-ASR-MLT-Nano 0.8B (Alibaba): run stopped: output began repeating

## How it was measured

- Audio: the FLEURS Romanian test set (Google, CC-BY-4.0), a fixed selection spread evenly over the 883 clips; the same selection on every computer. Noise, the quiet speaker, the room and the silences are synthetic and seeded.
- Word error rate: corpus level (all errors / all reference words), lowercased, punctuation removed. "With diacritics" counts "sa" for "să" as an error. "No digits" leaves out the sentences whose reference has digits (a model that writes "o sută" for "100" is not penalised).
- Speed: the model's own time per sentence, on the device shown, after a warm-up; load is the time to ready and the memory this process grew by (a Python model's own memory is not counted).
- Everything goes through the app's own transcriber, so a number here is what the app gets.
- Raw data: `run.json` next to this report, with every clip's text per model.
