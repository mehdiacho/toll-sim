// Generates viewer/public/replay.json: a few minutes of synthetic A1 traffic in
// the same shape as the live feed, for visitors to watch while the live
// simulation is not running.
//
// Vehicles drive the lane polylines of live/road.json in both directions with
// a simple car-following and overtaking model. At each toll plaza they slow
// down for the speed limits, spread into the plaza lanes by how they pay
// (e-tag vehicles to the e-tag lane, heavy vehicles to the heavy lanes, the
// rest to the mixed lanes), queue, stop at the booth (about 4 s for a tag in a
// mixed lane, 8 to 12 s for cash or a card), and leave when the boom lifts.
// E-tag lanes take vehicles rolling at walking pace. Now and then a tag is
// declined for insufficient funds and the driver pays by card instead.
// The plaza layout comes from src/plaza-layout.js, shared with the 3D view.
//
// Usage: node scripts/make-replay.mjs [minutes]
//
// Output format (decoded by src/feed.js):
//   { v, kind, dt, clock0, frames: [{ t, s, g, e, st, p, b?, o? }] }
//   s  = spawn  [[id, plate, class, flags]]
//   g  = gone   [id]
//   e  = toll events (same objects as the live feed: plaza, lane, method, ...)
//   st = cumulative stats, with st.plazas = { id: { open, queue, wait_s, by_method } }
//   b  = boom changes in this frame [[plazaId, dir, laneIdx, 0|1]]
//   o  = lanes open { plazaId: { N: [idx], S: [idx] } } (first frame only)
//   p  = flat ints, vehicles sorted by id: [idDelta, x, y] where x/y are in
//        decimetres, absolute for a vehicle new to this frame, otherwise the
//        delta from its previous frame. Heading and speed are derived from the
//        motion on decode.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as PL from "../src/plaza-layout.js";

const here = dirname(fileURLToPath(import.meta.url));
const road = JSON.parse(readFileSync(resolve(here, "../../live/road.json"), "utf8"));
const OUT = resolve(here, "../public/replay.json");

const MINUTES = Number(process.argv[2] ?? 5);
const DT = 0.5; // integration step, s
const FRAME = 2; // frame interval, s
const WARMUP = 150; // s simulated before recording starts
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

// ---------------------------------------------------------------- plazas
const plazas = PL.plazasFrom(road);
// Lanes open in the recording: everything at the busy Mmamashia plaza, one
// mixed lane each way shut at the two quieter plazas.
const OPEN = {};
for (const p of plazas) {
  OPEN[p.id] = {};
  for (const dir of ["N", "S"]) {
    const lanes = p.lanes.filter((l) => l.dir === dir);
    const shut = p.name === "Mmamashia" ? [] : lanes.filter((l) => l.type === "mixed").slice(0, 1).map((l) => l.idx);
    OPEN[p.id][dir] = lanes.filter((l) => !shut.includes(l.idx)).map((l) => l.idx);
  }
}
const gates = [];
for (const p of plazas) {
  for (const r of routes) {
    const s = project(r, p.x, p.y);
    if (s == null) continue;
    gates.push({ plaza: p, dir: r.dir, route: r, s, lanes: p.lanes.filter((l) => l.dir === r.dir && OPEN[p.id][r.dir].includes(l.idx)) });
  }
}
console.log("plazas", gates.map((g) => `${g.plaza.id}/${g.dir}@${(g.s / 1000).toFixed(1)}km`).join(" "));

/** The plaza a vehicle at arc length s is approaching or leaving, with t along its lane. */
function gateAt(route, s) {
  for (const g of gates) {
    if (g.route !== route) continue;
    const t = s - g.s;
    if (t > PL.ZONE[0] - 1200 && t < PL.ZONE[1]) return { g, t };
  }
  return null;
}

