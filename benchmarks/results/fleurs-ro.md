# FLEURS Romanian benchmark

883 recorded sentences (152 min), measured on this Mac on 2026-10-30 (FastConformer Romanian on 2026-11-01).

| # | Model | WER (with diacritics) | WER (diacritics ignored) | Speed | Per sentence |
|---|---|---|---|---|---|
| 1 | NVIDIA Canary 1B v2 | 6.82 % | 6.63 % | 43× real-time | 238 ms |
| 2 | Jackrabbit 110M Romanian (Surogate) | 7.03 % | 6.90 % | 19× real-time | 549 ms |
| 3 | Parakeet Ultra 0.6B | 10.09 % | 9.88 % | 92× real-time | 112 ms |
| 4 | Orukeet 0.6B | 10.90 % | 10.66 % | 95× real-time | 108 ms |
| 5 | FastConformer Romanian 114M (UPB NLP) | 11.81 % | 11.61 % | 53× real-time | 195 ms |
| 6 | Parakeet Romanian 110M (Politehnica) | 12.62 % | 12.23 % | 86× real-time | 119 ms |

How it is scored: corpus-level word error rate (all errors / all reference words) against FLEURS's raw
transcriptions. Text is lowercased and punctuation removed, as the Open ASR Leaderboard does. "With diacritics"
counts "sa" for "să" as an error; "diacritics ignored" doesn't, which is how published numbers are computed.
Numbers count as errors when a model writes words for digits ("o sută" vs "100"), the same for every model.
Per-clip transcripts: `benchmarks/results/fleurs-ro/<model>.json`.

## Every model on the same 100 clips (2026-11-02, Apple M5)

The one-hour benchmark (`npm run benchmark:suite`, [#23](https://github.com/Denis-Feier/local-word-transcriptor/issues/23) and [#28](https://github.com/Denis-Feier/local-word-transcriptor/issues/28)): a fixed selection of 100 of the
883 clips (16 min), every model through the app's own transcriber on the same Mac. Live text: words shown and then
taken back per word of the final line, with Steady live text (the default) and raw. Noise: WER (diacritics ignored)
with white noise at 10 dB SNR on 25 of the clips. Silence: of 4 inputs with no speech, how many got invented text.
Full report, with long sentences, a quiet speaker and a mic across the room: `../runs/2026-11-02_20-09_mac-m5/report.md`.

| # | Model | WER (with diacritics) | WER (diacritics ignored) | Speed | Live erasure steady / raw | Noise 10 dB | Silence |
|---|---|---|---|---|---|---|---|
| 1 | NVIDIA Canary 1B v2 | 5.98 % | 5.57 % | 55× | 0.28 / 2.07 | 20.1 % | 0 / 4 |
| 2 | Jackrabbit 110M Romanian (Surogate) | 7.77 % | 7.58 % | 25× | 0.09 / 1.17 | 12.2 % | 0 / 4 |
| 3 | Whisper large-v3 | 9.05 % | 8.54 % | 7× | 0.13 / 0.35 | 24.2 % | 0 / 4 |
| 4 | Parakeet Ultra 0.6B | 10.00 % | 9.68 % | 72× | 0.39 / 2.34 | 27.2 % | 0 / 4 |
| 5 | Orukeet 0.6B | 10.19 % | 9.87 % | 76× | 0.28 / 1.86 | 31.0 % | 0 / 4 |
| 6 | FastConformer Romanian 114M (UPB NLP) | 11.28 % | 10.96 % | 93× | 0.30 / 2.20 | 20.6 % | 0 / 4 |
| 7 | Whisper large-v3 Romanian (BuzzASR)¹ | 11.68 % | 11.41 % | 4× | 0.05 / 0.31 | 21.7 % | 1 / 4 |
| 8 | Whisper large-v3 turbo | 11.92 % | 9.18 % | 17× | 0.29 / 0.98 | 29.4 % | 1 / 4 |
| 9 | NVIDIA Parakeet TDT 0.6B v3 | 12.06 % | 11.69 % | 86× | 0.41 / 3.76 | 33.3 % | 0 / 4 |
| 10 | Parakeet Romanian 110M (Politehnica) | 12.56 % | 11.92 % | 216× | 0.31 / 2.07 | 17.9 % | 0 / 4 |
| 11 | Apple on-device dictation (macOS 26) | 16.72 % | 16.40 % | 62× | 0.04 / 0.35 | 52.9 % | 1 / 4 |
| 12 | Whisper small Romanian (readerbench) | 19.37 % | 19.05 % | 26× | 0.31 / 3.83 | 49.6 % | 4 / 4 |

¹ 78 of the 100 clips: at 4× real-time its stages were shrunk to fit the two-hour budget.

The six models in the 883-clip table above land within a point of their numbers here, so the selection is a fair
proxy for the whole set.
