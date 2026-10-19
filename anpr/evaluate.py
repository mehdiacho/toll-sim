"""Measure the trained reader, choose the review threshold, export to ONNX.

  .venv/Scripts/python evaluate.py

On a held-out set of rendered captures (fixed seed, never seen in training) it
reports exact-match accuracy per difficulty band, then sweeps the confidence
threshold: reads at or above it are billed automatically, the rest go to the
review queue. The chosen threshold is the lowest one at which automatic reads
are at least --target accurate (default 99.9%), and it is what the back
office's REVIEW_CONFIDENCE_THRESHOLD should be set to.

Writes out/metrics.json and out/crnn.onnx.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from model import CRNN, IMG_H, IMG_W, decode
from train import fixed_set

OUT = Path(__file__).resolve().parent / "out"
BANDS = {"clean (0-0.5)": (0.0, 0.5), "typical (0.5-1.0)": (0.5, 1.0), "harsh (1.0-1.6)": (1.0, 1.6)}


@torch.no_grad()
def reads(model, imgs, device):
    out = []
    for i in range(0, len(imgs), 512):
        lp = model(imgs[i : i + 512].to(device)).cpu().numpy()
        out.extend(decode(x)[:2] for x in lp)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3000, help="samples per difficulty band")
    ap.add_argument("--target", type=float, default=0.999, help="accuracy required of automatic reads")
    args = ap.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = CRNN().to(device)
    model.load_state_dict(torch.load(OUT / "crnn.pt", map_location=device))
    model.eval()

    all_conf, all_ok, bands = [], [], {}
    for i, (name, rng) in enumerate(BANDS.items()):
        imgs, texts = fixed_set(args.n, 5000 + i, rng)
        r = reads(model, imgs, device)
        ok = [p == t for (p, _), t in zip(r, texts)]
        bands[name] = round(float(np.mean(ok)), 4)
        all_conf += [c for _, c in r]
        all_ok += ok
        print(f"{name:<20} accuracy {np.mean(ok):.2%}")
    conf, ok = np.array(all_conf), np.array(all_ok)
    print(f"{'overall':<20} accuracy {ok.mean():.2%}  ({len(ok)} reads)")

    sweep = []
    for th in np.round(np.arange(0.30, 1.0, 0.01), 2):
        auto = conf >= th
        sweep.append({
            "threshold": float(th),
            "automatic_share": round(float(auto.mean()), 4),
            "automatic_accuracy": round(float(ok[auto].mean()), 5) if auto.any() else None,
            "errors_caught_by_review": round(float((~ok & ~auto).sum() / max((~ok).sum(), 1)), 4),
        })
    chosen = next((s for s in sweep if s["automatic_accuracy"] and s["automatic_accuracy"] >= args.target), sweep[-1])
    print(
        f"threshold {chosen['threshold']}: {chosen['automatic_share']:.1%} of reads billed automatically at "
        f"{chosen['automatic_accuracy']:.2%} accuracy; review catches {chosen['errors_caught_by_review']:.1%} of errors"
    )

    metrics = {
        "overall_accuracy": round(float(ok.mean()), 4),
        "by_difficulty": bands,
        "target_automatic_accuracy": args.target,
        "review_threshold": chosen["threshold"],
        "at_threshold": chosen,
        "sweep": sweep,
    }
    (OUT / "metrics.json").write_text(json.dumps(metrics, indent=1))

    model.cpu()
    dummy = torch.zeros(1, 1, IMG_H, IMG_W)
    torch.onnx.export(model, dummy, OUT / "crnn.onnx", input_names=["image"], output_names=["log_probs"],
                      dynamic_axes={"image": {0: "batch"}, "log_probs": {0: "batch"}}, opset_version=17, dynamo=False)
    print("wrote out/metrics.json and out/crnn.onnx")


if __name__ == "__main__":
    main()