// Towns slow traffic down.
const towns = road.places.filter((p) => p.name === "Gaborone" || p.name === "Mahalapye");
function speedCap(x, y) {
  for (const t of towns) if (Math.hypot(x - t.x, y - t.y) < 5000) return 60 / 3.6;
  return Infinity;
}

/** The posted limits on a plaza approach and just after the booms, m/s. */
function plazaCap(t, lane) {
  if (t < -1400) return Infinity;
  if (t < -880) return 120 / 3.6;
  if (t < -430) return 80 / 3.6;
  if (t < -215) return 60 / 3.6;
  if (t < -45) return 40 / 3.6;
  if (t < PL.BOOM_T + 2) return (lane?.type === "etag" ? 16 : 22) / 3.6;
  if (t < 60) return 40 / 3.6;
  if (t < 200) return 80 / 3.6;
  return Infinity;
}

// ---------------------------------------------------------------- vehicles
const CLASSES = [
  // class, share, length m, desired speed km/h range
  ["1", 0.71, 4.6, [95, 125]],
  ["2", 0.09, 7.5, [85, 100]],
  ["3", 0.08, 12, [75, 92]],
  ["4", 0.09, 18.5, [70, 85]],
  ["M", 0.03, 2.2, [85, 120]],
];
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
let clock = 0;
let recording = false;
const vehicles = [];
const spawnQueue = [];
const goneQueue = [];
const eventQueue = [];
const boomQueue = [];
const stats = { charged: 0, unpaid: 0, review: 0, insufficient_funds: 0, unregistered_vehicle: 0, revenue_thebe: 0 };
const pstats = Object.fromEntries(plazas.map((p) => [p.id, { by_method: { tag: 0, cash: 0, card: 0 }, waits: [] }]));

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
    // Whether this vehicle's tag account has run dry (stable per vehicle).
    broke: tagged && rnd() < 0.07,
    pz: null, // { g, lane, state, until, method, ... } while at a plaza
  };
  v.v = v.vdes * between(0.9, 1);
  vehicles.push(v);
  if (inRecording) spawnQueue.push(v);
  return v;
}

// Initial population: a steady flow everywhere, commuter traffic around
// Gaborone and a denser stream upstream of each plaza, so that a few minutes of
// recording carry a steady stream of transactions.
const gab = road.places.find((p) => p.name === "Gaborone");
for (const r of routes) {
  for (let s = 50; s < r.len - 50; ) {
    const p = at(r, s);
    const km = Math.hypot(p.x - gab.x, p.y - gab.y) / 1000;
    const up = gates.find((g) => g.route === r && g.s - s > 200 && g.s - s < 13500);
    const boost = up ? (up.plaza.name === "Mmamashia" ? 9 : 3.4) : 0;
    const perKm = 0.5 + 4 * Math.exp(-km / 18) + boost;
    s += expo(perKm / 1000) + 22;
    if (s < r.len - 50) makeVehicle(r, s, false);
  }
}
console.log("initial vehicles", vehicles.length);

function arrivalRate(route) {
  // vehicles / s entering at the route start
  return route.dir === "N" ? 0.15 : 0.035;
}
const nextArrival = new Map(routes.map((r) => [r, expo(arrivalRate(r))]));

// ---------------------------------------------------------------- plaza behaviour
function laneQueue(g, lane) {
  let n = 0;
  for (const o of vehicles) if (o.pz && o.pz.g === g && o.pz.lane === lane && o.pz.state !== "gone") n++;
  return n;
}

function chooseLane(v, g) {
  const heavy = v.cls === "2" || v.cls === "3" || v.cls === "4";
  const tagged = v.flags & 2;
  let type = heavy ? "heavy" : tagged && rnd() < 0.88 ? "etag" : "mixed";
  let cands = g.lanes.filter((l) => l.type === type);
  if (!cands.length) cands = g.lanes.filter((l) => l.type !== "etag");
  let best = null;
  for (const l of cands) {
    const score = laneQueue(g, l) + rnd() * 0.9 + (l.type === "mixed" && type !== "mixed" ? 1 : 0);
    if (!best || score < best[1]) best = [l, score];
  }
  // a tagged car facing a long e-tag queue sometimes takes a mixed lane instead
  if (type === "etag" && best && best[1] > 4) {
    const alt = g.lanes.filter((l) => l.type === "mixed").map((l) => [l, laneQueue(g, l)]);
    alt.sort((a, b) => a[1] - b[1]);
    if (alt.length && alt[0][1] + 1 < best[1]) best = alt[0];
  }
  return best[0];
}

