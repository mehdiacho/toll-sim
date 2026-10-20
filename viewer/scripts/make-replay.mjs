// Generates viewer/public/replay.json: a few minutes of synthetic A1 traffic in
// the same shape as the live feed, for visitors to watch while the live
// simulation is not running.
//
// Vehicles drive the lane polylines of live/road.json in both directions with
// a simple car-following and overtaking model; gantry reads are emitted when a
// vehicle crosses a gantry. Usage: node scripts/make-replay.mjs [minutes]
//
// Output format (decoded by src/replay.js):
//   { v, kind, dt, clock0, gantries, frames: [{ t, s, g, e, st, p }] }
//   s  = spawn  [[id, plate, class, flags]]
//   g  = gone   [id]
//   e  = gantry events (same objects as the live feed)
//   st = cumulative stats
//   p  = flat ints, vehicles sorted by id: [idDelta, x, y] where x/y are in
//        decimetres, absolute for a vehicle new to this frame, otherwise the
//        delta from its previous frame. Heading and speed are derived from the
//        motion on decode.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const road = JSON.parse(readFileSync(resolve(here, "../../live/road.json"), "utf8"));
const OUT = resolve(here, "../public/replay.json");

const MINUTES = Number(process.argv[2] ?? 5);
const DT = 0.5; // integration step, s
const FRAME = 2; // frame interval, s
const WARMUP = 90; // s simulated before recording starts
const DURATION = MINUTES * 60;

// ---------------------------------------------------------------- random
let seed = 20261020;
function rnd() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + rnd() * (b - a);
function expo(rate) {
  return -Math.log(1 - rnd()) / rate;
}

// ---------------------------------------------------------------- routes
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const edges = new Map();
for (const lane of road.lanes) {
  const id = lane.id.replace(/_\d+$/, "");
  if (!edges.has(id)) edges.set(id, []);
  edges.get(id).push(lane);
}
const E = [...edges].map(([id, lanes]) => {
  const l = lanes.find((x) => x.idx === 0) ?? lanes[0];
  let len = 0;
  for (let i = 1; i < l.pts.length; i++) len += dist(l.pts[i - 1], l.pts[i]);
  return { id, pts: l.pts, n: lanes.length, w: l.w, len, s: l.pts[0], e: l.pts[l.pts.length - 1] };
});
const byId = new Map(E.map((e) => [e.id, e]));
const succ = new Map(E.map((a) => [a.id, E.filter((b) => b !== a && dist(a.e, b.s) < 60)]));

function shortest(srcId, dstId) {
  const d = new Map(E.map((e) => [e.id, Infinity]));
  const prev = new Map();
  const open = new Set(E.map((e) => e.id));
  d.set(srcId, byId.get(srcId).len);
  while (open.size) {
    let u = null;
    for (const q of open) if (u === null || d.get(q) < d.get(u)) u = q;
    open.delete(u);
    if (u === dstId || d.get(u) === Infinity) break;
    for (const v of succ.get(u)) {
      const nd = d.get(u) + v.len;
      if (nd < d.get(v.id)) {
        d.set(v.id, nd);
        prev.set(v.id, u);
      }
    }
  }
  const path = [];
  for (let c = dstId; c; c = prev.get(c)) path.unshift(c);
  if (path[0] !== srcId) throw new Error(`no route ${srcId} -> ${dstId}`);
  return path.map((id) => byId.get(id));
}

// Start/end edges: the southernmost start and the northernmost end, and vice versa.
const nearest = (pt, key) => E.reduce((b, e) => (dist(e[key], pt) < dist(b[key], pt) ? e : b));
const [xmin, ymin, xmax, ymax] = road.bounds;
const south = [xmin, ymin];
const north = [xmax, ymax];

