"""Write live/road.json: the A1 corridor geometry for the 3D live view.

Everything is in SUMO network metres (the same x, y the bridge streams vehicle
positions in), so the viewer needs no projection:
  lanes     every lane of both through-routes, simplified to ~1 m, with its width
  gantries  one portal per gantry and direction, spanning that carriageway
  places    labels for the towns along the way
  bounds    the extent of the network

Run from sim/ after build_network.py:  .venv/Scripts/python export_3d.py
"""

from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

import sumolib

HERE = Path(__file__).resolve().parent
NET = HERE / "net" / "a1.net.xml"
CORRIDOR = HERE / "net" / "corridor.json"
ADD = HERE / "net" / "gantries.add.xml"
OUT = HERE.parent / "live" / "road.json"

# Towns near the corridor (lat, lon). Labels only; the viewer puts them beside the road.
PLACES = [
    ("Gaborone", -24.628, 25.923),
    ("Mmamashia", -24.517, 25.995),
    ("Pilane", -24.457, 26.130),
    ("Artesia", -24.033, 26.313),
    ("Dibete", -23.757, 26.437),
    ("Mahalapye", -23.104, 26.814),
]


def simplify(points: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Douglas-Peucker, iterative."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy) or 1e-9
        worst, idx = 0.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > worst:
                worst, idx = d, i
        if worst > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def main() -> None:
    net = sumolib.net.readNet(str(NET))
    corridor = json.loads(CORRIDOR.read_text(encoding="utf-8"))
    edges: list[str] = []
    for route in ("northbound", "southbound"):
        for e in corridor[route]["edges"]:
            if e not in edges:
                edges.append(e)

    lanes = []
    for eid in edges:
        edge = net.getEdge(eid)
        n = len(edge.getLanes())
        for lane in edge.getLanes():
            pts = simplify([(x, y) for x, y in lane.getShape()], 0.3)
            lanes.append({
                "id": lane.getID(),
                "w": round(lane.getWidth(), 2),
                "idx": lane.getIndex(),
                "n": n,
                "pts": [[round(x, 1), round(y, 1)] for x, y in pts],
            })

    # Junction areas between consecutive edges, so the asphalt has no gaps.
    junctions = []
    seen = set()
    for eid in edges:
        for node in (net.getEdge(eid).getFromNode(), net.getEdge(eid).getToNode()):
            if node.getID() in seen:
                continue
            seen.add(node.getID())
            shape = node.getShape()
            if len(shape) >= 3:
                junctions.append([[round(x, 1), round(y, 1)] for x, y in shape])

    # One portal per gantry and direction, across all of that edge's lanes.
    loops = {el.get("id"): (el.get("lane"), float(el.get("pos"))) for el in ET.parse(ADD).getroot()}
    gantries = []
    for g in corridor["gantries"]:
        by_dir: dict[str, list[str]] = {}
        for lp in g["loops"]:
            by_dir.setdefault(lp["direction"], []).append(lp["id"])
        for direction, ids in by_dir.items():
            lane_id, pos = loops[ids[0]]
            lane = net.getLane(lane_id)
            edge = lane.getEdge()
            x, y = sumolib.geomhelper.positionAtShapeOffset(lane.getShape(), pos)
            ang = sumolib.geomhelper.rotationAtShapeOffset(lane.getShape(), pos)  # radians, math convention
            # Span from the outer edge of lane 0 to the outer edge of the last lane.
            offsets = []
            for l in edge.getLanes():
                lx, ly = sumolib.geomhelper.positionAtShapeOffset(l.getShape(), min(pos, l.getLength()))
                offsets.append((lx, ly, l.getWidth()))
            cx = sum(o[0] for o in offsets) / len(offsets)
            cy = sum(o[1] for o in offsets) / len(offsets)
            span = sum(o[2] for o in offsets) + 3.0
            gantries.append({
                "id": g["id"], "name": g["name"], "km": g["km"], "dir": direction,
                "x": round(cx, 1), "y": round(cy, 1), "heading": round(ang, 4), "span": round(span, 1),
                "lanes": len(offsets),
            })
            del x, y

    # Where the road is a single carriageway the two directions' loops sit on the
    # same tarmac: one portal across both, or a post would stand in a lane.
    merged = []
    for g in gantries:
        twin = next((m for m in merged if m["id"] == g["id"] and math.hypot(m["x"] - g["x"], m["y"] - g["y"]) < 250), None)
        if not twin:
            merged.append(g)
            continue
        if twin["lanes"] + g["lanes"] > 2:
            merged.append(g)  # a real dual carriageway: keep both portals
            continue
        # Project this direction's lane centre onto the line through the twin, across the road.
        hx, hy = math.cos(twin["heading"]), math.sin(twin["heading"])
        along = (g["x"] - twin["x"]) * hx + (g["y"] - twin["y"]) * hy
        gx, gy = g["x"] - along * hx, g["y"] - along * hy
        twin.update(x=round((twin["x"] + gx) / 2, 1), y=round((twin["y"] + gy) / 2, 1),
                    span=round(twin["span"] + g["span"] - 3.0, 1), lanes=twin["lanes"] + g["lanes"], dir="NS")
    gantries = merged

    places = []
    for name, lat, lon in PLACES:
        x, y = net.convertLonLat2XY(lon, lat)
        places.append({"name": name, "x": round(x, 1), "y": round(y, 1)})

    xmin, ymin, xmax, ymax = net.getBoundary()
    data = {
        "source": "OpenStreetMap contributors (ODbL), via SUMO netconvert",
        "bounds": [round(xmin, 1), round(ymin, 1), round(xmax, 1), round(ymax, 1)],
        "lanes": lanes,
        "junctions": junctions,
        "gantries": gantries,
        "places": places,
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    npts = sum(len(l["pts"]) for l in lanes)
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB): {len(lanes)} lanes, {npts} points, "
          f"{len(junctions)} junctions, {len(gantries)} portals")


if __name__ == "__main__":
    main()
