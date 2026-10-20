// Golden vehicle positions for the Unreal client (toll-sim-unreal), produced
// by the same decoder, interpolation and placement code the browser runs.
//
//   node scripts/export-golden.mjs [replay.json] [out.json]
//
// The replay is fed one frame at a time; after each frame the render clock is
// put at frame.t - LAG and every visible vehicle's centre is recorded (sim
// metres, before any plaza lane remap). The Unreal automation test replays the
// same file through its C++ port and must land within 0.1 m.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAG, decodeReplay, ingestVehicles, sampleAt } from "../src/traffic.js";
import { classLen, frontToCentre } from "../src/vehicle-geometry.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.argv[2] ?? resolve(here, "../public/replay.json"));
const out = resolve(process.argv[3] ?? resolve(here, "../golden-positions.json"));
const EVERY = 10;

const replay = decodeReplay(JSON.parse(readFileSync(src, "utf8")));
const veh = new Map();
const reg = new Map();
const frames = [];
replay.frames.forEach((frame, k) => {
  for (const [id, , cls] of frame.spawn ?? []) reg.set(id, cls);
  ingestVehicles(veh, frame);
  const renderT = frame.t - LAG;
  const rows = [];
  for (const [id, v] of veh) {
    if (v.goneAt != null && renderT >= v.goneAt) {
      veh.delete(id);
      continue;
    }
    if (v.s[0][0] > renderT + 0.01) continue;
    const p = sampleAt(v, renderT);
    if (!p) continue;
    const [X, Y] = frontToCentre(p[1], p[2], p[3], classLen(reg.get(id) ?? "1"));
    rows.push([id, Math.round(X * 1000) / 1000, Math.round(Y * 1000) / 1000, Math.round(p[3] * 100) / 100]);
  }
  if (k > 0 && k % EVERY === 0) frames.push({ k, t: frame.t, renderT, v: rows });
});

writeFileSync(out, JSON.stringify({ lag: LAG, every: EVERY, frames }));
console.log(`wrote ${out}: ${frames.length} frames, ${frames.reduce((a, f) => a + f.v.length, 0)} vehicle rows`);
