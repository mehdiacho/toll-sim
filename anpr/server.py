"""ANPR service: the trained plate reader over HTTP, on ONNX Runtime (no torch needed).

  .venv/Scripts/python server.py            # http://127.0.0.1:4100

POST /read     {"image_b64": "..."}         -> {"plate", "confidence", "candidates"}
               The real interface: a camera's plate crop in, a reading out.
POST /capture  {"plate": "B123ABC", "difficulty"?: 1.0, "seed"?: 7}
               Simulation only. Renders the plate as a gantry camera would
               capture it, then reads it, and returns the image with the read.
               The SUMO bridge uses this, so every simulated passage goes
               through the real model rather than a made-up error rate.
GET  /health
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import random
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from model import decode, preprocess
from plates import capture, to_jpeg_b64

OUT = Path(__file__).resolve().parent / "out"


class Reader:
    def __init__(self, path: Path):
        self.session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        self.lock = threading.Lock()

    def read(self, img: Image.Image) -> dict:
        x = preprocess(img)[None]
        with self.lock:
            lp = self.session.run(None, {"image": x})[0][0]
        plate, conf, alts = decode(lp)
        return {
            "plate": plate,
            "confidence": round(conf, 4),
            "candidates": [{"plate": plate, "confidence": round(conf, 4)}]
            + [{"plate": a, "confidence": round(c, 4)} for a, c in alts],
        }


def make_handler(reader: Reader):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.send(200, {"ok": True}) if self.path == "/health" else self.send(404, {"error": "not_found"})

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                if self.path == "/read":
                    img = Image.open(io.BytesIO(base64.b64decode(body["image_b64"]))).convert("RGB")
                    return self.send(200, reader.read(img))
                if self.path == "/capture":
                    rng = random.Random(body.get("seed"))
                    img = capture(str(body["plate"]).upper().replace(" ", ""), rng, float(body.get("difficulty", 1.0)))
                    return self.send(200, {**reader.read(img), "image_b64": to_jpeg_b64(img)})
                self.send(404, {"error": "not_found"})
            except (KeyError, ValueError, OSError) as e:
                self.send(400, {"error": "bad_request", "message": str(e)})

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=4100)
    ap.add_argument("--model", default=str(OUT / "crnn.onnx"))
    args = ap.parse_args()
    reader = Reader(Path(args.model))
    print(f"ANPR service on http://127.0.0.1:{args.port} ({Path(args.model).name})")
    ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(reader)).serve_forever()


if __name__ == "__main__":
    main()
