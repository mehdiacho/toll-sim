"""Write net/a1.rou.xml: traffic on the A1 corridor for one simulated period.

Three kinds of trip, all as SUMO flows so departures are random (Poisson):
  through traffic   Gaborone <-> Mahalapye, the whole corridor
  local traffic     Gaborone <-> an intermediate point (commuters, Mochudi, Artesia)
  regional traffic  an intermediate point <-> Mahalapye

The vehicle mix maps onto the back office's toll classes; the vType id is the
class code, so the bridge can read a vehicle's class straight from its type.

Usage: .venv/Scripts/python demand.py [--hours 2] [--scale 1.0] [--seed 7]
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORRIDOR = HERE / "net" / "corridor.json"
OUT = HERE / "net" / "a1.rou.xml"

# id (= toll class), SUMO vClass, share of traffic, attributes
VTYPES = [
    ("M", "motorcycle", 0.03, 'length="2.2" maxSpeed="30" accel="3.0" decel="6.0" speedFactor="normc(1.05,0.1,0.8,1.3)"'),
    ("1", "passenger", 0.71, 'length="4.6" maxSpeed="44" accel="2.6" decel="4.5" speedFactor="normc(1.0,0.12,0.7,1.4)"'),
    ("2", "bus", 0.09, 'length="7.5" maxSpeed="30" accel="1.4" decel="4.0" speedFactor="normc(0.95,0.08,0.7,1.2)"'),
    ("3", "truck", 0.08, 'length="12" maxSpeed="25" accel="1.0" decel="4.0" speedFactor="normc(0.9,0.06,0.7,1.1)"'),
    ("4", "trailer", 0.09, 'length="18.5" maxSpeed="22.2" accel="0.8" decel="3.5" speedFactor="normc(0.9,0.05,0.7,1.05)"'),
]

# Vehicles per hour at scale 1.0, per direction. A1 north of Gaborone carries
# several thousand vehicles a day; these are a busy-hour demo, not survey data.
THROUGH_VPH = 250
LOCAL_VPH = 420  # split across intermediate stops; enough to queue at the Mmamashia plaza at the peaks
REGIONAL_VPH = 90


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=2.0)
    ap.add_argument("--scale", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    random.seed(args.seed)

    c = json.loads(CORRIDOR.read_text(encoding="utf-8"))
    end = int(args.hours * 3600)
    flows = [(fid, frm, to, vph / 3600) for fid, frm, to, vph in corridor_flows(c, args.scale)]

    lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<routes>", *vtype_lines()]
    for fid, frm, to, p in sorted(flows):
        lines.append(
            f'  <flow id="{fid}" type="mix" begin="0" end="{end}" probability="{p:.5f}" '
            f'from="{frm}" to="{to}" departLane="best" departSpeed="max"/>'
        )
    lines.append("</routes>")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    vph = sum(p for *_, p in flows) * 3600
    dist = " ".join(f"{vid}:{share}" for vid, _, share, _ in VTYPES)
    print(f"wrote {OUT.name}: {len(flows)} flows, ~{vph:.0f} vehicles/hour, {args.hours} h ({dist})")


def vtype_lines() -> list[str]:
    lines = [f'  <vType id="{vid}" vClass="{vclass}" {attrs}/>' for vid, vclass, _, attrs in VTYPES]
    lines.append(
        f'  <vTypeDistribution id="mix" vTypes="{" ".join(v[0] for v in VTYPES)}" '
        f'probabilities="{" ".join(str(v[2]) for v in VTYPES)}"/>'
    )
    return lines


def corridor_flows(c: dict, scale: float = 1.0) -> list[tuple[str, str, str, float]]:
    """(id, from edge, to edge, vehicles per hour) for the busy-hour demand."""
    nb, sb = c["northbound"], c["southbound"]
    flows: list[tuple[str, str, str, float]] = []

    def add(fid: str, frm: str, to: str, vph: float) -> None:
        if vph > 0:
            flows.append((fid, frm, to, vph * scale))

    add("through_N", nb["edges"][0], nb["edges"][-1], THROUGH_VPH)
    add("through_S", sb["edges"][0], sb["edges"][-1], THROUGH_VPH)

    # Local demand falls off with distance from Gaborone.
    stops_n = nb["stops"]
    weights = [1 / (1 + s["km"] / 30) for s in stops_n]
    total = sum(weights)
    for s, w in zip(stops_n, weights):
        add(f"local_N_{int(s['km'])}", nb["edges"][0], s["edge"], LOCAL_VPH * w / total)
        add(f"regional_N_{int(s['km'])}", s["edge"], nb["edges"][-1], REGIONAL_VPH / len(stops_n))
    stops_s = sb["stops"]
    weights = [1 / (1 + (sb["km"] - s["km"]) / 30) for s in stops_s]
    total = sum(weights)
    for s, w in zip(stops_s, weights):
        add(f"local_S_{int(s['km'])}", s["edge"], sb["edges"][-1], LOCAL_VPH * w / total)
        add(f"regional_S_{int(s['km'])}", sb["edges"][0], s["edge"], REGIONAL_VPH / len(stops_s))
    return flows


# Share of the busy-hour demand at each hour of the day, Botswana time. Morning
# and evening peaks around Gaborone, a quiet night with some freight moving.
DAY_PROFILE = [0.08, 0.05, 0.04, 0.05, 0.10, 0.35, 0.80, 1.00, 0.85, 0.65, 0.60, 0.60,
               0.65, 0.65, 0.65, 0.75, 0.90, 1.00, 0.80, 0.55, 0.40, 0.30, 0.20, 0.12]


def day_factor(hour: float) -> float:
    """DAY_PROFILE interpolated, for a fractional hour 0..24."""
    h = hour % 24
    i = int(h)
    f = h - i
    return DAY_PROFILE[i] * (1 - f) + DAY_PROFILE[(i + 1) % 24] * f


if __name__ == "__main__":
    main()
