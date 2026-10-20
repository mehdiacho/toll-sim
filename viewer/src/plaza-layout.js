// Toll plaza layout shared by the 3D view (src/world.js, src/viewer.js) and the
// replay generator (scripts/make-replay.mjs). Plain JS, no three.js, so Node can
// import it.
//
// A plaza has a local frame: u runs along the northbound travel direction, v to
// the left of it (SUMO metres). Traffic keeps left, so the northbound lanes lie
// at v > 0 and the southbound lanes at v < 0, with the median at v = 0.
// "t" is distance along a lane in its own direction of travel: t = u for N,
// t = -u for S. The boom line of every lane is at t = BOOM_T.
//
// road.json may carry `plazas` (from the simulation). Without them, one plaza is
// derived per gantry id: five lanes each way, the two outer lanes for heavy
// vehicles, two mixed lanes (tag, cash, card) and an e-tag lane by the median.

export const LANE_W = 3.5;
export const ISLAND_W = 2.2;
export const KERB_W = 1.6;
export const BOOTH_T = 0; // booth centre, along the lane
export const BOOM_T = 5; // boom line, along the lane
export const ISLAND_T0 = -28; // island nose
export const ISLAND_T1 = 11; // island tail
export const CANOPY_U = 7.5; // canopy half depth
export const FLARE_IN = [-260, -70]; // carriageway widens over this stretch of t
export const FLARE_OUT = [24, 210]; // and narrows back over this one
export const ZONE = [-320, 230]; // the stretch of t the plaza owns
export const DEFAULT_TYPES = ["heavy", "heavy", "mixed", "mixed", "etag"]; // idx 0 = outer (kerb) lane
export const TARIFF_THEBE = { M: 800, 1: 1500, 2: 3500, 3: 6000, 4: 9000 };
export const TARIFF_ROWS = [
  ["1", "Light vehicles", 1500],
  ["2", "Medium: buses, 2 axles", 3500],
  ["3", "Heavy: 3 to 4 axles", 6000],
  ["4", "Extra heavy: 5+ axles", 9000],
];

const smooth = (x, a, b) => {
  const k = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

/** 0 on the open road, 1 in the plaza lanes. t is along the direction of travel. */
export function flare(t) {
  if (t < FLARE_IN[0] || t > FLARE_OUT[1]) return 0;
  if (t < FLARE_IN[1]) return smooth(t, FLARE_IN[0], FLARE_IN[1]);
  if (t > FLARE_OUT[0]) return 1 - smooth(t, FLARE_OUT[0], FLARE_OUT[1]);
  return 1;
}

export function frameOf(p) {
  const ux = Math.cos(p.heading);
  const uy = Math.sin(p.heading);
  return { ux, uy, nx: -uy, ny: ux };
}

export function toUV(p, X, Y) {
  const dx = X - p.x;
  const dy = Y - p.y;
  return { u: dx * p.ux + dy * p.uy, v: dx * p.nx + dy * p.ny };
}

export function fromUV(p, u, v) {
  return [p.x + p.ux * u + p.nx * v, p.y + p.uy * u + p.ny * v];
}

/** Along-lane coordinate t <-> plaza u. */
export const tToU = (dir, t) => (dir === "S" ? -t : t);
export const uToT = (dir, u) => (dir === "S" ? -u : u);

/** Plaza-wide lane number shown on the canopy: southbound 1..n, then northbound. */
export function laneNumber(p, dir, idx) {
  const nS = p.lanes.filter((l) => l.dir === "S").length;
  const nN = p.lanes.filter((l) => l.dir === "N").length;
  return dir === "S" ? idx + 1 : nS + (nN - idx);
}

export const TYPE_LABEL = { heavy: "Heavy vehicles", mixed: "Tag · Cash · Card", etag: "e-tag only" };

function derivedLanes(p) {
  const lanes = [];
  const n = DEFAULT_TYPES.length;
  for (const dir of ["N", "S"]) {
    for (let idx = 0; idx < n; idx++) {
      const j = n - 1 - idx; // 0 next to the median
      const v = (j + 1) * ISLAND_W + j * LANE_W + LANE_W / 2;
      const sv = dir === "N" ? v : -v;
      const [x, y] = fromUV(p, 0, sv);
      lanes.push({ dir, idx, type: DEFAULT_TYPES[idx], x, y, w: LANE_W });
    }
  }
  return lanes;
}

/**
 * Lanes from an export can be packed edge to edge, with no room for the booth
 * islands. If so they are drawn re-spaced in the standard layout, and srcV keeps
 * where the feed puts vehicles, so mapV() can move them onto the drawn lanes.
 */
function respace(p) {
  const sorted = [...p.lanes].sort((a, b) => a.v - b.v);
  let packed = false;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b.v - a.v < (a.w + b.w) / 2 + ISLAND_W * 0.8) packed = true;
  }
  for (const l of p.lanes) l.srcV = l.v;
  if (!packed) return;
  p.remap = true;
  for (const dir of ["N", "S"]) {
    const s = dir === "N" ? 1 : -1;
    const mine = p.lanes.filter((l) => l.dir === dir).sort((a, b) => s * a.v - s * b.v);
    mine.forEach((l, j) => {
      l.w = LANE_W;
      l.v = s * ((j + 1) * ISLAND_W + j * LANE_W + LANE_W / 2);
      [l.x, l.y] = fromUV(p, l.u, l.v);
    });
  }
}

