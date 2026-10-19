"""Build the SUMO network for the A1 between Gaborone and Mahalapye.

1. Cut the A1 (every highway way with ref A1 inside the corridor bbox) out of
   the Geofabrik Botswana extract into a small .osm file.
2. Run netconvert on it, left-hand traffic, keeping only the largest connected
   component so we end up with one continuous corridor.
3. Find the northbound and southbound through-routes, place the three virtual
   gantries on them at fixed km from the Gaborone end, and write:
     net/a1.net.xml        the SUMO network
     net/gantries.add.xml  induction loops, one per gantry, direction and lane
     net/corridor.json     routes, gantry edges and a lon/lat polyline, used by
                           the demand generator, the bridge and the dashboard

Run from the sim/ folder:  .venv/Scripts/python build_network.py
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import osmium
import sumolib

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

# Must match db/seed.sql. Each gantry goes at the point of the northbound route
# closest to a target near the named place; km is then measured along the route.
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


def main() -> None:
    if not PBF.exists():
        sys.exit(f"missing {PBF}; download botswana-latest.osm.pbf from download.geofabrik.de")
    NET_DIR.mkdir(exist_ok=True)
    extract_osm()
    run_netconvert()

    net = sumolib.net.readNet(str(NET_OUT))
    nb = longest_route(net, northbound=True)
    sb = longest_route(net, northbound=False)
    nb_km = sum(e.getLength() for e in nb) / 1000
    sb_km = sum(e.getLength() for e in sb) / 1000
    print(f"northbound route {nb_km:.1f} km over {len(nb)} edges, southbound {sb_km:.1f} km over {len(sb)} edges")

    gantries = []
    loops = []
    for gid, name, tlat, tlon in GANTRIES:
        km = nearest_km(net, nb, tlat, tlon)
        e_nb, pos_nb = locate(nb, km)
        # Same physical point on the southbound carriageway: measured from the north end.
        e_sb, pos_sb = locate(sb, sb_km - km)
        x, y = e_nb.getShape()[0] if pos_nb == 0 else sumolib.geomhelper.positionAtShapeOffset(e_nb.getShape(), pos_nb)
        lon, lat = net.convertXY2LonLat(x, y)
        g = {"id": gid, "name": name, "km": km, "lat": round(lat, 6), "lon": round(lon, 6), "loops": []}
        for direction, edge, pos in (("N", e_nb, pos_nb), ("S", e_sb, pos_sb)):
            pos = min(max(pos, 1.0), edge.getLength() - 1.0)
            for lane in edge.getLanes():
                if not lane.allows("passenger"):
                    continue
                loop_id = f"{gid}_{direction}_{lane.getIndex()}"
                loops.append((loop_id, lane.getID(), pos))
                g["loops"].append({"id": loop_id, "direction": direction, "lane": lane.getID()})
        gantries.append(g)

    with ADD_OUT.open("w", encoding="utf-8") as f:
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

    # Intermediate edges where local traffic joins or leaves: roughly every 20 km.
    def stops(route):
        out, acc, next_km = [], 0.0, 20.0
        for e in route:
            acc += e.getLength() / 1000
            if acc >= next_km and acc < (sum(x.getLength() for x in route) / 1000) - 10:
                out.append({"edge": e.getID(), "km": round(acc, 1)})
                next_km += 20
        return out

    corridor = {
        "northbound": {"edges": [e.getID() for e in nb], "km": round(nb_km, 2), "stops": stops(nb)},
        "southbound": {"edges": [e.getID() for e in sb], "km": round(sb_km, 2), "stops": stops(sb)},
        "gantries": gantries,
        "polyline": polyline(nb),
    }
    CORRIDOR_OUT.write_text(json.dumps(corridor, indent=1), encoding="utf-8")

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
