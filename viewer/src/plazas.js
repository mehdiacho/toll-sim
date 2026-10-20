// Mainline toll plazas: widened apron, islands, booths, canopy, booms, signals,
// fare displays, approach signage, high masts and an admin building.
//
// Everything static is merged per plaza into a handful of meshes (one per
// material); the moving parts (booms, lane signals, booth traffic lights) are
// instanced, and the fare displays share one canvas per plaza.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import * as L from "./plaza-layout.js";

const Y_APRON = 0.12;
const Y_MARK = 0.16;
const ISLAND_H = 0.25;
const CANOPY_Y = 6.0; // underside of the canopy slab
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

// ------------------------------------------------------------ geometry helpers

function prep(geo, color = 0xffffff) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const c = new THREE.Color(color);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

class Parts {
  constructor() {
    this.list = [];
  }
  push(geo, color) {
    this.list.push(prep(geo, color));
  }
  /** A box in plaza coordinates: centre (u, y, v), sizes du x h x dv, yaw about the vertical. */
  box(u, y, v, du, h, dv, color, yaw = 0) {
    const g = new THREE.BoxGeometry(du, h, dv);
    if (yaw) g.rotateY(yaw);
    g.translate(u, y, -v);
    this.push(g, color);
  }
  cyl(u, y, v, r0, r1, h, color, seg = 6) {
    const g = new THREE.CylinderGeometry(r1, r0, h, seg);
    g.translate(u, y, -v);
    this.push(g, color);
  }
  /** A flat quad lying on the ground from four (u, v) corners. */
  flat(corners, y, color) {
    const g = new THREE.BufferGeometry();
    const p = corners.map(([u, v]) => [u, y, -v]);
    const pos = [...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]];
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    this.push(g, color);
  }
  /** An upright quad facing (fu, fv) with atlas uv rectangle r. */
  quad(u, y, v, w, h, fu, fv, r, color = 0xffffff) {
    const g = new THREE.PlaneGeometry(w, h);
    if (r) {
      const uv = g.attributes.uv;
      uv.setXY(0, r.u0, r.v1);
      uv.setXY(1, r.u1, r.v1);
      uv.setXY(2, r.u0, r.v0);
      uv.setXY(3, r.u1, r.v0);
    }
    g.rotateY(Math.atan2(fu, -fv));
    g.translate(u, y, -v);
    this.push(g, color);
  }
  merge() {
    if (!this.list.length) return null;
    const g = mergeGeometries(this.list);
    this.list = [];
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------ textures

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Shelf-packed sign atlas. */
class Atlas {
  constructor(w = 2048, h = 1024) {
    this.c = canvas(w, h);
    this.g = this.c.getContext("2d");
    this.x = 0;
    this.y = 0;
    this.row = 0;
  }
  add(w, h, draw) {
    if (this.x + w > this.c.width) {
      this.x = 0;
      this.y += this.row + 2;
      this.row = 0;
    }
    const x = this.x;
    const y = this.y;
    this.x += w + 2;
    this.row = Math.max(this.row, h);
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.beginPath();
    g.rect(0, 0, w, h);
    g.clip();
    draw(g, w, h);
    g.restore();
    const W = this.c.width;
    const H = this.c.height;
    return { u0: (x + 0.5) / W, u1: (x + w - 0.5) / W, v0: 1 - (y + h - 0.5) / H, v1: 1 - (y + 0.5) / H };
  }
  texture() {
    const t = new THREE.CanvasTexture(this.c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.generateMipmaps = true;
    return t;
  }
}

function fitText(g, text, maxW, size, weight = 700) {
  let s = size;
  g.font = `${weight} ${s}px ${FONT}`;
  while (g.measureText(text).width > maxW && s > 8) {
    s -= 2;
    g.font = `${weight} ${s}px ${FONT}`;
  }
  return s;
}

function panel(g, w, h, bg, border = "#ffffff", bw = 8) {
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = border;
  g.lineWidth = bw;
  g.strokeRect(bw * 1.5, bw * 1.5, w - bw * 3, h - bw * 3);
}

const BLUE = "#1452a0";

function tollBadge(g, x, y, s) {
  g.fillStyle = "#f7c600";
  g.fillRect(x, y, s * 2.4, s);
  g.fillStyle = "#111";
  g.font = `800 ${Math.round(s * 0.72)}px ${FONT}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("TOLL", x + s * 1.2, y + s * 0.54);
}

function drawDistance(name, dist) {
  return (g, w, h) => {
    panel(g, w, h, BLUE);
    tollBadge(g, 30, 30, 50);
    g.fillStyle = "#fff";
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    fitText(g, name, w - 200, 64);
    g.fillText(name, 170, 76);
    g.font = `600 44px ${FONT}`;
    g.fillText("Toll Plaza", 40, 150);
    g.textAlign = "right";
    g.font = `800 92px ${FONT}`;
    g.fillText(dist, w - 34, h - 34);
  };
}

function drawTariff(name) {
  return (g, w, h) => {
    panel(g, w, h, BLUE);
    tollBadge(g, 28, 26, 42);
    g.fillStyle = "#fff";
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    fitText(g, `${name} Toll Plaza`, w - 170, 42);
    g.fillText(`${name} Toll Plaza`, 142, 62);
    g.font = `600 26px ${FONT}`;
    g.fillStyle = "#cfe0f5";
    g.fillText("Toll tariffs per passage", 34, 112);
    let y = 160;
    for (const [cls, label, thebe] of L.TARIFF_ROWS) {
      g.fillStyle = "#fff";
      g.fillRect(34, y - 30, 44, 40);
      g.fillStyle = BLUE;
      g.font = `800 30px ${FONT}`;
      g.textAlign = "center";
      g.fillText(cls, 56, y + 1);
      g.textAlign = "left";
      g.fillStyle = "#fff";
      g.font = `600 27px ${FONT}`;
      g.fillText(label, 94, y);
      g.textAlign = "right";
      g.font = `800 30px ${FONT}`;
      g.fillText(`P ${(thebe / 100).toFixed(2)}`, w - 34, y);
      g.textAlign = "left";
      y += 54;
    }
    g.fillStyle = "#f7c600";
    g.fillRect(30, h - 64, w - 60, 40);
    g.fillStyle = "#111";
    g.font = `800 28px ${FONT}`;
    g.textAlign = "center";
    g.fillText("Tags  ·  Cash  ·  Cards", w / 2, h - 34);
  };
}

function drawSpeed(n) {
  return (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.beginPath();
    g.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2);
    g.fillStyle = "#d8261c";
    g.fill();
    g.beginPath();
    g.arc(w / 2, h / 2, w / 2 - 18, 0, Math.PI * 2);
    g.fillStyle = "#fff";
    g.fill();
    g.fillStyle = "#111";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, String(n), w - 52, 70, 800);
    g.fillText(String(n), w / 2, h / 2 + 4);
  };
}

function drawLaneNumber(n) {
  return (g, w, h) => {
    g.fillStyle = "#101418";
    g.fillRect(0, 0, w, h);
    g.strokeStyle = "#fff";
    g.lineWidth = 6;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = `800 ${Math.round(h * 0.62)}px ${FONT}`;
    g.fillText(String(n), w / 2, h / 2 + 3);
  };
}

const TYPE_STYLE = {
  heavy: { bg: "#f7c600", fg: "#111", text: "HEAVY VEHICLES" },
  mixed: { bg: "#1d7a3e", fg: "#fff", text: "TAG · CASH · CARD" },
  etag: { bg: "#e8730c", fg: "#fff", text: "e-tag ONLY" },
};

function drawLaneType(type) {
  const s = TYPE_STYLE[type] ?? TYPE_STYLE.mixed;
  return (g, w, h) => {
    g.fillStyle = s.bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = s.fg;
    g.lineWidth = 4;
    g.strokeRect(6, 6, w - 12, h - 12);
    g.fillStyle = s.fg;
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, s.text, w - 30, Math.round(h * 0.5), 800);
    g.fillText(s.text, w / 2, h / 2 + 2);
  };
}

function drawRoofName(name) {
  return (g, w, h) => {
    g.fillStyle = "#0f3d73";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#f7c600";
    g.fillRect(0, h - 12, w, 12);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    const text = `${name.toUpperCase()} TOLL PLAZA`;
    fitText(g, text, w - 60, Math.round(h * 0.6), 800);
    g.fillText(text, w / 2, h / 2 - 2);
  };
}

function drawAdmin(name) {
  return (g, w, h) => {
    g.fillStyle = "#0f3d73";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#fff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, `${name} Plaza Office`, w - 30, Math.round(h * 0.55), 700);
    g.fillText(`${name} Plaza Office`, w / 2, h / 2);
  };
}

let shared = null;
function sharedAssets() {
  if (shared) return shared;
  // yellow and black chevrons for the crash cushions
  const cc = canvas(128, 128);
  const cg = cc.getContext("2d");
  cg.fillStyle = "#111";
  cg.fillRect(0, 0, 128, 128);
  cg.fillStyle = "#f7c600";
  for (let k = -4; k < 6; k++) {
    cg.beginPath();
    cg.moveTo(k * 32, 0);
    cg.lineTo(k * 32 + 16, 0);
    cg.lineTo(k * 32 + 16 + 64, 64);
    cg.lineTo(k * 32 + 16, 128);
    cg.lineTo(k * 32, 128);
    cg.lineTo(k * 32 + 64, 64);
    cg.closePath();
    cg.fill();
  }
  const chevTex = new THREE.CanvasTexture(cc);
  chevTex.colorSpace = THREE.SRGBColorSpace;

  // lane signals: green arrow and red cross
  const sig = (draw) => {
    const c = canvas(128, 128);
    const g = c.getContext("2d");
    g.fillStyle = "#06080a";
    g.fillRect(0, 0, 128, 128);
    draw(g);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const arrowTex = sig((g) => {
    g.fillStyle = "#39ff7a";
    g.beginPath();
    g.moveTo(64, 112);
    g.lineTo(22, 64);
    g.lineTo(48, 64);
    g.lineTo(48, 16);
    g.lineTo(80, 16);
    g.lineTo(80, 64);
    g.lineTo(106, 64);
    g.closePath();
    g.fill();
  });
  const crossTex = sig((g) => {
    g.strokeStyle = "#ff3b2f";
    g.lineWidth = 20;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(28, 28);
    g.lineTo(100, 100);
    g.moveTo(100, 28);
    g.lineTo(28, 100);
    g.stroke();
  });

  // ground glow
  const gc = canvas(128, 128);
  const gx = gc.getContext("2d");
  const grad = gx.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,240,210,0.95)");
  grad.addColorStop(0.5, "rgba(255,232,190,0.45)");
  grad.addColorStop(1, "rgba(255,232,190,0)");
  gx.fillStyle = grad;
  gx.fillRect(0, 0, 128, 128);
  const glowTex = new THREE.CanvasTexture(gc);
  glowTex.colorSpace = THREE.SRGBColorSpace;

  const off = (f) => ({ polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: f });
  shared = {
    body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.1 }),
    chev: new THREE.MeshStandardMaterial({ map: chevTex, roughness: 0.6 }),
    lights: new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    apron: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, side: THREE.DoubleSide, ...off(-6) }),
    marks: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide, ...off(-9) }),
    glow: new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    arrow: new THREE.MeshBasicMaterial({ map: arrowTex, toneMapped: false }),
    cross: new THREE.MeshBasicMaterial({ map: crossTex, toneMapped: false }),
    lamp: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
  };
  return shared;
}

// ------------------------------------------------------------ fare displays

const FARE_CELL = [256, 96];
class FareBoard {
  constructor(lanes) {
    this.cols = 2;
    this.rows = Math.ceil(lanes.length / this.cols);
    this.c = canvas(FARE_CELL[0] * this.cols, FARE_CELL[1] * this.rows);
    this.g = this.c.getContext("2d");
    this.tex = new THREE.CanvasTexture(this.c);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.cells = new Map();
    lanes.forEach((l, i) => {
      const cx = (i % this.cols) * FARE_CELL[0];
      const cy = Math.floor(i / this.cols) * FARE_CELL[1];
      const W = this.c.width;
      const H = this.c.height;
      this.cells.set(l.key, { x: cx, y: cy, r: { u0: (cx + 1) / W, u1: (cx + FARE_CELL[0] - 1) / W, v0: 1 - (cy + FARE_CELL[1] - 1) / H, v1: 1 - (cy + 1) / H }, text: null });
    });
  }
  draw(key, text, kind) {
    const cell = this.cells.get(key);
    if (!cell || (cell.text === text && cell.kind === kind)) return;
    cell.text = text;
    cell.kind = kind;
    const g = this.g;
    const [w, h] = FARE_CELL;
    g.save();
    g.translate(cell.x, cell.y);
    g.fillStyle = "#050607";
    g.fillRect(0, 0, w, h);
    g.fillStyle = kind === "bad" ? "#ff4a3d" : kind === "ok" ? "#4dff8a" : kind === "idle" ? "#7d6a2a" : "#ffc23a";
    g.textAlign = "center";
    g.textBaseline = "middle";
    fitText(g, text, w - 20, kind === "fare" ? 60 : 44, 800);
    g.fillText(text, w / 2, h / 2 + 2);
    g.restore();
    this.tex.needsUpdate = true;
  }
}

// ------------------------------------------------------------ one plaza

function buildPlaza(p, road, graph, F, A) {
  const group = new THREE.Group();
  group.position.set(F.x(p.x), 0, F.z(p.y));
  group.rotation.y = p.heading; // local x = u (northbound), local z = -v
  group.updateMatrixWorld();

  const body = new Parts();
  const chev = new Parts();
  const lights = new Parts();
  const signs = new Parts();
  const apron = new Parts();
  const marks = new Parts();
  const glow = new Parts();
  const fareParts = new Parts();
  const atlas = new Atlas(2048, 1024);
  const lanes = p.lanes;
  const fare = new FareBoard(lanes);

  const CONCRETE = 0xb4b2aa;
  const ASPHALT = 0x3c3e42;
  const PAVE = 0x8c8b86;
  const WHITE = 0xe9e9e2;
  const YELLOW = 0xe2b33c;
  const STEEL = 0xc9ced4;
  const DARK = 0x23272d;
  const TEAL = 0x16707f;
  const CREAM = 0xefebe1;

  // ------------------------------------------------ apron
  const step = 5;
  for (const dir of ["N", "S"]) {
    for (let t = L.ZONE[0]; t < L.ZONE[1]; t += step) {
      const t1 = Math.min(L.ZONE[1], t + step);
      const [a0, b0] = L.apronEdges(p, dir, t);
      const [a1, b1] = L.apronEdges(p, dir, t1);
      if (Math.abs(b0 - a0) < 0.1 && Math.abs(b1 - a1) < 0.1) continue;
      const u0 = L.tToU(dir, t);
      const u1 = L.tToU(dir, t1);
      const tm = (t + t1) / 2;
      const col = tm > L.ISLAND_T0 - 8 && tm < L.ISLAND_T1 + 6 ? PAVE : ASPHALT;
      apron.flat([[u0, a0], [u1, a1], [u1, b1], [u0, b0]], Y_APRON, col);
    }
  }

  // ------------------------------------------------ markings
  const line = (dir, tA, tB, vAt, width, color, dash = 0) => {
    const pts = [];
    for (let t = tA; t <= tB + 0.01; t += 2) pts.push(t);
    for (let i = 1; i < pts.length; i++) {
      const ta = pts[i - 1];
      const tb = pts[i];
      if (dash && ((Math.floor(ta / dash) % 2) + 2) % 2 === 1) continue;
      const va = vAt(ta);
      const vb = vAt(tb);
      if (va == null || vb == null) continue;
      const ua = L.tToU(dir, ta);
      const ub = L.tToU(dir, tb);
      marks.flat([[ua, va - width / 2], [ub, vb - width / 2], [ub, vb + width / 2], [ua, va + width / 2]], Y_MARK, color);
    }
  };
  for (const dir of ["N", "S"]) {
    const ls = lanes.filter((l) => l.dir === dir).sort((a, b) => a.v - b.v);
    // lane dividers fanning out of the carriageway, solid where the lanes are full width
    for (let i = 1; i < ls.length; i++) {
      const mid = (t) => (L.laneV(p, ls[i - 1], t) + L.laneV(p, ls[i], t)) / 2;
      const tStart = L.FLARE_IN[0] + 70;
      line(dir, tStart, L.FLARE_IN[1] - 10, mid, 0.14, WHITE, 3);
      line(dir, L.FLARE_IN[1] - 10, L.ISLAND_T0 - 2.5, mid, 0.16, WHITE);
      line(dir, L.ISLAND_T1 + 2, L.FLARE_OUT[0] + 40, mid, 0.16, WHITE);
      line(dir, L.FLARE_OUT[0] + 40, L.FLARE_OUT[1] - 60, mid, 0.14, WHITE, 3);
    }
    // edges: white on the outside, yellow by the median
    const outer = (t) => L.apronEdges(p, dir, t)[1] + (dir === "N" ? -0.35 : 0.35);
    const inner = (t) => L.apronEdges(p, dir, t)[0] + (dir === "N" ? 0.35 : -0.35);
    line(dir, L.ZONE[0], L.ISLAND_T0 - 3, outer, 0.15, WHITE);
    line(dir, L.ISLAND_T1 + 2, L.ZONE[1], outer, 0.15, WHITE);
    line(dir, L.ZONE[0], L.ISLAND_T0 - 3, inner, 0.13, YELLOW);
    line(dir, L.ISLAND_T1 + 2, L.ZONE[1], inner, 0.13, YELLOW);
    // stop lines and axle sensors in each lane
    for (const l of ls) {
      const across = (t, wdt, color, y = Y_MARK) => {
        const ua = L.tToU(dir, t - wdt / 2);
        const ub = L.tToU(dir, t + wdt / 2);
        marks.flat([[ua, l.v - l.w / 2 + 0.15], [ub, l.v - l.w / 2 + 0.15], [ub, l.v + l.w / 2 - 0.15], [ua, l.v + l.w / 2 - 0.15]], y, color);
      };
      across(L.BOOM_T + 0.35, 0.35, WHITE);
      across(L.BOOTH_T - 4.2, 0.3, 0x15171a);
      across(L.BOOTH_T - 2.6, 0.3, 0x15171a);
      across(L.BOOTH_T - 9, 0.12, 0x2a2c30);
      across(L.BOOTH_T - 11, 0.12, 0x2a2c30);
      // a painted lane-type word on the approach
      across(-60, 0.5, l.type === "etag" ? 0xe8730c : l.type === "heavy" ? YELLOW : WHITE);
    }
  }

  // ------------------------------------------------ islands, booths, booms
  const islandVs = new Set();
  const signalSlots = [];
  const boomSlots = [];
  const lampSlots = [];
  for (const l of lanes) {
    const dir = l.dir;
    const side = dir === "N" ? 1 : -1; // +v is the lane side of the island for N
    const iv = l.islandV;
    const uMid = L.tToU(dir, (L.ISLAND_T0 + L.ISLAND_T1) / 2);
    const len = L.ISLAND_T1 - L.ISLAND_T0;
    body.box(uMid, ISLAND_H / 2, iv, len, ISLAND_H, L.ISLAND_W - 0.25, CONCRETE);
    body.box(L.tToU(dir, L.ISLAND_T0 + 2), ISLAND_H + 0.01, iv, 4, 0.02, L.ISLAND_W - 0.3, YELLOW);
    islandVs.add(Math.round(iv * 10));
    // crash cushion on the nose
    chev.box(L.tToU(dir, L.ISLAND_T0 - 1.3), 0.55, iv, 2.6, 1.0, 1.1, 0xffffff);
    // booth
    const bu = L.tToU(dir, L.BOOTH_T);
    body.box(bu, ISLAND_H + 0.15, iv, 3.0, 0.3, 1.9, 0x9a978e);
    body.box(bu, ISLAND_H + 0.3 + 0.55, iv, 2.6, 1.1, 1.7, CREAM);
    lights.box(bu, ISLAND_H + 0.3 + 1.1 + 0.5, iv, 2.62, 1.0, 1.72, 0xffdca0);
    body.box(bu, ISLAND_H + 0.3 + 2.1 + 0.25, iv, 2.6, 0.5, 1.7, CREAM);
    body.box(bu, ISLAND_H + 0.3 + 2.6 + 0.1, iv, 3.0, 0.2, 2.0, TEAL);
    // boom cabinet, arm pivot, traffic light and fare display on the lane side
    const ev = iv + side * (L.ISLAND_W / 2 - 0.35);
    const boomU = L.tToU(dir, L.BOOM_T);
    body.box(boomU, ISLAND_H + 0.5, ev, 0.45, 1.0, 0.45, 0xe8b10c);
    boomSlots.push({ key: l.key, u: boomU, v: ev, y: ISLAND_H + 0.9, side, len: l.w + 0.05 });
    const tlT = L.BOOM_T + 1.2;
    const tlU = L.tToU(dir, tlT);
    body.box(tlU, ISLAND_H + 1.1, ev, 0.1, 2.2, 0.1, DARK);
    body.box(tlU, ISLAND_H + 2.25, ev, 0.28, 0.55, 0.28, DARK);
    lampSlots.push({ key: l.key, u: L.tToU(dir, tlT - 0.15), v: ev, y: ISLAND_H + 2.35 });
    const fdT = L.BOOM_T - 2.2;
    const fdU = L.tToU(dir, fdT);
    body.box(fdU, ISLAND_H + 0.7, ev, 0.12, 1.4, 0.12, DARK);
    body.box(L.tToU(dir, fdT + 0.06), ISLAND_H + 1.55, ev, 0.1, 0.62, 1.1, DARK);
    const cell = fare.cells.get(l.key);
    fareParts.quad(L.tToU(dir, fdT - 0.01), ISLAND_H + 1.55, ev, 1.0, 0.5, dir === "N" ? -1 : 1, 0, cell.r);
    // canopy hardware over the lane: tag antenna and an enforcement camera
    const antU = L.tToU(dir, -5.5);
    body.box(antU, CANOPY_Y - 0.25, l.v, 0.12, 0.5, 0.7, 0x5d636b);
    body.box(antU, CANOPY_Y - 0.03, l.v, 0.06, 0.06, 0.06, DARK);
    const camU = L.tToU(dir, -L.CANOPY_U - 0.5);
    body.box(camU, CANOPY_Y + 1.85, l.v + 0.9 * side, 0.55, 0.28, 0.28, DARK);
    // lane signs on the approach face of the canopy
    const faceU = L.tToU(dir, -L.CANOPY_U - 0.23);
    const fu = dir === "N" ? -1 : 1;
    const leftV = side; // the driver's left, in v
    const num = atlas.add(96, 96, drawLaneNumber(l.number));
    signs.quad(faceU, CANOPY_Y + 0.75, l.v + 0.62 * leftV, 0.9, 0.9, fu, 0, num);
    signalSlots.push({ key: l.key, u: L.tToU(dir, -L.CANOPY_U - 0.24), v: l.v - 0.62 * leftV, y: CANOPY_Y + 0.75, fu });
    const type = atlas.add(320, 80, drawLaneType(l.type));
    const hangU = L.tToU(dir, -L.CANOPY_U + 0.15);
    signs.quad(L.tToU(dir, -L.CANOPY_U + 0.1), CANOPY_Y - 0.55, l.v, 2.8, 0.7, fu, 0, type);
    body.box(hangU, CANOPY_Y - 0.55, l.v, 0.06, 0.74, 2.84, DARK);
    body.box(hangU, CANOPY_Y - 0.1, l.v - 1, 0.05, 0.3, 0.05, DARK);
    body.box(hangU, CANOPY_Y - 0.1, l.v + 1, 0.05, 0.3, 0.05, DARK);
  }
  // outer kerbs
  for (const dir of ["N", "S"]) {
    const ls = lanes.filter((l) => l.dir === dir);
    const edge = dir === "N" ? Math.max(...ls.map((l) => l.v + l.w / 2)) : Math.min(...ls.map((l) => l.v - l.w / 2));
    const kv = edge + (dir === "N" ? 1 : -1) * (L.KERB_W / 2);
    const uMid = L.tToU(dir, (L.ISLAND_T0 + L.ISLAND_T1) / 2);
    body.box(uMid, ISLAND_H / 2, kv, L.ISLAND_T1 - L.ISLAND_T0, ISLAND_H, L.KERB_W - 0.2, CONCRETE);
    chev.box(L.tToU(dir, L.ISLAND_T0 - 1.3), 0.55, kv, 2.6, 1.0, 1.0, 0xffffff);
    islandVs.add(Math.round(kv * 10));
  }

  // ------------------------------------------------ canopy
  const hw = p.halfWidth;
  const CU = L.CANOPY_U;
  for (const iv10 of islandVs) {
    const v = iv10 / 10;
    for (const u of [-CU + 1.4, CU - 1.4]) body.box(u, (ISLAND_H + CANOPY_Y) / 2, v, 0.5, CANOPY_Y - ISLAND_H, 0.5, STEEL);
  }
  body.box(0, CANOPY_Y + 0.3, 0, CU * 2, 0.6, hw * 2, 0xdedcd6);
  for (const s of [-1, 1]) {
    body.box(s * CU, CANOPY_Y + 0.85, 0, 0.4, 1.7, hw * 2 + 0.4, 0xf4f3ef);
    body.box(s * (CU + 0.01), CANOPY_Y + 0.08, 0, 0.42, 0.22, hw * 2 + 0.42, TEAL);
  }
  body.box(0, CANOPY_Y + 1.0, 0, CU * 2 - 0.6, 1.0, hw * 2 - 0.4, 0xc9c7c0);
  // the plaza name on the roof, readable from both approaches
  const roof = atlas.add(1536, 160, drawRoofName(p.name));
  const rw = Math.min(hw * 1.5, 34);
  const rh = rw * (160 / 1536);
  const ry = CANOPY_Y + 1.75 + rh / 2;
  body.box(0, ry, 0, 0.4, rh + 0.2, rw + 0.4, 0x0f3d73);
  body.box(0, CANOPY_Y + 1.6, -rw * 0.35, 0.3, 0.4, 0.3, DARK);
  body.box(0, CANOPY_Y + 1.6, rw * 0.35, 0.3, 0.4, 0.3, DARK);
  signs.quad(-0.21, ry, 0, rw, rh, -1, 0, roof);
  signs.quad(0.21, ry, 0, rw, rh, 1, 0, roof);
  // light panels under the slab
  for (const l of lanes) {
    for (const u of [-3.4, 0, 3.4]) lights.box(u, CANOPY_Y - 0.02, l.v, 1.6, 0.05, 0.5, 0xfff1d2);
  }
  glow.flat(
    [
      [-CU - 10, -hw - 6],
      [CU + 10, -hw - 6],
      [CU + 10, hw + 6],
      [-CU - 10, hw + 6],
    ],
    0.22,
    0xffffff,
  );
  // glow plane needs uv 0..1 across
  {
    const g = glow.list[glow.list.length - 1];
    g.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  }

  // ------------------------------------------------ high masts
  const masts = [];
  for (const su of [-1, 1]) for (const sv of [-1, 1]) masts.push([su * 62, sv * (hw + 9)]);
  for (const [u, v] of masts) {
    body.cyl(u, 12.5, v, 0.42, 0.22, 25, 0x9da3aa, 8);
    body.box(u, 0.4, v, 1.4, 0.8, 1.4, 0x8d8b85);
    body.box(u, 25.2, v, 3.2, 0.35, 3.2, DARK);
    lights.box(u, 24.95, v, 2.8, 0.12, 2.8, 0xfff0cc);
    const k = glow.list.length;
    glow.flat(
      [
        [u - 34, v - 34],
        [u + 34, v - 34],
        [u + 34, v + 34],
        [u - 34, v + 34],
      ],
      0.2,
      0xffffff,
    );
    glow.list[k].setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  }

  // ------------------------------------------------ admin building and car park
  {
    const u0 = 46;
    const v0 = hw + 24;
    body.box(u0, 2.3, v0, 24, 4.6, 11, CREAM);
    body.box(u0, 4.75, v0, 24.6, 0.3, 11.6, TEAL);
    lights.box(u0, 2.6, v0, 24.04, 1.1, 11.04, 0xffdca0);
    body.box(u0 - 13, 1.6, v0 - 3, 2, 3.2, 3, 0xd8d3c6);
    const sign = atlas.add(512, 64, drawAdmin(p.name));
    signs.quad(u0, 4.0, v0 - 5.53, 9, 9 * (64 / 512), 0, -1, sign);
    // car park and access road to the plaza apron
    apron.flat([[u0 - 16, v0 - 18], [u0 + 16, v0 - 18], [u0 + 16, v0 - 6.5], [u0 - 16, v0 - 6.5]], 0.09, ASPHALT);
    apron.flat([[u0 - 3, hw - 1], [u0 + 3, hw - 1], [u0 + 3, v0 - 17], [u0 - 3, v0 - 17]], 0.09, ASPHALT);
    const carCols = [0xf2f2f0, 0x1f2124, 0xc3c7cc, 0x9e2a2b, 0x2d4f8b, 0xf2f2f0];
    for (let i = 0; i < 6; i++) {
      const cu = u0 - 13 + i * 3.1;
      const cv = v0 - 15;
      body.box(cu, 0.62, cv, 1.8, 0.7, 4.4, carCols[i]);
      body.box(cu, 1.2, cv + 0.2, 1.6, 0.5, 2.2, 0x1a222c);
    }
    // perimeter fence
    for (const [a, b] of [
      [[u0 - 18, v0 - 19], [u0 + 18, v0 - 19]],
      [[u0 + 18, v0 - 19], [u0 + 18, v0 + 8]],
      [[u0 + 18, v0 + 8], [u0 - 18, v0 + 8]],
      [[u0 - 18, v0 + 8], [u0 - 18, v0 - 19]],
    ]) {
      const du = b[0] - a[0];
      const dv = b[1] - a[1];
      const len = Math.hypot(du, dv);
      if (Math.abs(du) > Math.abs(dv)) body.box((a[0] + b[0]) / 2, 0.9, a[1], len, 1.8, 0.05, 0x9ea4a8);
      else body.box(a[0], 0.9, (a[1] + b[1]) / 2, 0.05, 1.8, len, 0x9ea4a8);
    }
  }

  // ------------------------------------------------ approach signage and rumble strips
  const signCache = new Map();
  const signRect = (key, w, h, draw) => {
    if (!signCache.has(key)) signCache.set(key, atlas.add(w, h, draw));
    return signCache.get(key);
  };
  const place = (dir, dist, offset) => {
    const at = L.walkRoad(graph, p, dir, -dist);
    if (!at) return null;
    const nlx = -at.ty;
    const nly = at.tx;
    const X = at.x + nlx * (at.w / 2 + offset);
    const Y = at.y + nly * (at.w / 2 + offset);
    const { u, v } = L.toUV(p, X, Y);
    // face oncoming traffic
    const fu = -(at.tx * p.ux + at.ty * p.uy);
    const fv = -(at.tx * p.nx + at.ty * p.ny);
    return { u, v, fu, fv, at };
  };
  const board = (s, w, h, bottom, rect) => {
    const back = 0.08;
    const bu = s.u - s.fu * back;
    const bv = s.v - s.fv * back;
    const yaw = Math.atan2(s.fu, -s.fv);
    // posts and backing plate
    for (const k of [-0.35, 0.35]) {
      const pu = bu + s.fv * k * w * -1;
      const pv = bv + s.fu * k * w;
      body.box(pu, (bottom + h) / 2, pv, 0.12, bottom + h, 0.12, 0x8e959c);
    }
    const g = new THREE.BoxGeometry(w + 0.1, h + 0.1, 0.08);
    g.rotateY(yaw);
    g.translate(bu, bottom + h / 2, -bv);
    body.push(g, 0x7d848b);
    signs.quad(s.u, bottom + h / 2, s.v, w, h, s.fu, s.fv, rect);
  };
  for (const dir of ["N", "S"]) {
    for (const [dist, label] of [
      [2000, "2 km"],
      [1000, "1 km"],
      [500, "500 m"],
    ]) {
      const s = place(dir, dist, 4.5);
      if (s) board(s, 4.6, 2.3, 2.2, signRect(`d${label}`, 512, 256, drawDistance(p.name, label)));
    }
    const t = place(dir, 760, 4.5);
    if (t) board(t, 3.8, 3.3, 1.8, signRect("tariff", 512, 448, drawTariff(p.name)));
    for (const [dist, kmh] of [
      [1400, 120],
      [880, 80],
      [430, 60],
      [215, 40],
    ]) {
      const s = place(dir, dist, 3.2);
      if (!s) continue;
      const r = signRect(`s${kmh}`, 160, 160, drawSpeed(kmh));
      body.box(s.u - s.fu * 0.06, 1.3, s.v - s.fv * 0.06, 0.1, 2.6, 0.1, 0x8e959c);
      signs.quad(s.u, 2.75, s.v, 1.2, 1.2, s.fu, s.fv, r);
    }
    // rumble strips: groups of raised bars across the carriageway
    for (const dist of [640, 470, 330]) {
      for (let b = 0; b < 6; b++) {
        const at = L.walkRoad(graph, p, dir, -(dist - b * 1.1));
        if (!at) continue;
        const nlx = -at.ty;
        const nly = at.tx;
        const left = at.w / 2 - 0.2;
        const right = -(at.w / 2 + (Math.max(1, at.n) - 1) * at.w) + 0.2;
        const c = [];
        for (const [off, along] of [
          [left, -0.18],
          [left, 0.18],
          [right, 0.18],
          [right, -0.18],
        ]) {
          const X = at.x + nlx * off + at.tx * along;
          const Y = at.y + nly * off + at.ty * along;
          const q = L.toUV(p, X, Y);
          c.push([q.u, q.v]);
        }
        marks.flat(c, 0.1, 0xdedbd0);
      }
    }
  }

  // ------------------------------------------------ meshes
  const add = (parts, mat, opts = {}) => {
    const geo = parts.merge();
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = !!opts.cast;
    m.receiveShadow = !!opts.receive;
    if (opts.order != null) m.renderOrder = opts.order;
    group.add(m);
    return m;
  };
  const signTex = atlas.texture();
  const signMat = new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 0.1, roughness: 0.5, alphaTest: 0.5 });
  const fareMat = new THREE.MeshBasicMaterial({ map: fare.tex, toneMapped: false });
  add(apron, A.apron, { receive: true });
  add(marks, A.marks, { receive: true });
  add(body, A.body, { cast: true, receive: true });
  add(chev, A.chev, { cast: true });
  add(lights, A.lights);
  add(signs, signMat);
  add(fareParts, fareMat);
  add(glow, A.glow, { order: 3 });

  // ------------------------------------------------ moving parts
  const n = lanes.length;
  const armParts = [];
  const segs = 7;
  for (let i = 0; i < segs; i++) {
    const g = new THREE.BoxGeometry(1 / segs, 0.11, 0.11);
    g.translate((i + 0.5) / segs, 0, 0);
    armParts.push(prep(g, i % 2 ? 0xffffff : 0xd8261c));
  }
  const armGeo = mergeGeometries(armParts);
  const booms = new THREE.InstancedMesh(armGeo, A.body, n);
  booms.castShadow = true;
  booms.frustumCulled = false;
  group.add(booms);
  const sigGeo = new THREE.PlaneGeometry(0.85, 0.85);
  const arrows = new THREE.InstancedMesh(sigGeo, A.arrow, n);
  const crosses = new THREE.InstancedMesh(sigGeo, A.cross, n);
  for (const m of [arrows, crosses]) {
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }
  const lampGeo = new THREE.SphereGeometry(0.1, 8, 6);
  const lamps = new THREE.InstancedMesh(lampGeo, A.lamp, n);
  lamps.frustumCulled = false;
  lamps.setColorAt(0, new THREE.Color(1, 0, 0));
  group.add(lamps);

  const state = new Map(); // key -> { up, target, open, local, feedUntil, fareUntil }
  for (const l of lanes) state.set(l.key, { angle: 0, open: true, localUp: false, feedUp: false, feedUntil: 0, fareStage: null, fareUntil: 0 });

  const m4 = new THREE.Matrix4();
  const tq = new THREE.Quaternion();
  const ts = new THREE.Vector3();
  const tp = new THREE.Vector3();
  const e = new THREE.Euler();
  const colGreen = new THREE.Color(0x30ff6a);
  const colRed = new THREE.Color(0xff2a1a);
  const colOff = new THREE.Color(0x401010);

  function placeSignals() {
    signalSlots.forEach((s, i) => {
      const open = state.get(s.key).open;
      e.set(0, Math.atan2(s.fu, 0), 0);
      tq.setFromEuler(e);
      tp.set(s.u, s.y, 0);
      tp.z = -s.v;
      ts.setScalar(open ? 1 : 0.0001);
      m4.compose(tp, tq, ts);
      arrows.setMatrixAt(i, m4);
      ts.setScalar(open ? 0.0001 : 1);
      m4.compose(tp, tq, ts);
      crosses.setMatrixAt(i, m4);
    });
    arrows.instanceMatrix.needsUpdate = true;
    crosses.instanceMatrix.needsUpdate = true;
  }
  placeSignals();

  const rotY = new THREE.Matrix4();
  const rotZ = new THREE.Matrix4();
  const scl = new THREE.Matrix4();
  function placeBooms(dt) {
    boomSlots.forEach((b, i) => {
      const st = state.get(b.key);
      const up = st.open && (st.localUp || st.feedUp);
      const target = up ? Math.PI * 0.47 : 0;
      const speed = up ? 1.9 : 1.2;
      st.angle += Math.sign(target - st.angle) * Math.min(Math.abs(target - st.angle), speed * dt);
      m4.makeTranslation(b.u, b.y, -b.v);
      rotY.makeRotationY(b.side > 0 ? Math.PI / 2 : -Math.PI / 2);
      rotZ.makeRotationZ(st.angle);
      scl.makeScale(b.len, 1, 1);
      m4.multiply(rotY).multiply(rotZ).multiply(scl);
      booms.setMatrixAt(i, m4);
      // the booth light is green while the boom is up (or lifting)
      const c = !st.open ? colOff : up || st.angle > 0.3 ? colGreen : colRed;
      lamps.setColorAt(i, c);
      const ls = lampSlots[i];
      m4.makeTranslation(ls.u, ls.y, -ls.v);
      lamps.setMatrixAt(i, m4);
    });
    booms.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  }
  placeBooms(0);

  for (const l of lanes) fare.draw(l.key, "Welcome", "idle");

  const label = new CSS2DObject(Object.assign(document.createElement("div"), { className: "lbl lbl-gantry", textContent: `${p.name} Toll Plaza · km ${p.km ?? ""}` }));
  label.position.set(0, 16, 0);
  group.add(label);

  return {
    ...p,
    group,
    label,
    pos: group.position.clone(),
    state,
    flash: 0,
    setOpen(open) {
      let changed = false;
      for (const l of lanes) {
        const want = (open[l.dir] ?? []).includes(l.idx);
        const st = state.get(l.key);
        if (st.open !== want) {
          st.open = want;
          changed = true;
          if (!want) fare.draw(l.key, "Lane closed", "bad");
          else fare.draw(l.key, "Welcome", "idle");
        }
      }
      if (changed) placeSignals();
    },
    setFare(key, text, kind, holdMs, now) {
      const st = state.get(key);
      if (!st) return;
      fare.draw(key, text, kind);
      st.fareUntil = now + holdMs;
    },
    queueFare(key, stages, now) {
      const st = state.get(key);
      if (!st) return;
      st.fareStages = stages.map(([text, kind, ms]) => ({ text, kind, ms }));
      st.fareUntil = now;
    },
    tick(dt, now) {
      placeBooms(dt);
      for (const l of lanes) {
        const st = state.get(l.key);
        if (st.feedUp && now > st.feedUntil) st.feedUp = false;
        if (now >= st.fareUntil) {
          const next = st.fareStages?.shift();
          if (next) {
            fare.draw(l.key, next.text, next.kind);
            st.fareUntil = now + next.ms;
          } else if (st.fareUntil) {
            st.fareUntil = 0;
            fare.draw(l.key, st.open ? "Welcome" : "Lane closed", st.open ? "idle" : "bad");
          }
        }
      }
    },
    signMat,
  };
}

/** Builds every plaza. Returns { list, byId, update(dt, now, night) }. */
export function buildPlazas(road, scene, F) {
  const A = sharedAssets();
  const plazas = L.plazasFrom(road);
  const graph = L.roadGraph(road);
  const list = plazas.map((p) => {
    const built = buildPlaza(p, road, graph, F, A);
    scene.add(built.group);
    return built;
  });
  const byId = new Map(list.map((p) => [p.id, p]));
  return {
    list,
    byId,
    update(dt, now, night) {
      A.lights.color.setScalar(0.42 + 0.58 * night);
      A.glow.opacity = night * 0.8;
      for (const p of list) {
        p.signMat.emissiveIntensity = 0.06 + 0.5 * night;
        p.tick(dt, now);
      }
    },
  };
}
