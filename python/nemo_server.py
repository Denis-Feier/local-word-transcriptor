"""Serves an NVIDIA NeMo speech model over local HTTP for the Node app (see lib/engines/python-nemo.js).

GET  /health      -> 200 once the model is loaded
POST /inference   body: float32 little-endian PCM, 16 kHz mono  -> {"text": "..."}
"""
import argparse
import json
import logging
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np


def load_model(args):
    import torch
    from nemo.collections.asr.models import ASRModel
    from omegaconf import OmegaConf

    torch.set_num_threads(args.threads)
    logging.getLogger("nemo_logger").setLevel(logging.ERROR)
    model = ASRModel.restore_from(args.model, map_location="cpu")
    model.eval()
    if args.decoder == "ctc-lm":
        # CTC beam search with the 4-gram language model: the model card's most accurate setting.
        model.change_decoding_strategy(OmegaConf.create({
            "strategy": "beam_batch",
            "beam": {"beam_size": args.beam, "ngram_lm_model": args.lm, "ngram_lm_alpha": 0.5, "beam_beta": 2.0,
                     "return_best_hypothesis": True, "allow_cuda_graphs": False},
        }), decoder_type="ctc", verbose=False)
    elif args.decoder == "ctc":
        model.change_decoding_strategy(decoder_type="ctc", verbose=False)
    else:
        model.change_decoding_strategy(decoder_type="rnnt", verbose=False)  # RNNT/TDT greedy
    return model


def transcribe(model, samples):
    import torch

    with torch.inference_mode():
        out = model.transcribe([samples], batch_size=1, verbose=False)
    if isinstance(out, tuple):  # some decoders return (best, all)
        out = out[0]
    hyp = out[0]
    return hyp if isinstance(hyp, str) else getattr(hyp, "text", str(hyp))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--lm")
    p.add_argument("--decoder", choices=["ctc-lm", "ctc", "rnnt", "tdt"], default="tdt")
    p.add_argument("--beam", type=int, default=32)
    p.add_argument("--threads", type=int, default=4)
    args = p.parse_args()
    if args.decoder == "ctc-lm" and not args.lm:
        sys.exit("--decoder ctc-lm needs --lm")

    t0 = time.time()
    model = load_model(args)
    transcribe(model, np.zeros(16000, dtype=np.float32))  # warm-up
    print(f"model loaded in {time.time() - t0:.1f} s", flush=True)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self.reply(200, {"status": "ok"})
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/inference":
                return self.reply(404, {"error": "not found"})
            try:
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                samples = np.frombuffer(raw, dtype="<f4").copy()
                self.reply(200, {"text": transcribe(model, samples) if len(samples) else ""})
            except Exception as err:  # report to the app instead of dying mid-meeting
                self.reply(500, {"error": f"{type(err).__name__}: {err}"})

    HTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
