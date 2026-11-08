"""Serves an NVIDIA NeMo speech model over local HTTP for the Node app (see lib/engines/python-nemo.ts).

GET  /health      -> 200 once the model is loaded: {"status": "ok", "device": "GPU (MPS)" | "CPU", "fallback": ...}
POST /inference   body: float32 little-endian PCM, 16 kHz mono  -> {"text": "...", "device": ..., "fallback": ...}

--device auto (the default) puts the acoustic model on the GPU when PyTorch has one (MPS on Apple silicon, CUDA
elsewhere) and on the CPU otherwise. If the GPU fails to load or warm up the model, or fails on a request later, the
model moves to the CPU and stays there. A language-model beam search (Jackrabbit's 4-gram) always runs on the CPU.

--lang tells a multilingual model that takes a language prompt (Nemotron unified 0.6B) which language it hears; NeMo
passes it to transcribe() as target_lang. Models without one (Jackrabbit, the UPB FastConformer) are not given it.
"""
import os

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # operations MPS lacks run on the CPU; set before torch loads

import argparse
import json
import logging
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np


DEVICE_NAMES = {"mps": "GPU (MPS)", "cuda": "GPU (CUDA)", "cpu": "CPU"}


def pick_device(wanted):
    """'auto' -> the GPU PyTorch can use here, else 'cpu'."""
    import torch

    if wanted != "auto":
        return wanted
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def load_model(args, device):
    import torch
    from nemo.collections.asr.models import ASRModel
    from omegaconf import OmegaConf

    torch.set_num_threads(args.threads)
    logging.getLogger("nemo_logger").setLevel(logging.ERROR)
    # Loaded on the CPU, then moved: restore_from straight onto MPS is not supported by every NeMo release.
    model = ASRModel.restore_from(args.model, map_location="cpu")
    model.eval()
    if device != "cpu":
        model = model.to(device)
    if args.decoder == "ctc-lm":
        # CTC beam search with the 4-gram language model: the model card's most accurate setting.
        model.change_decoding_strategy(OmegaConf.create({
            "strategy": "beam_batch",
            "beam": {"beam_size": args.beam, "ngram_lm_model": args.lm, "ngram_lm_alpha": 0.5, "beam_beta": 2.0,
                     "return_best_hypothesis": True, "allow_cuda_graphs": False},
        }), decoder_type="ctc", verbose=False)
    elif args.decoder == "ctc":
        model.change_decoding_strategy(decoder_type="ctc", verbose=False)
    elif hasattr(model, "ctc_decoder"):
        model.change_decoding_strategy(decoder_type="rnnt", verbose=False)  # hybrid RNNT/CTC: its RNNT/TDT head, greedy
    # A pure RNNT/TDT model (Nemotron unified) decodes with its own head as it is: its change_decoding_strategy takes a
    # whole decoding config and no decoder_type.
    return model


def first_text(out):
    if isinstance(out, tuple):  # some decoders return (best, all)
        out = out[0]
    hyp = out[0]
    if isinstance(hyp, list):  # (n-best lists)
        hyp = hyp[0]
    return hyp if isinstance(hyp, str) else getattr(hyp, "text", str(hyp))


def transcribe_lm_split(model, samples, device):
    """The acoustic model on the GPU, the language-model beam search on the CPU (it is not written for MPS)."""
    import torch

    audio = torch.from_numpy(samples).unsqueeze(0).to(device)
    length = torch.tensor([audio.shape[1]], device=device)
    if hasattr(model, "ctc_decoder"):  # hybrid RNNT/CTC model: the CTC head sits on the encoder output
        encoded, encoded_len = model.forward(input_signal=audio, input_signal_length=length)
        log_probs = model.ctc_decoder(encoder_output=encoded)
        decoding = model.ctc_decoding
    else:  # pure CTC model
        log_probs, encoded_len, _ = model.forward(input_signal=audio, input_signal_length=length)
        decoding = model.decoding
    out = decoding.ctc_decoder_predictions_tensor(log_probs.float().cpu(), decoder_lengths=encoded_len.cpu(),
                                                  return_hypotheses=False)
    return first_text(out)


def transcribe(model, samples, device="cpu", decoder="tdt", lang=None):
    import torch

    with torch.inference_mode():
        if decoder == "ctc-lm" and device != "cpu":
            return transcribe_lm_split(model, samples, device)
        language = {"target_lang": lang} if lang else {}  # only models with a language prompt take it
        return first_text(model.transcribe([samples], batch_size=1, verbose=False, **language))


class Runner:
    """The model and the device it runs on. A GPU failure moves it to the CPU for good, so the meeting goes on."""

    def __init__(self, args):
        self.args = args
        self.fallback = None
        self.device = pick_device(args.device)
        warmup = np.zeros(16000, dtype=np.float32)
        try:
            self.model = load_model(args, self.device)
            transcribe(self.model, warmup, self.device, args.decoder, args.lang)
        except Exception as err:
            if self.device == "cpu":
                raise
            self.to_cpu(err, reload=True)
            transcribe(self.model, warmup, self.device, args.decoder, args.lang)

    def to_cpu(self, err, reload=False):
        self.fallback = f"{DEVICE_NAMES.get(self.device, self.device)} failed: {type(err).__name__}: {err}"
        print(f"{self.fallback}; using the CPU", file=sys.stderr, flush=True)
        self.device = "cpu"
        self.model = load_model(self.args, "cpu") if reload else self.model.to("cpu")

    def transcribe(self, samples):
        try:
            return transcribe(self.model, samples, self.device, self.args.decoder, self.args.lang)
        except Exception as err:
            if self.device == "cpu":
                raise
            self.to_cpu(err)
            return transcribe(self.model, samples, self.device, self.args.decoder, self.args.lang)

    def describe(self):
        return DEVICE_NAMES.get(self.device, self.device)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--lm")
    p.add_argument("--decoder", choices=["ctc-lm", "ctc", "rnnt", "tdt"], default="tdt")
    p.add_argument("--beam", type=int, default=32)
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--device", choices=["auto", "mps", "cuda", "cpu"], default="auto")
    p.add_argument("--lang", help="the language for a model with a language prompt, e.g. ro (NeMo's target_lang)")
    args = p.parse_args()
    if args.decoder == "ctc-lm" and not args.lm:
        sys.exit("--decoder ctc-lm needs --lm")

    t0 = time.time()
    runner = Runner(args)  # loads the model and warms it up
    print(f"model loaded on {runner.describe()} in {time.time() - t0:.1f} s", flush=True)

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
                self.reply(200, {"status": "ok", "device": runner.describe(), "fallback": runner.fallback})
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/inference":
                return self.reply(404, {"error": "not found"})
            try:
                raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                samples = np.frombuffer(raw, dtype="<f4").copy()
                self.reply(200, {"text": runner.transcribe(samples) if len(samples) else "",
                                  "device": runner.describe(), "fallback": runner.fallback})
            except Exception as err:  # report to the app instead of dying mid-meeting
                self.reply(500, {"error": f"{type(err).__name__}: {err}"})

    HTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