function buildRoute(path, dir) {
  const pts = [];
  const lanes = [];
  for (const e of path) {
    for (const p of e.pts) {
      if (pts.length && dist(pts[pts.length - 1], p) < 0.5) continue;
      pts.push(p);
      lanes.push(e.n);
    }
  }
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist(pts[i - 1], pts[i]));
  return { dir, pts, lanes, s, len: s[s.length - 1] };
}
const routes = [
  buildRoute(shortest(nearest(south, "s").id, nearest(north, "e").id), "N"),
  buildRoute(shortest(nearest(north, "s").id, nearest(south, "e").id), "S"),
];
for (const r of routes) console.log(`route ${r.dir}: ${(r.len / 1000).toFixed(1)} km, ${r.pts.length} pts`);

/** Position, unit tangent and lane count at arc length s. */
function at(route, s) {
  const S = route.s;
  let lo = 0;
  let hi = S.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (S[mid] <= s) lo = mid;
    else hi = mid;
  }
  const a = route.pts[lo];
  const b = route.pts[hi];
  const seg = S[hi] - S[lo] || 1;
  const f = Math.min(1, Math.max(0, (s - S[lo]) / seg));
  const tx = (b[0] - a[0]) / seg;
  const ty = (b[1] - a[1]) / seg;
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, tx, ty, n: route.lanes[lo] };
}