/** Where a vehicle the feed puts at lateral v should be drawn (see respace). */
export function mapV(p, dir, v) {
  if (!p.remap) return v;
  const pts = p.lanes.filter((l) => l.dir === dir).map((l) => [l.srcV, l.v]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return v;
  if (v <= pts[0][0]) return pts[0][1] + (v - pts[0][0]);
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [a0, a1] = pts[i - 1];
      const [b0, b1] = pts[i];
      return a1 + ((v - a0) / (b0 - a0 || 1)) * (b1 - a1);
    }
  }
  const last = pts[pts.length - 1];
  return last[1] + (v - last[0]);
}

function finish(p, road) {
  Object.assign(p, frameOf(p));
  for (const l of p.lanes) {
    const { u, v } = toUV(p, l.x, l.y);
    l.u = u;
    l.v = v;
    l.w = l.w ?? LANE_W;
  }
  respace(p);
  for (const l of p.lanes) {
    const v = l.v;
    l.key = `${l.dir}${l.idx}`;
    // the booth island is on the driver's side: the right of the lane
    l.islandV = l.dir === "N" ? v - l.w / 2 - ISLAND_W / 2 : v + l.w / 2 + ISLAND_W / 2;
    l.number = 0;
  }
  p.lanes.sort((a, b) => a.v - b.v);
  for (const l of p.lanes) l.number = laneNumber(p, l.dir, l.idx);
  const vs = p.lanes.map((l) => Math.abs(l.v) + l.w / 2);
  p.halfWidth = Math.max(10, ...vs) + KERB_W;
  p.byKey = new Map(p.lanes.map((l) => [l.key, l]));
  // where the ordinary carriageways sit at each end of the plaza
  p.span = {};
  for (const dir of ["N", "S"]) {
    p.span[dir] = {
      in: roadSpan(road, p, dir, tToU(dir, ZONE[0] + 20)),
      out: roadSpan(road, p, dir, tToU(dir, ZONE[1] - 20)),
    };
  }
  return p;
}

/** Plazas from road.json, derived from the gantries when the export has none. */
export function plazasFrom(road) {
  if (Array.isArray(road.plazas) && road.plazas.length) {
    return road.plazas
      .filter((p) => Array.isArray(p.lanes) && p.lanes.length)
      .map((p) => finish({ ...p, lanes: p.lanes.map((l) => ({ ...l })), derived: false }, road));
  }
  const byId = new Map();
  for (const g of road.gantries ?? []) {
    if (!byId.has(g.id)) byId.set(g.id, []);
    byId.get(g.id).push(g);
  }
  const out = [];
  for (const [id, gs] of byId) {
    const x = gs.reduce((s, g) => s + g.x, 0) / gs.length;
    const y = gs.reduce((s, g) => s + g.y, 0) / gs.length;
    const gn = gs.find((g) => g.dir.includes("N"));
    const heading = gn ? gn.heading : gs[0].heading + Math.PI;
    const p = { id, name: gs[0].name, km: gs[0].km, x, y, heading, derived: true };
    Object.assign(p, frameOf(p));
    p.lanes = derivedLanes(p);
    out.push(finish(p, road));
  }
  return out;
}

