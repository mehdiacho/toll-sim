"""Build the SUMO network for the A1 between Gaborone and Mahalapye.

1. Cut the A1 (every highway way with ref A1 inside the corridor bbox) out of
   the Geofabrik Botswana extract into a small .osm file.
2. Run netconvert on it, left-hand traffic, keeping only the largest connected
   component so we end up with one continuous corridor.
3. Find the northbound and southbound through-routes and place the three
   mainline toll plazas on them, near Mmamashia, Artesia and Dibete.
4. Rebuild the network with each plaza cut in (see add_plazas): the speed limit
   steps down on the approach, the carriageway widens to five lanes per
   direction for 200 m before the booths and 200 m after, then tapers back.
5. Write:
     net/a1.net.xml        the SUMO network, plazas included
     net/gantries.add.xml  induction loops just past each boom, one per plaza lane
     net/corridor.json     routes, plaza edges and lanes, and a lon/lat polyline,
                           used by the demand generator, the bridge and the dashboard

Run from the sim/ folder:  .venv/Scripts/python build_network.py
(--no-extract reuses net/a1.osm instead of cutting it from the .pbf again.)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import sumolib
from sumolib.geomhelper import polyLength, positionAtShapeOffset

HERE = Path(__file__).resolve().parent
PBF = HERE / "data" / "osm" / "botswana-latest.osm.pbf"
NET_DIR = HERE / "net"
OSM_OUT = NET_DIR / "a1.osm"
NET_OUT = NET_DIR / "a1.net.xml"
ADD_OUT = NET_DIR / "gantries.add.xml"
CORRIDOR_OUT = NET_DIR / "corridor.json"
# Small copy for the back office's dashboard map (committed, unlike net/).
DASHBOARD_OUT = HERE.parent / "dashboard" / "corridor.json"

# Gaborone (south) to Mahalapye (north).
MIN_LAT, MAX_LAT = -24.60, -23.03
MIN_LON, MAX_LON = 25.80, 26.95
HIGHWAYS = {"trunk", "trunk_link", "primary", "primary_link"}

# Must match db/seed.sql. Each plaza goes at the point of the northbound route
# closest to a target near the named place (moved along the road if the cut-in
# would not fit on one edge); km is then measured along the route to the booms.
GANTRIES = [
    ("A1-G01", "Mmamashia", -24.52, 26.00),
    ("A1-G02", "Artesia", -24.03, 26.30),
    ("A1-G03", "Dibete", -23.76, 26.43),
]


def inside(lat: float, lon: float) -> bool:
    return MIN_LAT <= lat <= MAX_LAT and MIN_LON <= lon <= MAX_LON


def is_a1(tags) -> bool:
    ref = tags.get("ref") or ""
    return tags.get("highway") in HIGHWAYS and "A1" in [r.strip() for r in ref.split(";")]


def extract_osm() -> None:
    import osmium

    class Ways(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.way_ids: set[int] = set()
            self.node_ids: set[int] = set()

        def way(self, w):
            if not is_a1(w.tags):
                return
            nodes = [n for n in w.nodes if n.location.valid()]
            if nodes and any(inside(n.location.lat, n.location.lon) for n in nodes):
                self.way_ids.add(w.id)
                self.node_ids.update(n.ref for n in w.nodes)

    ways = Ways()
    ways.apply_file(str(PBF), locations=True)
    print(f"A1 ways in corridor: {len(ways.way_ids)}, nodes: {len(ways.node_ids)}")

    OSM_OUT.unlink(missing_ok=True)
    writer = osmium.SimpleWriter(str(OSM_OUT))

    class Copy(osmium.SimpleHandler):
        def node(self, n):
            if n.id in ways.node_ids:
                writer.add_node(n)

        def way(self, w):
            if w.id in ways.way_ids:
                writer.add_way(w)

    Copy().apply_file(str(PBF))
    writer.close()


def run_netconvert() -> None:
    netconvert = sumolib.checkBinary("netconvert")
    cmd = [
        netconvert,
        "--osm-files", str(OSM_OUT),
        "--output-file", str(NET_OUT),
        "--lefthand", "true",  # Botswana drives on the left
        "--geometry.remove",
        "--ramps.guess",
        "--junctions.join",
        "--roundabouts.guess",
        "--tls.guess-signals", "--tls.discard-simple", "--tls.join",
        "--osm.speedlimit-none", "33.33",  # 120 km/h national limit where untagged
        "--remove-edges.isolated",
        "--keep-edges.components", "1",
        "--no-turnarounds",
        "--output.original-names",
        "--no-warnings",
    ]
    subprocess.run(cmd, check=True)


def longest_route(net: sumolib.net.Net, northbound: bool) -> list:
    """Shortest path from the southernmost to the northernmost edge (or back)."""
    edges = [e for e in net.getEdges() if e.allows("passenger")]

    def lat(e, end: bool):
        x, y = e.getToNode().getCoord() if end else e.getFromNode().getCoord()
        return net.convertXY2LonLat(x, y)[1]

    # Edges at the extremes that leave from / arrive at the corridor's ends.
    south_starts = sorted(edges, key=lambda e: lat(e, False))
    north_ends = sorted(edges, key=lambda e: -lat(e, True))
    north_starts = sorted(edges, key=lambda e: -lat(e, False))
    south_ends = sorted(edges, key=lambda e: lat(e, True))
    starts, ends = (south_starts, north_ends) if northbound else (north_starts, south_ends)
    for s in starts[:15]:
        for t in ends[:15]:
            path, _ = net.getShortestPath(s, t, vClass="passenger")
            if path and len(path) > 10:
                return list(path)
    raise SystemExit(f"no {'northbound' if northbound else 'southbound'} route found")


def locate(route: list, km: float):
    """Edge and position on it at km along the route."""
    remaining = km * 1000
    for e in route:
        if remaining <= e.getLength():
            return e, remaining
        remaining -= e.getLength()
    raise SystemExit(f"route is shorter than {km} km")


def nearest_km(net, route: list, lat: float, lon: float) -> float:
    """km along route of the shape point closest to (lat, lon), rounded to 0.1."""
    tx, ty = net.convertLonLat2XY(lon, lat)
    best, best_km, acc = None, 0.0, 0.0
    for e in route:
        shape = e.getShape()
        for i in range(1, len(shape)):
            (x1, y1), (x2, y2) = shape[i - 1], shape[i]
            seg = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
            for k in range(0, 11):
                f = k / 10
                d = (x1 + f * (x2 - x1) - tx) ** 2 + (y1 + f * (y2 - y1) - ty) ** 2
                if best is None or d < best:
                    best, best_km = d, (acc + f * seg) / 1000
            acc += seg
    return round(best_km, 1)


# --------------------------------------------------------------- toll plazas
#
# South African-style mainline plazas (Bakwena's N4 Swartruggens, the N1
# Pumulani plaza): the road widens to a bank of booths, each lane behind a boom.
# Lane types per direction, left to right (traffic keeps left; in a left-hand
# SUMO network lane 0 is the kerb lane):
PLAZA_LANES = ["heavy", "heavy", "mixed", "mixed", "etag"]
LANE_WIDTH = {"heavy": 4.0, "mixed": 3.5, "etag": 3.5}
# Zones along the direction of travel, in metres from the booth line. lanes None
# keeps the road's own lane count. The zones are symmetric about the booths, so
# on a single carriageway both directions cut the road at the same points and
# their plaza lanes sit side by side.
PLAZA_ZONES = [
    ("a80", -1400, -700, None, 80 / 3.6),
    ("a60", -700, -200, None, 60 / 3.6),
    ("in", -200, 0, len(PLAZA_LANES), 40 / 3.6),  # booths and booms at the end of "in"
    ("out", 0, 200, len(PLAZA_LANES), 60 / 3.6),
    ("x80", 200, 700, None, 80 / 3.6),
]
# Room kept clear of an edge's ends, plus a margin so no zone starts on a junction.
BEFORE, AFTER = -PLAZA_ZONES[0][1] + 20, PLAZA_ZONES[-1][2] + 20


def plaza_edge(pid: str, direction: str, zone: str) -> str:
    return f"pl_{pid}_{direction}_{zone}"


def twin_of(net, edge):
    """The opposite direction of a single-carriageway edge (same nodes, reversed)."""
    cand = edge.getID()[1:] if edge.getID().startswith("-") else "-" + edge.getID()
    if net.hasEdge(cand):
        t = net.getEdge(cand)
        if t.getFromNode() == edge.getToNode() and t.getToNode() == edge.getFromNode():
            return t
    return None


def project(route: list, x: float, y: float):
    """Edge and position on it of the route point closest to (x, y)."""
    best = None
    for e in route:
        shape = e.getShape()
        acc = 0.0
        for i in range(1, len(shape)):
            (x1, y1), (x2, y2) = shape[i - 1], shape[i]
            seg = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5 or 1e-9
            f = max(0.0, min(1.0, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / seg ** 2))
            d = (x1 + f * (x2 - x1) - x) ** 2 + (y1 + f * (y2 - y1) - y) ** 2
            if best is None or d < best[0]:
                best = (d, e, (acc + f * seg) * e.getLength() / max(polyLength(shape), 1e-9))
            acc += seg
    return best[1], best[2]


def place_plazas(net, nb: list, sb: list) -> list[dict]:
    """Booth line of each plaza on the base network: {id, name, N: (edge, pos), S: (edge, pos)}.
    A plaza is cut into one edge per direction, so the booths are moved along the
    edge until the whole approach and exit fit on it."""
    sites = []
    for pid, name, tlat, tlon in GANTRIES:
        km = nearest_km(net, nb, tlat, tlon)
        e_nb, pos_nb = locate(nb, km)
        twin = twin_of(net, e_nb)
        length = e_nb.getLength()
        hi = length - (BEFORE if twin else AFTER)
        if hi < BEFORE:
            raise SystemExit(f"{pid}: edge {e_nb.getID()} is too short ({length:.0f} m) for a plaza")
        pos_nb = min(max(pos_nb, BEFORE), hi)
        if twin:
            e_sb, pos_sb = twin, twin.getLength() - pos_nb * twin.getLength() / length
        else:
            x, y = positionAtShapeOffset(e_nb.getShape(), pos_nb)
            e_sb, pos_sb = project(sb, x, y)
            if e_sb.getLength() < BEFORE + AFTER:
                raise SystemExit(f"{pid}: edge {e_sb.getID()} is too short for a plaza")
            pos_sb = min(max(pos_sb, BEFORE), e_sb.getLength() - AFTER)
        sites.append({"id": pid, "name": name, "N": (e_nb.getID(), pos_nb), "S": (e_sb.getID(), pos_sb)})
        print(f"{pid} {name}: booths on {e_nb.getID()} @ {pos_nb:.0f} m and {e_sb.getID()} @ {pos_sb:.0f} m"
              f"{' (single carriageway)' if twin else ''}")
    return sites


def cut_shape(shape: list, a: float, b: float) -> list:
    """The part of a polyline between offsets a and b (metres along it)."""
    out = [positionAtShapeOffset(shape, a)]
    acc = 0.0
    for i in range(1, len(shape)):
        (x1, y1), (x2, y2) = shape[i - 1], shape[i]
        acc += ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
        if a < acc < b:
            out.append((x2, y2))
    out.append(positionAtShapeOffset(shape, b))
    return out


def fmt_shape(shape: list) -> str:
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in shape)


def add_plazas(sites: list[dict]) -> None:
    """Rewrite NET_OUT with every plaza cut in.

    The network goes out to netconvert's plain XML, each plaza edge is split
    into its zones (new nodes at the cut points, shared by both directions of a
    single carriageway), the plaza zones get five lanes, their own widths and
    the stepped speed limits, and the lane connections into and out of the wide
    section are written explicitly so every booth lane can be reached and every
    lane merges back. netconvert then rebuilds the network from the patched
    files, so a rebuild always reproduces the same plazas."""
    netconvert = sumolib.checkBinary("netconvert")
    with tempfile.TemporaryDirectory() as tmp:
        prefix = str(Path(tmp) / "plain")
        subprocess.run([netconvert, "-s", str(NET_OUT), "--plain-output-prefix", prefix, "--no-warnings"],
                       check=True, stdout=subprocess.DEVNULL)
        nod, edg, con, tll = (ET.parse(f"{prefix}.{k}.xml") for k in ("nod", "edg", "con", "tll"))
        nodes = {n.get("id"): (float(n.get("x")), float(n.get("y"))) for n in nod.getroot().iter("node")}
        edges = {e.get("id"): e for e in edg.getroot().iter("edge")}

        def shape_of(el):
            if el.get("shape"):
                return [tuple(map(float, pt.split(","))) for pt in el.get("shape").split()]
            return [nodes[el.get("from")], nodes[el.get("to")]]

        # Booths per edge: {edge id: [(plaza id, direction, booth offset along the edge)]}
        booths: dict[str, list] = {}
        for site in sites:
            for d in ("N", "S"):
                eid, pos = site[d]
                booths.setdefault(eid, []).append((site["id"], d, pos))

        renamed_from: dict[str, str] = {}  # split edge -> its last piece, for outgoing connections
        renamed_to: dict[str, str] = {}  # split edge -> its first piece, for incoming ones
        new_connections: list[dict] = []
        done: set[str] = set()
        for eid in list(booths):
            if eid in done:
                continue
            el = edges[eid]
            shape = shape_of(el)
            length = polyLength(shape)
            twin_id = eid[1:] if eid.startswith("-") else "-" + eid
            twin = edges.get(twin_id)
            if twin is not None and not (twin.get("from") == el.get("to") and twin.get("to") == el.get("from")):
                twin = None
            # Physical cut points, as offsets along this edge's shape.
            cuts = set()
            for _, _, pos in booths[eid]:
                cuts.update(pos + z[1] for z in PLAZA_ZONES)
                cuts.add(pos + PLAZA_ZONES[-1][2])
            plan = [(el, shape, booths[eid])]
            if twin is not None:
                tshape = shape_of(twin)
                tlen = polyLength(tshape)
                for _, _, pos in booths.get(twin_id, []):
                    cuts.update(length - (pos + z[1]) * length / tlen for z in PLAZA_ZONES)
                    cuts.add(length - (pos + PLAZA_ZONES[-1][2]) * length / tlen)
                plan.append((twin, tshape, booths.get(twin_id, [])))
                done.add(twin_id)
            done.add(eid)
            # The two directions' cut points coincide up to rounding; keep one of each.
            merged: list[float] = []
            for c in sorted(c for c in cuts if 1.0 < c < length - 1.0):
                if not merged or c - merged[-1] > 5.0:
                    merged.append(c)
            cuts = merged
            tag = booths[eid][0][0]
            cut_nodes = []
            for k, c in enumerate(cuts):
                nid = f"pl_{tag}_{booths[eid][0][1]}_n{k}"
                x, y = positionAtShapeOffset(shape, c)
                node = ET.SubElement(nod.getroot(), "node", id=nid, x=f"{x:.2f}", y=f"{y:.2f}", type="priority")
                node.tail = "\n    "
                cut_nodes.append(nid)

            for orig, oshape, obooths in plan:
                forward = orig is el
                olen = polyLength(oshape)
                scale = olen / length
                # Cut offsets along this edge's own shape, in its direction of travel.
                own = [c * scale for c in cuts] if forward else [olen - c * scale for c in reversed(cuts)]
                own_nodes = cut_nodes if forward else list(reversed(cut_nodes))
                bounds = [0.0, *own, olen]
                ends = [orig.get("from"), *own_nodes, orig.get("to")]
                parent = edg.getroot()
                index = list(parent).index(orig)
                parent.remove(orig)
                lanes0 = int(orig.get("numLanes", "1"))
                pieces = []
                used: dict[str, int] = {}
                for k in range(len(bounds) - 1):
                    a, b = bounds[k], bounds[k + 1]
                    mid = (a + b) / 2
                    zone = None
                    for pid, d, pos in obooths:
                        for zname, z0, z1, zl, zs in PLAZA_ZONES:
                            if pos + z0 <= mid < pos + z1:
                                zone = (pid, d, zname, zl, zs)
                    if zone:
                        base = plaza_edge(zone[0], zone[1], zone[2])
                        n = used.get(base, 0)
                        used[base] = n + 1
                        piece_id = base if n == 0 else f"{base}.{n}"
                    else:
                        piece_id = orig.get("id") if k == 0 else f"{orig.get('id')}.{k}"
                    piece = ET.Element("edge", {key: v for key, v in orig.attrib.items() if key not in ("id", "from", "to", "shape")})
                    piece.set("id", piece_id)
                    piece.set("from", ends[k])
                    piece.set("to", ends[k + 1])
                    piece.set("shape", fmt_shape(cut_shape(oshape, a, b)))
                    nl = zone[3] if zone and zone[3] else lanes0
                    if zone:
                        piece.set("speed", f"{zone[4]:.2f}")
                    piece.set("numLanes", str(nl))
                    if zone and zone[3]:
                        for li, kind in enumerate(PLAZA_LANES):
                            ET.SubElement(piece, "lane", index=str(li), width=f"{LANE_WIDTH[kind]:.2f}")
                    piece.tail = "\n    "
                    parent.insert(index + k, piece)
                    pieces.append((piece_id, nl, zone[2] if zone else None))
                renamed_from[orig.get("id")] = pieces[-1][0]
                renamed_to[orig.get("id")] = pieces[0][0]
                # Into the wide section every booth lane must be reachable, and out
                # of it every booth lane must have somewhere to go.
                for (p1, n1, z1), (p2, n2, z2) in zip(pieces, pieces[1:]):
                    if n2 > n1:
                        pairs = [(min(n1 - 1, li * n1 // n2), li) for li in range(n2)]
                    elif n1 > n2:
                        pairs = [(li, min(n2 - 1, li * n2 // n1)) for li in range(n1)]
                    else:
                        pairs = [(li, li) for li in range(n1)]
                    for fl, tl in pairs:
                        new_connections.append({"from": p1, "to": p2, "fromLane": str(fl), "toLane": str(tl)})

        # Connections that left an edge we split now leave from its last piece,
        # and those that entered it enter its first.
        for root in (con.getroot(), tll.getroot()):
            for c in root.iter("connection"):
                if c.get("from") in renamed_from:
                    c.set("from", renamed_from[c.get("from")])
                if c.get("to") in renamed_to:
                    c.set("to", renamed_to[c.get("to")])
        for c in new_connections:
            el = ET.SubElement(con.getroot(), "connection", c)
            el.tail = "\n    "
        for tree, k in ((nod, "nod"), (edg, "edg"), (con, "con"), (tll, "tll")):
            tree.write(f"{prefix}.{k}.xml", encoding="utf-8", xml_declaration=True)
        subprocess.run([
            netconvert,
            "--node-files", f"{prefix}.nod.xml", "--edge-files", f"{prefix}.edg.xml",
            "--connection-files", f"{prefix}.con.xml", "--tllogic-files", f"{prefix}.tll.xml",
            "--type-files", f"{prefix}.typ.xml",
            "--output-file", str(NET_OUT),
            "--lefthand", "true", "--no-turnarounds", "--output.original-names", "--no-warnings",
        ], check=True)


def routes(net) -> tuple[list, list, float, float]:
    nb = longest_route(net, northbound=True)
    sb = longest_route(net, northbound=False)
    return nb, sb, sum(e.getLength() for e in nb) / 1000, sum(e.getLength() for e in sb) / 1000


def km_to(route: list, edge_id: str, pos: float) -> float:
    acc = 0.0
    for e in route:
        if e.getID() == edge_id:
            return (acc + pos) / 1000
        acc += e.getLength()
    raise SystemExit(f"{edge_id} is not on the route")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-extract", action="store_true", help="reuse net/a1.osm instead of reading the .pbf")
    args = ap.parse_args()
    NET_DIR.mkdir(exist_ok=True)
    if not args.no_extract:
        if not PBF.exists():
            sys.exit(f"missing {PBF}; download botswana-latest.osm.pbf from download.geofabrik.de")
        extract_osm()
    run_netconvert()

    base = sumolib.net.readNet(str(NET_OUT))
    nb, sb, _, _ = routes(base)
    sites = place_plazas(base, nb, sb)
    add_plazas(sites)

    net = sumolib.net.readNet(str(NET_OUT))
    nb, sb, nb_km, sb_km = routes(net)
    print(f"northbound route {nb_km:.1f} km over {len(nb)} edges, southbound {sb_km:.1f} km over {len(sb)} edges")

    gantries = []
    loops = []
    for site in sites:
        gid, name = site["id"], site["name"]
        in_n = net.getEdge(plaza_edge(gid, "N", "in"))
        km = round(km_to(nb, in_n.getID(), in_n.getLength()), 1)
        x, y = in_n.getToNode().getCoord()
        lon, lat = net.convertXY2LonLat(x, y)
        g = {"id": gid, "name": name, "km": km, "lat": round(lat, 6), "lon": round(lon, 6), "loops": [],
             "plaza": {"lane_types": PLAZA_LANES, "dirs": {}}}
        for direction in ("N", "S"):
            zones = {z[0]: plaza_edge(gid, direction, z[0]) for z in PLAZA_ZONES}
            for zid in zones.values():
                if not net.hasEdge(zid):
                    raise SystemExit(f"plaza edge {zid} missing from the rebuilt network")
            booth = net.getEdge(zones["in"])
            out = net.getEdge(zones["out"])
            g["plaza"]["dirs"][direction] = {
                "approach": [zones["a80"], zones["a60"]],
                "booth_edge": zones["in"],
                "booth_pos": round(booth.getLength(), 2),
                "exit_edge": zones["out"],
                "after": zones["x80"],
                "lanes": [ln.getID() for ln in booth.getLanes()],
            }
            # A loop on every lane just past the booms.
            for lane in out.getLanes():
                loop_id = f"{gid}_{direction}_{lane.getIndex()}"
                loops.append((loop_id, lane.getID(), min(2.0, lane.getLength() - 0.5)))
                g["loops"].append({"id": loop_id, "direction": direction, "lane": lane.getID()})
        gantries.append(g)

    with ADD_OUT.open("w", encoding="utf-8", newline="\n") as f:
        f.write("<additional>\n")
        for loop_id, lane_id, pos in loops:
            f.write(f'  <inductionLoop id="{loop_id}" lane="{lane_id}" pos="{pos:.2f}" period="3600" file="NUL"/>\n')
        f.write("</additional>\n")

    def polyline(route):
        pts = []
        for e in route:
            for x, y in e.getShape():
                lon, lat = net.convertXY2LonLat(x, y)
                pt = [round(lon, 5), round(lat, 5)]
                if not pts or pts[-1] != pt:
                    pts.append(pt)
        return pts

    # Intermediate edges where local traffic joins or leaves: roughly every 20 km,
    # never inside a plaza (every vehicle that reaches a plaza must pass its booths).
    def stops(route):
        out, acc, next_km = [], 0.0, 20.0
        total = sum(x.getLength() for x in route) / 1000
        for e in route:
            acc += e.getLength() / 1000
            if acc >= next_km and acc < total - 10 and not e.getID().startswith("pl_"):
                out.append({"edge": e.getID(), "km": round(acc, 1)})
                next_km += 20
        return out

    corridor = {
        "northbound": {"edges": [e.getID() for e in nb], "km": round(nb_km, 2), "stops": stops(nb)},
        "southbound": {"edges": [e.getID() for e in sb], "km": round(sb_km, 2), "stops": stops(sb)},
        "gantries": gantries,
        "polyline": polyline(nb),
    }
    CORRIDOR_OUT.write_text(json.dumps(corridor, indent=1), encoding="utf-8", newline="\n")

    # Thin the polyline to roughly one point per 500 m for the dashboard.
    thin, last = [], None
    for lon, lat in corridor["polyline"]:
        if last is None or ((lon - last[0]) ** 2 + (lat - last[1]) ** 2) ** 0.5 > 0.0045:
            thin.append([lon, lat])
            last = (lon, lat)
    thin.append(corridor["polyline"][-1])
    DASHBOARD_OUT.parent.mkdir(exist_ok=True)
    DASHBOARD_OUT.write_text(
        json.dumps(
            {
                "polyline": thin,
                "gantries": [{k: g[k] for k in ("id", "name", "km", "lat", "lon")} for g in gantries],
                "km": corridor["northbound"]["km"],
            }
        ),
        encoding="utf-8",
    )
    for g in gantries:
        print(f"{g['id']} {g['name']:<10} km {g['km']:>5}  {g['lat']}, {g['lon']}  loops: {len(g['loops'])}")


if __name__ == "__main__":
    main()