/** Arc length of the point on the route nearest to (x, y), or null if far. */
function project(route, x, y) {
  let best = null;
  for (let i = 1; i < route.pts.length; i++) {
    const a = route.pts[i - 1];
    const b = route.pts[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy || 1;
    const f = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
    const px = a[0] + dx * f;
    const py = a[1] + dy * f;
    const d = Math.hypot(x - px, y - py);
    if (!best || d < best.d) best = { d, s: route.s[i - 1] + Math.sqrt(L2) * f };
  }
  return best && best.d < 40 ? best.s : null;
}

// Gantries: where each one sits along each route it covers.
const gates = [];
for (const g of road.gantries) {
  for (const r of routes) {
    if (!g.dir.includes(r.dir)) continue;
    const s = project(r, g.x, g.y);
    if (s == null) continue;
    gates.push({ id: g.id, name: g.name, dir: r.dir, route: r, s });
  }
}
console.log("gates", gates.map((g) => `${g.id}/${g.dir}@${(g.s / 1000).toFixed(1)}km`).join(" "));

// Towns slow traffic down.
const towns = road.places.filter((p) => p.name === "Gaborone" || p.name === "Mahalapye");
function speedCap(x, y) {
  for (const t of towns) if (Math.hypot(x - t.x, y - t.y) < 5000) return 60 / 3.6;
  return Infinity;
}

// ---------------------------------------------------------------- vehicles
const CLASSES = [
  // class, share, length m, desired speed km/h range
  ["1", 0.71, 4.6, [95, 125]],
  ["2", 0.09, 12, [85, 100]],
  ["3", 0.08, 10, [75, 92]],
  ["4", 0.09, 18, [70, 85]],
  ["M", 0.03, 2.2, [85, 120]],
];
const TARIFF = { M: 800, 1: 1500, 2: 3500, 3: 6000, 4: 9000 };
const LETTERS = "ABCDEFGHJKLMNPRSTUVWXYZ";
const usedPlates = new Set();
function plate() {
  for (;;) {
    const p = `B${100 + Math.floor(rnd() * 900)}${pick(LETTERS)}${pick(LETTERS)}${pick(LETTERS)}`;
    if (!usedPlates.has(p)) {
      usedPlates.add(p);
      return p;
    }
  }
}

let nextId = 1;
const vehicles = [];
const spawnQueue = [];
const goneQueue = [];
const eventQueue = [];
const stats = { charged: 0, unpaid: 0, review: 0, insufficient_funds: 0, unregistered_vehicle: 0, revenue_thebe: 0 };

function makeVehicle(route, s, inRecording) {
  let u = rnd();
  let c = CLASSES[0];
  for (const k of CLASSES) {
    if (u < k[1]) {
      c = k;
      break;
    }
    u -= k[1];
  }
  const [cls, , length, [lo, hi]] = c;
  const registered = rnd() < 0.86;
  const tagged = registered && rnd() < 0.55;
  const v = {
    id: nextId++,
    route,
    s,
    cls,
    length,
    vdes: between(lo, hi) / 3.6,
    v: 0,
    lane: 0,
    lat: 0,
    plate: plate(),
    flags: (registered ? 1 : 0) | (tagged ? 2 : 0),
    // Whether this vehicle's account has run dry (stable per vehicle).
    broke: rnd() < 0.05,
  };
  v.v = v.vdes * between(0.9, 1);
  vehicles.push(v);
  if (inRecording) spawnQueue.push(v);
  return v;
}

// Initial population: a steady flow everywhere plus commuter traffic around Gaborone.
const gab = road.places.find((p) => p.name === "Gaborone");
for (const r of routes) {
  for (let s = 50; s < r.len - 50; ) {
    const p = at(r, s);
    const km = Math.hypot(p.x - gab.x, p.y - gab.y) / 1000;
    // Busier just upstream of each gantry so that a few minutes of recording
    // carries a steady stream of reads.
    const upstream = gates.some((g) => g.route === r && g.s - s > 300 && g.s - s < 9000);
    const perKm = 0.7 + 6 * Math.exp(-km / 22) + (upstream ? 2.6 : 0);
    s += expo(perKm / 1000) + 25;
    if (s < r.len - 50) makeVehicle(r, s, false);
  }
}
console.log("initial vehicles", vehicles.length);

function arrivalRate(route) {
  // vehicles / s entering at the route start
  return route.dir === "N" ? 0.17 : 0.035;
}
const nextArrival = new Map(routes.map((r) => [r, expo(arrivalRate(r))]));

function read(v, gate, clock) {
  const registered = v.flags & 1;
  const tagged = v.flags & 2;
  const amount = TARIFF[v.cls];
  let status = "charged";
  let reason = null;
  let match = tagged ? "tag" : "plate";
  let platePrinted = v.plate;
  if (!registered) {
    status = "unpaid";
    reason = "unregistered_vehicle";
    match = "none";
  } else if (!tagged && rnd() < 0.05) {
    status = "review";
    match = "none";
    // a low-confidence read: one character off
    const i = 1 + Math.floor(rnd() * 6);
    platePrinted = v.plate.slice(0, i) + (rnd() < 0.5 ? "8" : "B") + v.plate.slice(i + 1);
  } else if (v.broke) {
    status = "unpaid";
    reason = "insufficient_funds";
  }
  stats[status]++;
  if (reason) stats[reason]++;
  if (status === "charged") stats.revenue_thebe += amount;
  eventQueue.push({
    vid: v.id,
    gantry: gate.id,
    dir: gate.dir,
    plate: platePrinted,
    status,
    amount_thebe: amount,
    reason,
    match,
  });
}

function step(t, recording) {
  // arrivals
  for (const r of routes) {
    let due = nextArrival.get(r);
    while (due <= t) {
      const blocked = vehicles.some((o) => o.route === r && o.s < 60);
      if (!blocked) makeVehicle(r, 0, recording);
      due += expo(arrivalRate(r));
    }
    nextArrival.set(r, due);
  }
  for (const r of routes) {
    const list = vehicles.filter((v) => v.route === r).sort((a, b) => a.s - b.s);
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const here = at(r, v.s);
      const twoLanes = here.n >= 2;
      if (!twoLanes) v.lane = 0;
      // leaders in each lane
      const ahead = (lane) => {
        for (let j = i + 1; j < list.length; j++) {
          const o = list[j];
          if (o.s - v.s > 300) break;
          if (!twoLanes || o.lane === lane) return o;
        }
        return null;
      };
      const behindClear = (lane, back) => {
        for (let j = i - 1; j >= 0; j--) {
          const o = list[j];
          if (v.s - o.s > back) break;
          if (o.lane === lane) return false;
        }
        return true;
      };
      const want = Math.min(v.vdes, speedCap(here.x, here.y));
      const leader = ahead(v.lane);
      const gapTo = (o) => o.s - v.s - o.length;
      const safe = (spd) => 8 + spd * 1.4;
      let target = want;
      if (leader) {
        const gap = gapTo(leader);
        if (gap < safe(v.v) * 2.2 && leader.v < want - 1) {
          // try to overtake on a dual carriageway
          if (twoLanes && v.lane === 0) {
            const l1 = ahead(1);
            if ((!l1 || gapTo(l1) > safe(v.v) * 2) && behindClear(1, 40)) v.lane = 1;
          }
        }
        const lead2 = ahead(v.lane);
        if (lead2) {
          const g = gapTo(lead2);
          if (g < safe(v.v)) target = Math.min(target, lead2.v * Math.max(0.3, g / safe(v.v)));
          else if (g < safe(v.v) * 2) target = Math.min(target, lead2.v + (g - safe(v.v)) * 0.15);
        }
      }
      if (v.lane === 1) {
        const l0 = ahead(0);
        if ((!l0 || gapTo(l0) > safe(v.v) * 2.5) && behindClear(0, 25)) v.lane = 0;
      }
      const acc = target > v.v ? 1.0 : -3.0;
      v.v = Math.max(0, acc > 0 ? Math.min(target, v.v + acc * DT) : Math.max(target, v.v + acc * DT));
      const s0 = v.s;
      v.s += v.v * DT;
      // ease the lateral offset toward the chosen lane
      const latTarget = -v.lane * 3.2; // overtaking lane is on the right (left-hand traffic)
      v.lat += Math.sign(latTarget - v.lat) * Math.min(Math.abs(latTarget - v.lat), 1.2 * DT);
      if (recording) for (const g of gates) if (g.route === r && s0 < g.s && v.s >= g.s) read(v, g);
    }
  }
  // exits
  for (let i = vehicles.length - 1; i >= 0; i--) {
    const v = vehicles[i];
    if (v.s >= v.route.len - 5) {
      vehicles.splice(i, 1);
      if (recording) goneQueue.push(v.id);
    }
  }
}