function emit(v, status, method, reason = null) {
  const pz = v.pz;
  const amount = PL.TARIFF_THEBE[v.cls];
  if (!recording) return;
  stats[status] = (stats[status] ?? 0) + 1;
  if (reason) stats[reason] = (stats[reason] ?? 0) + 1;
  if (status === "charged") {
    stats.revenue_thebe += amount;
    pstats[pz.g.plaza.id].by_method[method]++;
  }
  eventQueue.push({
    vid: v.id,
    gantry: pz.g.plaza.id,
    plaza: pz.g.plaza.id,
    dir: pz.g.dir,
    lane: pz.lane.idx,
    method,
    plate: v.plate,
    status,
    amount_thebe: amount,
    reason,
    match: method === "tag" ? "tag" : "booth",
  });
}

function boom(v, up) {
  const pz = v.pz;
  if (recording) boomQueue.push([pz.g.plaza.id, pz.g.dir, pz.lane.idx, up ? 1 : 0]);
}

/** Advance a vehicle's plaza state; returns the arc length it must stop at, or null. */
function plazaRules(v, g, t) {
  if (!v.pz && t > -520 && t < -300) {
    const lane = chooseLane(v, g);
    const tagged = v.flags & 2;
    v.pz = { g, lane, state: "approach", method: tagged ? "tag" : rnd() < 0.42 ? "cash" : "card", slow: 0 };
  }
  const pz = v.pz;
  if (!pz || pz.g !== g) return null;
  const stopS = g.s + PL.BOOM_T - 1.4 - v.length / 2;
  const front = t + v.length / 2;
  if (t < PL.BOOM_T && v.v < 3) pz.slow += DT;
  if (pz.state === "approach") {
    if (pz.lane.type === "etag" && PL.BOOM_T - front < 11) {
      if (v.broke) {
        emit(v, "unpaid", "tag", "insufficient_funds");
        pz.state = "wait-stop";
        pz.extra = between(8, 11);
        pz.after = "card";
      } else {
        emit(v, "charged", "tag");
        pz.state = "opening";
        pz.until = clock + 0.9;
        boom(v, true);
      }
    } else if (pz.lane.type !== "etag" && stopS - v.s < 0.8 && v.v < 0.4) {
      pz.state = "service";
      const m = pz.method;
      pz.until = clock + (m === "tag" ? between(3.4, 4.6) : m === "cash" ? between(9, 12) : between(8, 11));
      if (m === "tag" && v.broke) {
        pz.declineAt = clock + 2.5;
        pz.until += between(7, 10);
        pz.after = "card";
      }
    }
  } else if (pz.state === "wait-stop") {
    if (stopS - v.s < 0.8 && v.v < 0.4) {
      pz.state = "service";
      pz.until = clock + pz.extra;
    }
  } else if (pz.state === "service") {
    if (pz.declineAt && clock >= pz.declineAt) {
      pz.declineAt = null;
      emit(v, "unpaid", "tag", "insufficient_funds");
    }
    if (clock >= pz.until) {
      emit(v, "charged", pz.after ?? pz.method);
      pz.state = "opening";
      pz.until = clock + 0.9; // the boom lifts, then the driver pulls away
      boom(v, true);
    }
  } else if (pz.state === "opening") {
    if (clock >= pz.until) pz.state = "cleared";
  } else if (pz.state === "cleared") {
    if (t - v.length / 2 > PL.BOOM_T + 1.2) {
      boom(v, false);
      pz.state = "gone";
      if (recording) {
        const w = pstats[g.plaza.id].waits;
        w.push(pz.slow);
        if (w.length > 30) w.shift();
      }
    }
  }
  if (pz.state === "approach" || pz.state === "wait-stop" || pz.state === "service") return stopS;
  if (pz.state === "opening") return stopS;
  return null;
}

