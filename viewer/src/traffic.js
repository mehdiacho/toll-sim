// Feed decoding and per-vehicle interpolation, shared by the browser viewer,
// the replay tools and the golden data the Unreal client is tested against.
// No DOM or three.js in here.

export const LAG = 2.4; // seconds the view runs behind the newest frame, to interpolate

export function shortAngle(a, b) {
  let d = ((b - a + 540) % 360) - 180;
  return a + d;
}

/** Decode the compact replay into full frames shaped like the live feed. */
export function decodeReplay(data) {
  const pos = new Map(); // id -> [x, y]
  const ang = new Map(); // id -> deg
  const frames = [];
  for (const f of data.frames) {
    const vehicles = [];
    const p = f.p;
    let id = 0;
    const next = new Map();
    for (let i = 0; i < p.length; i += 3) {
      id += p[i];
      const old = pos.get(id);
      const x = old ? old[0] + p[i + 1] : p[i + 1];
      const y = old ? old[1] + p[i + 2] : p[i + 2];
      let a = ang.get(id) ?? null;
      let spd = 0;
      if (old) {
        const dx = x - old[0];
        const dy = y - old[1];
        const d = Math.hypot(dx, dy);
        spd = Math.round(d / data.dt);
        if (d > 3) a = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
      }
      next.set(id, [x, y]);
      if (a != null) ang.set(id, a);
      vehicles.push([id, x, y, a == null ? null : Math.round(a), spd]);
    }
    pos.clear();
    for (const [k, v] of next) pos.set(k, v);
    const frame = { t: f.t, vehicles, spawn: f.s, gone: f.g, events: f.e, stats: f.st };
    if (f.b) frame.booms = f.b;
    if (f.o) frame.lanes_open = f.o;
    frames.push(frame);
  }
  // Vehicles first seen in a frame have no heading yet: borrow it from the next frame.
  for (let k = 0; k < frames.length; k++) {
    const later = frames[k + 1] ? new Map(frames[k + 1].vehicles.map((v) => [v[0], v])) : null;
    for (const v of frames[k].vehicles) {
      if (v[3] == null) v[3] = later?.get(v[0])?.[3] ?? 0;
    }
  }
  return { dt: data.dt, frames, note: data.note };
}

/**
 * Add a frame's vehicles to the per-vehicle sample buffers.
 * veh: Map id -> { s: [[t, X, Y, headingDeg, speed]...], goneAt }, metres and m/s.
 */
export function ingestVehicles(veh, frame) {
  const t = frame.t;
  for (const [id, x, y, ang, spd] of frame.vehicles) {
    let v = veh.get(id);
    if (!v) {
      v = { s: [], goneAt: null };
      veh.set(id, v);
    }
    const sample = [t, x / 10, y / 10, ang ?? 0, (spd ?? 0) / 10];
    const prev = v.s[v.s.length - 1];
    if (prev) sample[3] = shortAngle(prev[3], sample[3]);
    v.s.push(sample);
    if (v.s.length > 4) v.s.shift();
    v.goneAt = null;
  }
  for (const id of frame.gone ?? []) {
    const v = veh.get(id);
    if (v) v.goneAt = t;
  }
}

/** Interpolated [t, X, Y, headingDeg, speed] for vehicle v at time t. */
export function sampleAt(v, t) {
  const s = v.s;
  if (!s.length) return null;
  if (t <= s[0][0]) return s[0];
  for (let i = 1; i < s.length; i++) {
    if (t <= s[i][0]) {
      const a = s[i - 1];
      const b = s[i];
      const f = (t - a[0]) / (b[0] - a[0] || 1);
      return [t, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f];
    }
  }
  // short extrapolation past the newest sample
  const b = s[s.length - 1];
  const dt = Math.min(2.5, t - b[0]);
  const th = (b[3] * Math.PI) / 180;
  return [t, b[1] + Math.sin(th) * b[4] * dt, b[2] + Math.cos(th) * b[4] * dt, b[3], b[4]];
}