/**
 * The lateral extent [vMin, vMax] of the ordinary carriageway for `dir` where
 * it crosses the plaza cross-section at u.
 */
export function roadSpan(road, p, dir, u) {
  const sign = dir === "N" ? 1 : -1;
  const vs = [];
  let w = 3.2;
  for (const lane of road.lanes) {
    const pts = lane.pts;
    for (let i = 1; i < pts.length; i++) {
      const a = toUV(p, pts[i - 1][0], pts[i - 1][1]);
      const b = toUV(p, pts[i][0], pts[i][1]);
      if ((a.u - u) * (b.u - u) > 0 || a.u === b.u) continue;
      const len = Math.hypot(b.u - a.u, b.v - a.v) || 1;
      if (((b.u - a.u) / len) * sign < 0.7) continue;
      const f = (u - a.u) / (b.u - a.u);
      const v = a.v + (b.v - a.v) * f;
      if (Math.abs(v) > 45) continue;
      vs.push(v);
      w = lane.w;
    }
  }
  if (!vs.length) return dir === "N" ? [0, 3.4] : [-3.4, 0];
  let lo = Math.min(...vs) - w / 2;
  let hi = Math.max(...vs) + w / 2;
  // a single carriageway's lanes touch the centre line
  if (dir === "N" && lo < 0.6) lo = 0;
  if (dir === "S" && hi > -0.6) hi = 0;
  return [lo, hi];
}

/** Carriageway edges at along-lane distance t: [vInner, vOuter] in plaza v. */
export function apronEdges(p, dir, t) {
  const f = flare(t);
  const sp = t < 0 ? p.span[dir].in : p.span[dir].out;
  const lanes = p.lanes.filter((l) => l.dir === dir);
  if (dir === "N") {
    const outer = Math.max(...lanes.map((l) => l.v + l.w / 2)) + KERB_W * 0.5;
    return [sp[0] * (1 - f), sp[1] + (outer - sp[1]) * f];
  }
  const outer = Math.min(...lanes.map((l) => l.v - l.w / 2)) - KERB_W * 0.5;
  return [sp[1] * (1 - f), sp[0] + (outer - sp[0]) * f];
}

/** Lane centre at along-lane distance t, fanning out of the ordinary carriageway. */
export function laneV(p, lane, t) {
  const f = flare(t);
  const sp = t < 0 ? p.span[lane.dir].in : p.span[lane.dir].out;
  const lanes = p.lanes.filter((l) => l.dir === lane.dir).sort((a, b) => a.v - b.v);
  const k = lanes.indexOf(lane);
  const road = sp[0] + ((sp[1] - sp[0]) * (k + 0.5)) / lanes.length;
  return road + (lane.v - road) * f;
}

/** Which lane of `dir` is at plaza v (nearest centre), or null if on an island. */
export function laneAt(p, dir, v, slack = 0.4) {
  let best = null;
  for (const l of p.lanes) {
    if (l.dir !== dir) continue;
    const d = Math.abs(l.v - v);
    if (d <= l.w / 2 + slack && (!best || d < best.d)) best = { d, l };
  }
  return best ? best.l : null;
}

/** Lanes open when the feed doesn't say: fewer at night (Botswana time). */
export function defaultOpen(p, hour) {
  const open = { N: [], S: [] };
  for (const dir of ["N", "S"]) {
    const lanes = p.lanes.filter((l) => l.dir === dir);
    let shut = new Set();
    if (hour >= 20 || hour < 5) {
      // keep one of each type
      const keep = new Set();
      for (const type of ["heavy", "mixed", "etag"]) {
        const of = lanes.filter((l) => l.type === type).sort((a, b) => b.idx - a.idx);
        if (of.length) keep.add(of[0].idx);
      }
      if (hour >= 20 && hour < 23) {
        const extra = lanes.find((l) => !keep.has(l.idx) && l.type === "mixed");
        if (extra) keep.add(extra.idx);
      }
      shut = new Set(lanes.filter((l) => !keep.has(l.idx)).map((l) => l.idx));
    }
    open[dir] = lanes.filter((l) => !shut.has(l.idx)).map((l) => l.idx);
  }
  return open;
}

