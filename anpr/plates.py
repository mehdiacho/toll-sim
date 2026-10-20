"""Synthetic Botswana number plates as a gantry camera would see them.

render_plate() draws a clean plate: black characters on white (front) or yellow
(rear), the standard private format "B 123 ABC", a thin border and sometimes a
"BOTSWANA" caption. The layout is illustrative, close enough to train a reader,
and not an official specification.

capture() then degrades the plate the way a roadside camera does: perspective
from a camera mounted above the lane, motion blur at 120 km/h, night-time
infrared, glare, shadow, dirt, low resolution and JPEG compression. The result
is a tight plate crop: plate *detection* in a full frame is out of scope here,
since free-flow gantry cameras are triggered per lane and crop the plate region.
"""

from __future__ import annotations

import io
import os
import random
import string
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT_DIR = Path(os.environ.get("FONT_DIR", "C:/Windows/Fonts"))
# On Linux (the Docker image) the Windows fonts aren't there: use the closest free
# ones. Liberation Sans is metric-compatible with Arial; DejaVu covers the rest.
FALLBACK_FONTS = {
    "bahnschrift.ttf": "LiberationSansNarrow-Bold.ttf",
    "ARIALNB.TTF": "LiberationSansNarrow-Bold.ttf",
    "arialbd.ttf": "LiberationSans-Bold.ttf",
    "tahomabd.ttf": "DejaVuSans-Bold.ttf",
    "verdanab.ttf": "DejaVuSans-Bold.ttf",
}
FALLBACK_DIRS = [Path("/usr/share/fonts/truetype/liberation"), Path("/usr/share/fonts/truetype/dejavu")]


def font_path(name: str) -> Path:
    path = FONT_DIR / name
    if path.exists():
        return path
    alt = FALLBACK_FONTS.get(name)
    for d in FALLBACK_DIRS:
        if alt and (d / alt).exists():
            return d / alt
    return path
# Bahnschrift is DIN 1451-based, the family most plate typefaces descend from;
# the others add variety so the model does not learn one font.
FONTS = [("bahnschrift.ttf", 0.55, "Bold"), ("ARIALNB.TTF", 0.2, None), ("arialbd.ttf", 0.1, None),
         ("tahomabd.ttf", 0.08, None), ("verdanab.ttf", 0.07, None)]
LETTERS = string.ascii_uppercase
CHARSET = string.digits + string.ascii_uppercase  # model alphabet; index 0 is the CTC blank

W, H = 520, 112  # plate canvas, roughly the 520 x 110 mm European-style plate
_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(name: str, size: int, variation: str | None) -> ImageFont.FreeTypeFont:
    key = (name, size)
    if key not in _font_cache:
        f = ImageFont.truetype(str(font_path(name)), size)
        if variation:
            try:
                f.set_variation_by_name(variation)
            except (OSError, ValueError):
                pass
        _font_cache[key] = f
    return _font_cache[key]


def random_text(rng: random.Random) -> str:
    """Mostly the standard private format; some personalised and odd plates."""
    r = rng.random()
    if r < 0.88:
        return f"B{rng.randint(100, 999)}{''.join(rng.choices(LETTERS, k=3))}"
    if r < 0.95:  # personalised: 2-7 letters and digits
        return "".join(rng.choices(CHARSET, k=rng.randint(2, 7)))
    # older or foreign-looking: letters then digits
    return "".join(rng.choices(LETTERS, k=rng.randint(2, 3))) + str(rng.randint(1, 9999))


def spaced(text: str) -> str:
    """How the plate is printed: B 123 ABC."""
    if len(text) == 7 and text[0] == "B" and text[1:4].isdigit() and text[4:].isalpha():
        return f"{text[0]} {text[1:4]} {text[4:]}"
    return text


def render_plate(text: str, rng: random.Random) -> Image.Image:
    rear = rng.random() < 0.5
    bg = (247, 203, 20) if rear else (245, 245, 240)
    bg = tuple(int(c * rng.uniform(0.85, 1.0)) for c in bg)
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    d.rectangle([3, 3, W - 4, H - 4], outline=(20, 20, 20), width=rng.choice([2, 3, 4]))

    name, _, variation = rng.choices(FONTS, weights=[f[1] for f in FONTS])[0]
    caption = rng.random() < 0.4
    left = 14
    if rng.random() < 0.35:  # flag strip: light blue with a black band edged in white
        d.rectangle([8, 8, 46, H - 9], fill=(117, 170, 219))
        mid = H // 2
        d.rectangle([8, mid - 9, 46, mid + 9], fill=(255, 255, 255))
        d.rectangle([8, mid - 6, 46, mid + 6], fill=(10, 10, 10))
        left = 54

    label = spaced(text)
    size = 86 if not caption else 76
    f = font(name, size, variation)
    while d.textlength(label, font=f) > W - left - 14 and size > 30:
        size -= 4
        f = font(name, size, variation)
    tw = d.textlength(label, font=f)
    x = left + (W - left - 10 - tw) / 2 + rng.uniform(-6, 6)
    bbox = d.textbbox((0, 0), label, font=f)
    th = bbox[3] - bbox[1]
    y = (H - th) / 2 - bbox[1] - (8 if caption else 0) + rng.uniform(-3, 3)
    d.text((x, y), label, font=f, fill=(15, 15, 15))
    if caption:
        cf = font("arialbd.ttf", 14, None)
        cw = d.textlength("BOTSWANA", font=cf)
        d.text(((W - cw) / 2, H - 24), "BOTSWANA", font=cf, fill=(30, 30, 30))
    return img


S = 0.5  # augment at half the canvas size: the final crop is smaller than this anyway, and it is 4x cheaper


