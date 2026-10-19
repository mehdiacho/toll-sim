"""Train the plate reader on rendered plates, generated fresh every batch.

  .venv/Scripts/python train.py                  # ~25k steps, about 20 min on an RTX 3060 Laptop
  .venv/Scripts/python train.py --steps 2000     # quick smoke run

Writes out/crnn.pt (best checkpoint by validation accuracy) and out/train_log.csv.
Run evaluate.py afterwards for the confidence threshold and the ONNX export.
"""

from __future__ import annotations

import argparse
import csv
import random
import time
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader, IterableDataset, get_worker_info

from model import CRNN, decode, encode, preprocess
from plates import capture, random_text

OUT = Path(__file__).resolve().parent / "out"


class Plates(IterableDataset):
    """Endless stream of (image, label). Each worker gets its own seed."""

    def __init__(self, seed: int, max_difficulty: float = 1.6):
        self.seed = seed
        self.max_difficulty = max_difficulty

    def __iter__(self):
        info = get_worker_info()
        rng = random.Random(self.seed * 1000 + (info.id if info else 0))
        while True:
            text = random_text(rng)
            img = capture(text, rng, rng.uniform(0, self.max_difficulty))
            yield torch.from_numpy(preprocess(img)), text


def collate(batch):
    imgs = torch.stack([b[0] for b in batch])
    texts = [b[1] for b in batch]
    targets = torch.tensor([i for t in texts for i in encode(t)], dtype=torch.long)
    lengths = torch.tensor([len(t) for t in texts], dtype=torch.long)
    return imgs, targets, lengths, texts


def fixed_set(n: int, seed: int, difficulty: tuple[float, float]):
    rng = random.Random(seed)
    items = []
    for _ in range(n):
        t = random_text(rng)
        items.append((preprocess(capture(t, rng, rng.uniform(*difficulty))), t))
    return torch.from_numpy(np.stack([i[0] for i in items])), [i[1] for i in items]


@torch.no_grad()
def accuracy(model, imgs, texts, device) -> float:
    model.eval()
    hits = 0
    for i in range(0, len(texts), 512):
        lp = model(imgs[i : i + 512].to(device)).cpu().numpy()
        hits += sum(decode(lp[j])[0] == texts[i + j] for j in range(len(lp)))
    model.train()
    return hits / len(texts)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=25000)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"device: {device} {torch.cuda.get_device_name(0) if device.type == 'cuda' else ''}")
    torch.manual_seed(args.seed)
    OUT.mkdir(exist_ok=True)

    loader = DataLoader(Plates(args.seed, 1.6), batch_size=args.batch, num_workers=args.workers,
                        collate_fn=collate, persistent_workers=args.workers > 0, prefetch_factor=4 if args.workers else None)
    val_imgs, val_texts = fixed_set(2000, 99, (0.0, 1.3))
    model = CRNN().to(device)
    print(f"parameters: {sum(p.numel() for p in model.parameters()) / 1e6:.2f}M")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=args.steps, pct_start=0.1)
    ctc = torch.nn.CTCLoss(blank=0, zero_infinity=True)
    scaler = torch.amp.GradScaler(enabled=device.type == "cuda")

    best, t0, running = 0.0, time.time(), 0.0
    log = (OUT / "train_log.csv").open("w", newline="")
    writer = csv.writer(log)
    writer.writerow(["step", "loss", "val_acc", "lr", "seconds"])
    for step, (imgs, targets, lengths, _) in enumerate(loader, 1):
        imgs = imgs.to(device, non_blocking=True)
        with torch.autocast(device.type, enabled=device.type == "cuda"):
            lp = model(imgs)
        lp = lp.float().permute(1, 0, 2)  # (T, B, C) for CTC
        loss = ctc(lp, targets, torch.full((imgs.size(0),), lp.size(0), dtype=torch.long), lengths)
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(opt)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        scaler.step(opt)
        scaler.update()
        sched.step()
        running = 0.98 * running + 0.02 * loss.item() if step > 1 else loss.item()

        if step % 500 == 0 or step == args.steps:
            acc = accuracy(model, val_imgs, val_texts, device)
            writer.writerow([step, f"{running:.4f}", f"{acc:.4f}", f"{sched.get_last_lr()[0]:.2e}", int(time.time() - t0)])
            log.flush()
            mark = ""
            if acc > best:
                best = acc
                torch.save(model.state_dict(), OUT / "crnn.pt")
                mark = " *"
            print(f"step {step:>6}  loss {running:.3f}  val acc {acc:.3%}  {time.time() - t0:.0f}s{mark}", flush=True)
        if step >= args.steps:
            break
    log.close()
    print(f"best val accuracy {best:.3%}; checkpoint out/crnn.pt")


if __name__ == "__main__":
    main()
