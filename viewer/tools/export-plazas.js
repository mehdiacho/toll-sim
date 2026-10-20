// Runs the browser's own plaza builder (src/plazas.js) and hands the result to
// scripts/export-plazas.mjs, so the Unreal client draws exactly these plazas
// instead of a hand port. Geometry stays in each plaza's local three.js frame:
// x = u (northbound), y = up, z = -v, metres.

import * as THREE from "three";
import { buildPlazas } from "../src/plazas.js";
import * as L from "../src/plaza-layout.js";

const b64 = (typed) => {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

function geometry(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const out = { count: g.attributes.position.count, position: b64(new Float32Array(g.attributes.position.array)) };
  if (g.attributes.normal) out.normal = b64(new Float32Array(g.attributes.normal.array));
  if (g.attributes.color) out.color = b64(new Float32Array(g.attributes.color.array));
  if (g.attributes.uv) out.uv = b64(new Float32Array(g.attributes.uv.array));
  return out;
}

const textures = new Map(); // texture -> name
function texName(tex, name) {
  if (!tex) return null;
  if (!textures.has(tex)) textures.set(tex, name);
  return textures.get(tex);
}

function role(mat, plaza) {
  if (mat === plaza.signMat) return "signs";
  if (mat.polygonOffset && mat.polygonOffsetFactor === -6) return "apron";
  if (mat.polygonOffset && mat.polygonOffsetFactor === -9) return "marks";
  if (mat.blending === THREE.AdditiveBlending) return "glow";
  if (mat.isMeshBasicMaterial && mat.vertexColors) return "lights";
  if (mat.isMeshBasicMaterial && mat.map) return "fare";
  if (mat.isMeshStandardMaterial && mat.map) return "chev";
  if (mat.isMeshStandardMaterial && mat.vertexColors) return "body";
  return "other";
}

const road = await (await fetch("../road.json")).json();
const scene = new THREE.Scene();
const F = { x: (X) => X, z: (Y) => -Y };
const built = buildPlazas(road, scene, F);

const m = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const scl = new THREE.Vector3();
const xAxis = new THREE.Vector3();

const plazas = built.list.map((p) => {
  const meshes = [];
  const instanced = {};
  for (const child of p.group.children) {
    if (child.isInstancedMesh) {
      const name = child.material.map ? (child.geometry.type === "PlaneGeometry" ? (instanced.arrow ? "cross" : "arrow") : "other") : child.geometry.type === "SphereGeometry" ? "lamp" : "boom";
      const mats = [];
      for (let i = 0; i < child.count; i++) {
        child.getMatrixAt(i, m);
        mats.push(Array.from(m.elements));
      }
      instanced[name] = { geometry: geometry(child.geometry), matrices: mats, texture: texName(child.material.map, `sig-${name}`) };
    } else if (child.isMesh) {
      const r = role(child.material, p);
      meshes.push({ role: r, geometry: geometry(child.geometry), texture: texName(child.material.map, r === "signs" ? `signs-${p.id}` : r === "fare" ? `fare-${p.id}` : r) });
    }
  }
  // booms at rest: m = T(u, y, -v) * RotY(+-90deg) * Scale(len, 1, 1); the arm swings about its local z
  const lanes = p.lanes;
  const booms = (instanced.boom?.matrices ?? []).map((e, i) => {
    m.fromArray(e);
    m.decompose(pos, quat, scl);
    xAxis.set(1, 0, 0).applyQuaternion(quat);
    return { key: lanes[i].key, u: pos.x, y: pos.y, v: -pos.z, side: -xAxis.z > 0 ? 1 : -1, len: scl.x };
  });
  const lamps = (instanced.lamp?.matrices ?? []).map((e, i) => ({ key: lanes[i].key, u: e[12], y: e[13], v: -e[14] }));
  return {
    id: p.id,
    name: p.name,
    km: p.km ?? null,
    x: p.x,
    y: p.y,
    heading: p.heading,
    ux: p.ux,
    uy: p.uy,
    nx: p.nx,
    ny: p.ny,
    halfWidth: p.halfWidth,
    remap: !!p.remap,
    derived: !!p.derived,
    lanes: lanes.map((l) => ({ dir: l.dir, idx: l.idx, type: l.type, key: l.key, number: l.number, u: l.u, v: l.v, w: l.w, srcV: l.srcV, islandV: l.islandV })),
    meshes,
    booms,
    lamps,
    boomGeometry: instanced.boom?.geometry ?? null,
    signals: { arrow: instanced.arrow ?? null, cross: instanced.cross ?? null },
  };
});

const tex = {};
for (const [t, name] of textures) {
  const img = t.image;
  if (img && img.toDataURL) tex[name] = img.toDataURL("image/png");
}

window.__export = {
  constants: {
    LANE_W: L.LANE_W,
    ISLAND_W: L.ISLAND_W,
    KERB_W: L.KERB_W,
    BOOTH_T: L.BOOTH_T,
    BOOM_T: L.BOOM_T,
    ISLAND_T0: L.ISLAND_T0,
    ISLAND_T1: L.ISLAND_T1,
    CANOPY_U: L.CANOPY_U,
    FLARE_IN: L.FLARE_IN,
    FLARE_OUT: L.FLARE_OUT,
    ZONE: L.ZONE,
  },
  plazas,
  textures: tex,
};