/** Lateral position across the plaza (plaza v), blending road lane and plaza lane. */
function plazaV(v, g, t, X, Y) {
  const q = PL.toUV(g.plaza, X, Y);
  if (!v.pz || v.pz.g !== g) return { q, vv: q.v, f: 0 };
  const f = PL.flare(t);
  // srcV: the feed's own lane centre, which the viewer maps onto its drawn lanes
  const target = v.pz.lane.srcV ?? v.pz.lane.v;
  return { q, vv: q.v + (target - q.v) * f, f };
}

function roadXY(v) {
  const p = at(v.route, v.s);
  return { x: p.x - p.ty * v.lat, y: p.y + p.tx * v.lat, p };
}

// ---------------------------------------------------------------- step
function step(t) {
  clock = t;
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
    // plaza context for everyone first, so leaders can be found by lateral position
    for (const v of list) {
      const ga = gateAt(r, v.s);
      v._g = ga;
      v._vv = null;
      if (ga && ga.t > PL.FLARE_IN[0] - 10) {
        const { x, y } = roadXY(v);
        v._vv = plazaV(v, ga.g, ga.t, x, y).vv;
      }
    }
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const here = at(r, v.s);
      const ga = v._g;
      const inPlaza = v._vv != null;
      const twoLanes = here.n >= 2 && !inPlaza;
      if (here.n < 2) v.lane = 0;
      const gapTo = (o) => o.s - v.s - o.length / 2 - v.length / 2;
      // leaders in each lane
      const ahead = (lane) => {
        for (let j = i + 1; j < list.length; j++) {
          const o = list[j];
          if (o.s - v.s > 300) break;
          if (inPlaza) {
            if (o._vv != null && Math.abs(o._vv - v._vv) < 2.6) return o;
            continue;
          }
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
      let want = Math.min(v.vdes, speedCap(here.x, here.y));
      let stopS = null;
      if (ga) {
        want = Math.min(want, plazaCap(ga.t, v.pz?.g === ga.g ? v.pz.lane : null));
        stopS = plazaRules(v, ga.g, ga.t);
      } else if (v.pz) {
        v.pz = null;
      }
      const leader = ahead(v.lane);
      const safe = (spd) => 2.5 + spd * 1.3;
      let target = want;
      if (leader && !inPlaza) {
        const gap = gapTo(leader);
        if (gap < safe(v.v) * 2.2 && leader.v < want - 1 && twoLanes && v.lane === 0 && !(ga && ga.t > -900 && ga.t < 0)) {
          // try to overtake on a dual carriageway
          const l1 = ahead(1);
          if ((!l1 || gapTo(l1) > safe(v.v) * 2) && behindClear(1, 40)) v.lane = 1;
        }
      }
      const lead2 = ahead(v.lane);
      if (lead2) {
        const g = gapTo(lead2);
        if (g < safe(v.v)) target = Math.min(target, lead2.v * Math.max(0, (g - 1.5) / safe(v.v)));
        else if (g < safe(v.v) * 2) target = Math.min(target, lead2.v + (g - safe(v.v)) * 0.25);
        if (g < 1.2) target = 0;
      }
      if (stopS != null) {
        const d = stopS - v.s;
        target = Math.min(target, d <= 0 ? 0 : Math.sqrt(2 * 1.8 * d));
      }
      if (v.lane === 1 && !inPlaza) {
        const l0 = ahead(0);
        if ((!l0 || gapTo(l0) > safe(v.v) * 2.5) && behindClear(0, 25)) v.lane = 0;
      }
      if (inPlaza && v.lane === 1 && here.n < 2) v.lane = 0;
      const acc = target > v.v ? (v.cls === "1" || v.cls === "M" ? 1.6 : 0.9) : -3.5;
      v.v = Math.max(0, acc > 0 ? Math.min(target, v.v + acc * DT) : Math.max(target, v.v + acc * DT));
      v.s += v.v * DT;
      // ease the lateral offset toward the chosen road lane
      const latTarget = -v.lane * 3.2; // overtaking lane is on the right (left-hand traffic)
      v.lat += Math.sign(latTarget - v.lat) * Math.min(Math.abs(latTarget - v.lat), 1.2 * DT);
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

// Like SUMO, the replay reports the front bumper (v.s is the centre here).
function position(v) {
  const centre = v.s;
  v.s = centre + v.length / 2;
  try {
    return positionAtS(v);
  } finally {
    v.s = centre;
  }
}

function positionAtS(v) {
  const { x, y } = roadXY(v);
  const ga = gateAt(v.route, v.s);
  if (ga && v.pz && v.pz.g === ga.g) {
    const { q, vv } = plazaV(v, ga.g, ga.t, x, y);
    const [X, Y] = PL.fromUV(ga.g.plaza, q.u, vv);
    return [Math.round(X * 10), Math.round(Y * 10)];
  }
  return [Math.round(x * 10), Math.round(y * 10)];
}

function plazaStats() {
  const out = {};
  for (const p of plazas) {
    const queue = { N: 0, S: 0 };
    for (const v of vehicles) {
      if (!v.pz || v.pz.g.plaza !== p || v.pz.state === "gone" || v.pz.state === "cleared") continue;
      if (v.v < 2.5) queue[v.pz.g.dir]++;
    }
    const ps = pstats[p.id];
    const w = ps.waits;
    out[p.id] = {
      open: { N: OPEN[p.id].N.length, S: OPEN[p.id].S.length },
      queue,
      wait_s: w.length ? Math.round((w.reduce((a, b) => a + b, 0) / w.length) * 10) / 10 : null,
      by_method: { ...ps.by_method },
    };
  }
  return out;
}

// ---------------------------------------------------------------- run
let t = 0;
for (; t < WARMUP; t += DT) step(t);
console.log("after warm-up", vehicles.length);

recording = true;
const frames = [];
const last = new Map();
const firstSpawn = vehicles.map((v) => [v.id, v.plate, v.cls, v.flags]);
let rec = 0;
for (let k = 0; k <= DURATION / FRAME; k++) {
  if (k > 0) {
    for (let i = 0; i < FRAME / DT; i++, t += DT, rec += DT) step(t);
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
  const frame = {
    t: Math.round(rec * 10) / 10,
    s: k === 0 ? firstSpawn : spawnQueue.splice(0).map((v) => [v.id, v.plate, v.cls, v.flags]),
    g: goneQueue.splice(0),
    e: eventQueue.splice(0),
    st: { ...stats, plazas: plazaStats() },
    p,
  };
  const b = boomQueue.splice(0);
  if (b.length) frame.b = b;
  if (k === 0) frame.o = OPEN;
  frames.push(frame);
}

const out = {
  v: 2,
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
const methods = {};
for (const f of frames) for (const e of f.e) methods[`${e.method}/${e.status}`] = (methods[`${e.method}/${e.status}`] ?? 0) + 1;
const maxQ = {};
for (const f of frames) for (const [id, s] of Object.entries(f.st.plazas)) maxQ[id] = Math.max(maxQ[id] ?? 0, s.queue.N + s.queue.S);
console.log("transactions", JSON.stringify(methods), "max queue", JSON.stringify(maxQ));
console.log("final plaza stats", JSON.stringify(frames[frames.length - 1].st.plazas));
console.log(`wrote ${OUT}: ${frames.length} frames, ${events} events, ${(json.length / 1024).toFixed(0)} KiB`);
