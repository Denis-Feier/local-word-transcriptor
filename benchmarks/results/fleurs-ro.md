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