// ------------------------------------------------------------ road walking

/** Outer-lane polylines and how they connect, for walking the road from a plaza. */
export function roadGraph(road) {
  const edges = road.lanes
    .filter((l) => l.idx === 0)
    .map((l) => {
      const s = [0];
      for (let i = 1; i < l.pts.length; i++) s.push(s[i - 1] + Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]));
      return { id: l.id, pts: l.pts, s, len: s[s.length - 1], w: l.w, n: l.n };
    })
    .filter((e) => e.len > 0.5);
  const head = (e, end) => {
    const pts = e.pts;
    const [a, b] = end ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[0], pts[1]];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
  };
  for (const e of edges) {
    e.hs = head(e, false);
    e.he = head(e, true);
  }
  for (const e of edges) {
    const st = e.pts[0];
    const en = e.pts[e.pts.length - 1];
    e.pred = edges
      .filter((o) => o !== e)
      .map((o) => ({ o, d: Math.hypot(o.pts[o.pts.length - 1][0] - st[0], o.pts[o.pts.length - 1][1] - st[1]), dot: o.he[0] * e.hs[0] + o.he[1] * e.hs[1] }))
      .filter((c) => c.d < 60 && c.dot > 0.3)
      .sort((a, b) => a.d - b.d - (a.dot - b.dot) * 10)
      .map((c) => c.o);
    e.succ = edges
      .filter((o) => o !== e)
      .map((o) => ({ o, d: Math.hypot(o.pts[0][0] - en[0], o.pts[0][1] - en[1]), dot: o.hs[0] * e.he[0] + o.hs[1] * e.he[1] }))
      .filter((c) => c.d < 60 && c.dot > 0.3)
      .sort((a, b) => a.d - b.d - (a.dot - b.dot) * 10)
      .map((c) => c.o);
  }
  return edges;
}

/**
 * Walk `dist` metres along the road from the plaza's cross-section, upstream
 * (dist < 0) or downstream (dist > 0) for traffic in `dir`. Returns the outer
 * lane's centre, its unit tangent in the travel direction, width and lane count.
 */
export function walkRoad(graph, p, dir, dist) {
  const sign = dir === "N" ? 1 : -1;
  let start = null;
  for (const e of graph) {
    for (let i = 1; i < e.pts.length; i++) {
      const a = toUV(p, e.pts[i - 1][0], e.pts[i - 1][1]);
      const b = toUV(p, e.pts[i][0], e.pts[i][1]);
      if (a.u * b.u > 0 || a.u === b.u) continue;
      const L = Math.hypot(b.u - a.u, b.v - a.v) || 1;
      if (((b.u - a.u) / L) * sign < 0.7) continue;
      const f = -a.u / (b.u - a.u);
      const v = a.v + (b.v - a.v) * f;
      if (Math.abs(v) > 45) continue;
      // prefer the outermost lane polyline of this direction
      if (!start || Math.abs(v) > Math.abs(start.v)) start = { e, s: e.s[i - 1] + (e.s[i] - e.s[i - 1]) * f, v };
    }
  }
  if (!start) return null;
  let { e, s } = start;
  let left = Math.abs(dist);
  for (let guard = 0; guard < 200; guard++) {
    if (dist < 0) {
      if (s - left >= 0) {
        s -= left;
        break;
      }
      left -= s;
      const nx = e.pred[0];
      if (!nx) {
        s = 0;
        break;
      }
      e = nx;
      s = e.len;
    } else {
      if (s + left <= e.len) {
        s += left;
        break;
      }
      left -= e.len - s;
      const nx = e.succ[0];
      if (!nx) {
        s = e.len;
        break;
      }
      e = nx;
      s = 0;
    }
  }
  let i = 1;
  while (i < e.s.length - 1 && e.s[i] < s) i++;
  const a = e.pts[i - 1];
  const b = e.pts[i];
  const seg = e.s[i] - e.s[i - 1] || 1;
  const f = Math.max(0, Math.min(1, (s - e.s[i - 1]) / seg));
  return { x: a[0] + (b[0] - a[0]) * f, y: a[1] + (b[1] - a[1]) * f, tx: (b[0] - a[0]) / seg, ty: (b[1] - a[1]) / seg, w: e.w, n: e.n };
}