def _warp(img: Image.Image, rng: random.Random, strength: float, angle: float, fill) -> Image.Image:
    """Perspective from a camera above the lane plus a small roll, as one transform."""
    w, h = img.size
    j = lambda k: rng.uniform(-k, k) * strength * w / W  # noqa: E731
    top = rng.uniform(0, 0.08) * w * strength  # top edge slightly narrower than the bottom
    quad = np.array([(top + j(10), j(6)), (j(10), h + j(6)), (w + j(10), h + j(6)), (w - top + j(10), j(6))])
    c, s = np.cos(np.radians(angle)), np.sin(np.radians(angle))
    centre = np.array([w / 2, h / 2])
    quad = (quad - centre) @ np.array([[c, -s], [s, c]]) + centre
    # PIL maps each output corner to the given source point.
    return img.transform((w, h), Image.QUAD, data=tuple(quad.ravel()), resample=Image.BILINEAR, fillcolor=fill)


def _motion_blur(arr: np.ndarray, length: int) -> np.ndarray:
    """Horizontal box blur (vehicle motion across a rolling shutter), via a cumulative sum."""
    if length < 2:
        return arr
    pad = np.pad(arr, ((0, 0), (length // 2, length - length // 2), (0, 0)), mode="edge")
    cs = np.cumsum(pad, axis=1, dtype=np.float32)
    return (cs[:, length:] - cs[:, :-length]) / length


def capture(text: str, rng: random.Random, difficulty: float = 1.0) -> Image.Image:
    """The plate as a gantry camera crops it. difficulty 0 = clean, 1 = typical, 2 = harsh."""
    plate = render_plate(text, rng).resize((int(W * S), int(H * S)), Image.BILINEAR)
    # Surrounding bumper/body, so the crop is not always exactly the plate edge.
    pad_x, pad_y = int(rng.randint(0, 40) * S), int(rng.randint(0, 20) * S)
    body = tuple(rng.randint(10, 220) for _ in range(3))
    canvas = Image.new("RGB", (plate.width + 2 * pad_x, plate.height + 2 * pad_y), body)
    canvas.paste(plate, (pad_x, pad_y))
    img = _warp(canvas, rng, 0.5 + 0.5 * difficulty, rng.uniform(-4, 4) * difficulty, body)
    # Crop jitter, occasionally clipping an edge of the plate.
    w, h = img.size
    cx0, cy0 = rng.uniform(0, 0.06) * w * difficulty, rng.uniform(0, 0.1) * h * difficulty
    cx1, cy1 = rng.uniform(0, 0.06) * w * difficulty, rng.uniform(0, 0.1) * h * difficulty
    img = img.crop((int(cx0), int(cy0), int(w - cx1), int(h - cy1)))

    arr = np.asarray(img).astype(np.float32)
    hh, ww = arr.shape[:2]
    if rng.random() < 0.3:  # IR illuminator at night: monochrome, retroreflective plate bright
        arr = np.repeat(arr.mean(axis=2, keepdims=True), 3, axis=2) * rng.uniform(0.6, 1.1)
    # Shadow across part of the plate (gantry structure, the vehicle's own body).
    if rng.random() < 0.3 * difficulty:
        xs = np.linspace(0, 1, ww)[None, :, None]
        arr *= np.where(xs < rng.uniform(0.2, 0.8), rng.uniform(0.35, 0.7), 1.0)
    yy, xx = np.ogrid[:hh, :ww]
    # Glare spot.
    if rng.random() < 0.15 * difficulty:
        cx, cy, r = rng.uniform(0, ww), rng.uniform(0, hh), rng.uniform(15, 60) * S
        arr += 255 * rng.uniform(0.4, 0.9) * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r))[..., None]
    # Dirt and road spray.
    for _ in range(int(rng.random() < 0.3 * difficulty) * rng.randint(1, 8)):
        x, y, r = rng.randint(0, ww), rng.randint(0, hh), rng.randint(3, 14) * S
        arr[(xx - x) ** 2 + (yy - y) ** 2 < r * r] *= rng.uniform(0.3, 0.8)
    # Exposure, contrast, gamma.
    arr = (arr - 128) * rng.uniform(1 - 0.35 * difficulty, 1 + 0.2 * difficulty) + 128 + rng.uniform(-40, 40) * difficulty
    arr = np.clip(arr, 0, 255)
    arr = 255 * (arr / 255) ** rng.uniform(1 - 0.3 * difficulty, 1 + 0.5 * difficulty)
    arr = _motion_blur(arr, int(rng.uniform(0, 9) * difficulty * S))
    arr += np.random.default_rng(rng.getrandbits(32)).normal(0, rng.uniform(2, 14) * difficulty, arr.shape).astype(np.float32)
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))

    if rng.random() < 0.5:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0, 1.6) * difficulty * S))
    # The plate is often only ~100-200 px wide in the frame.
    target_w = int(rng.uniform(110, 260) / max(difficulty, 0.5) if difficulty > 0 else 300)
    target_w = max(80, min(target_w, img.width))
    small = img.resize((target_w, max(18, int(img.height * target_w / img.width))), Image.BILINEAR)
    buf = io.BytesIO()
    small.save(buf, "JPEG", quality=rng.randint(int(70 - 40 * min(difficulty, 1.5) / 1.5), 92))
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def to_jpeg_b64(img: Image.Image, quality: int = 85) -> str:
    import base64

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode()


if __name__ == "__main__":
    # Contact sheet of samples: python plates.py out/samples.png
    import sys

    rng = random.Random(1)
    tiles = [capture(random_text(rng), rng, d).resize((260, 60)) for d in (0, 0.5, 1, 1.5) for _ in range(6)]
    sheet = Image.new("RGB", (260 * 4, 60 * 6), "white")
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i // 6) * 260, (i % 6) * 60))
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "out/samples.png")
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(f"wrote {out}")