function position(v) {
  const p = at(v.route, v.s);
  // left of travel = (-ty, tx)
  return [Math.round((p.x - p.ty * v.lat) * 10), Math.round((p.y + p.tx * v.lat) * 10)];
}

// ---------------------------------------------------------------- run
let t = 0;
for (; t < WARMUP; t += DT) step(t, false);
console.log("after warm-up", vehicles.length);

const frames = [];
const last = new Map();
const firstSpawn = vehicles.map((v) => [v.id, v.plate, v.cls, v.flags]);
let rec = 0;
for (let k = 0; k <= DURATION / FRAME; k++) {
  if (k > 0) {
    for (let i = 0; i < FRAME / DT; i++, t += DT, rec += DT) step(t, true);
  }
  const now = [...vehicles].sort((a, b) => a.id - b.id);
  const p = [];
  let prevId = 0;
  const seen = new Map();
  for (const v of now) {
    const [x, y] = position(v);
    const old = last.get(v.id);
    p.push(v.id - prevId, old ? x - old[0] : x, old ? y - old[1] : y);
    prevId = v.id;
    seen.set(v.id, [x, y]);
  }
  last.clear();
  for (const [id, xy] of seen) last.set(id, xy);
  frames.push({
    t: Math.round(rec * 10) / 10,
    s: k === 0 ? firstSpawn : spawnQueue.splice(0).map((v) => [v.id, v.plate, v.cls, v.flags]),
    g: goneQueue.splice(0),
    e: eventQueue.splice(0),
    st: { ...stats },
    p,
  });
}

const out = {
  v: 1,
  kind: "synthetic",
  note: "Synthetic traffic generated by viewer/scripts/make-replay.mjs on the OpenStreetMap A1 network. Not real vehicles.",
  dt: FRAME,
  clock0: "2026-10-20T07:40:00+02:00",
  frames,
};
mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(out);
writeFileSync(OUT, json);
const events = frames.reduce((n, f) => n + f.e.length, 0);
console.log(`wrote ${OUT}: ${frames.length} frames, ${events} reads, ${(json.length / 1024).toFixed(0)} KiB`);
