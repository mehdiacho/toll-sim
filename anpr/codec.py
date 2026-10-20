"""Pre- and post-processing for the CRNN plate reader, without torch.

The ANPR service runs the exported ONNX model, so it needs only these, numpy and
Pillow; model.py (training) re-exports them.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

from plates import CHARSET

IMG_H, IMG_W = 32, 128
NUM_CLASSES = len(CHARSET) + 1  # + CTC blank at index 0


def preprocess(img: Image.Image) -> np.ndarray:
    """PIL image -> float32 (1, H, W) in [-1, 1]."""
    g = img.convert("L").resize((IMG_W, IMG_H), Image.BILINEAR)
    a = np.asarray(g, dtype=np.float32) / 127.5 - 1.0
    return a[None]


def encode(text: str) -> list[int]:
    return [CHARSET.index(c) + 1 for c in text]


def decode(log_probs: np.ndarray, alternatives: int = 3) -> tuple[str, float, list[tuple[str, float]]]:
    """Greedy CTC decode of one (T, classes) array of log-probabilities.

    confidence is the product of the per-character probabilities along the best
    path, so one doubtful character makes the whole read doubtful, which is what
    the review threshold needs. Alternatives swap the least certain characters
    for their runner-up, the confusions a human reviewer most needs to see.
    """
    probs = np.exp(log_probs)
    best = probs.argmax(1)
    chars: list[tuple[int, float, int, float]] = []  # (class, p, runner-up class, its p) per emitted char
    prev = 0
    for t, k in enumerate(best):
        if k != 0 and k != prev:
            order = np.argsort(probs[t])[::-1]
            second = next(int(c) for c in order if c not in (0, k))
            chars.append((int(k), float(probs[t, k]), second, float(probs[t, second])))
        elif k != 0 and k == prev and probs[t, k] > chars[-1][1]:
            chars[-1] = (chars[-1][0], float(probs[t, k]), chars[-1][2], chars[-1][3])
        prev = k
    text = "".join(CHARSET[c - 1] for c, *_ in chars)
    conf = float(np.prod([p for _, p, _, _ in chars])) if chars else 0.0
    alts: list[tuple[str, float]] = []
    for i in sorted(range(len(chars)), key=lambda i: chars[i][1])[:alternatives]:
        c, p, c2, p2 = chars[i]
        if p2 < 1e-3:
            continue
        alt = text[:i] + CHARSET[c2 - 1] + text[i + 1 :]
        alts.append((alt, conf / p * p2))
    alts.sort(key=lambda a: -a[1])
    return text, conf, alts
