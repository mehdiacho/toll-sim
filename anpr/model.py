"""CRNN plate reader: a small CNN, a bidirectional LSTM over the columns, and CTC.

CTC lets the model read a variable-length plate without being told where each
character is, which is what makes training on rendered plates practical.
Input is a grayscale crop resized to 32 x 128; output is 32 time steps over the
36 characters plus the CTC blank.
"""

from __future__ import annotations

import torch
from torch import nn

from codec import IMG_H, IMG_W, NUM_CLASSES, decode, encode, preprocess  # noqa: F401 (re-exported)


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
