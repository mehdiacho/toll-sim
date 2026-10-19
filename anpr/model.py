"""CRNN plate reader: a small CNN, a bidirectional LSTM over the columns, and CTC.

CTC lets the model read a variable-length plate without being told where each
character is, which is what makes training on rendered plates practical.
Input is a grayscale crop resized to 32 x 128; output is 32 time steps over the
36 characters plus the CTC blank.
"""

from __future__ import annotations

import numpy as np
import torch
from PIL import Image
from torch import nn

from plates import CHARSET

IMG_H, IMG_W = 32, 128
NUM_CLASSES = len(CHARSET) + 1  # + CTC blank at index 0


def block(cin: int, cout: int) -> list[nn.Module]:
    return [nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True)]


class CRNN(nn.Module):
    def __init__(self, hidden: int = 128):
        super().__init__()
        self.cnn = nn.Sequential(
            *block(1, 64), nn.MaxPool2d(2, 2),           # 16 x 64
            *block(64, 128), nn.MaxPool2d(2, 2),         # 8 x 32
            *block(128, 256), *block(256, 256),
            nn.MaxPool2d((2, 1), (2, 1)),                # 4 x 32
            *block(256, 256), *block(256, 256),
            nn.MaxPool2d((2, 1), (2, 1)),                # 2 x 32
            nn.Conv2d(256, 256, (2, 1), bias=False), nn.BatchNorm2d(256), nn.ReLU(inplace=True),  # 1 x 32
            nn.Dropout2d(0.1),
        )
        self.rnn = nn.LSTM(256, hidden, num_layers=2, bidirectional=True, batch_first=True, dropout=0.2)
        self.head = nn.Linear(hidden * 2, NUM_CLASSES)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        f = self.cnn(x).squeeze(2).permute(0, 2, 1)  # (B, T, C)
        out, _ = self.rnn(f)
        return self.head(out).log_softmax(-1)  # (B, T, classes)


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
