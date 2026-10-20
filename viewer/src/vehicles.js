// Instanced vehicle meshes, one per class, plus lamps, headlight pools and a
// point cloud for when the camera is too high to see the boxes.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { CLASS_INFO, classLen } from "./vehicle-geometry.js";

export { CLASS_INFO };

const PALETTES = {
  M: [0xd23b33, 0x202225, 0x2f5fb3, 0xe7e7e7],
  1: [0xf2f2f0, 0xf2f2f0, 0xc3c7cc, 0xc3c7cc, 0x6c7178, 0x1f2124, 0x1f2124, 0x9e2a2b, 0x2d4f8b, 0xbfae8a, 0x355e3b],
  2: [0xf3f1ea, 0xf0c419, 0x2b62b0, 0xf3f1ea],
  3: [0xf3f1ea, 0xc8312b, 0x2b62b0, 0x2f7d4a, 0xe7e2d6],
  4: [0xf3f1ea, 0xc8312b, 0x2b62b0, 0xe3a21a, 0x5a5f66],
};

function box(w, h, l, x, y, z, color) {
  const g = new THREE.BoxGeometry(w, h, l).toNonIndexed();
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

const GLASS = 0x1a222c;
const TYRE = 0x111111;
const WHITE = 0xffffff;

// Each model is drawn at this length, then stretched to the sim's length.
const MODEL_LEN = { M: 2.1, 1: 4.5, 2: 7.5, 3: 10, 4: 18 };

// Models face -z (forward), centred on the vehicle's position.
function model(cls) {
  const g = mergeGeometries(parts(cls));
  g.scale(1, 1, classLen(cls) / MODEL_LEN[cls]);
  return g;
}

function parts(cls) {
  const parts = [];
  if (cls === "1") {
    parts.push(box(1.8, 0.7, 4.5, 0, 0.62, 0, WHITE));
    parts.push(box(1.62, 0.58, 2.3, 0, 1.25, 0.25, GLASS));
    parts.push(box(1.64, 0.08, 2.0, 0, 1.58, 0.3, WHITE));
    parts.push(box(1.84, 0.34, 4.3, 0, 0.27, 0, TYRE));
  } else if (cls === "2") {
    // midi coach, as long as the sim's bus vType
    parts.push(box(2.4, 2.3, 7.5, 0, 1.7, 0, WHITE));
    parts.push(box(2.44, 0.8, 6.3, 0, 2.1, 0.35, GLASS));
    parts.push(box(2.3, 1.0, 0.1, 0, 2.05, -3.76, GLASS));
    parts.push(box(2.42, 0.5, 7.3, 0, 0.35, 0, TYRE));
  } else if (cls === "3") {
    parts.push(box(2.4, 2.3, 2.2, 0, 1.75, -3.9, WHITE));
    parts.push(box(2.3, 0.8, 0.08, 0, 2.3, -5.01, GLASS));
    parts.push(box(2.5, 3.0, 7.3, 0, 2.05, 1.3, 0xe9e6dd));
    parts.push(box(2.42, 0.6, 9.8, 0, 0.4, 0, TYRE));
  } else if (cls === "4") {
    parts.push(box(2.4, 2.5, 2.4, 0, 1.85, -7.8, WHITE));
    parts.push(box(2.3, 0.85, 0.08, 0, 2.45, -9.01, GLASS));
    parts.push(box(2.5, 3.2, 14.6, 0, 2.15, 1.6, 0xd9dde1));
    parts.push(box(2.42, 0.6, 17.6, 0, 0.4, 0, TYRE));
  } else {
    parts.push(box(0.5, 0.55, 2.0, 0, 0.6, 0, WHITE));
    parts.push(box(0.45, 0.75, 0.5, 0, 1.25, 0.15, 0x2a2a2a));
    parts.push(box(0.32, 0.3, 0.3, 0, 1.75, 0.05, 0x333333));
    parts.push(box(0.2, 0.62, 1.9, 0, 0.31, 0, TYRE));
  }
  return parts;
}

function lamps(cls) {
  const L = classLen(cls);
  const w = cls === "1" ? 1.8 : cls === "M" ? 0.4 : cls === "2" ? 2.35 : 2.45;
  const y = cls === "1" ? 0.72 : cls === "M" ? 0.95 : 0.9;
  const parts = [];
  const xs = cls === "M" ? [0] : [-w / 2 + 0.3, w / 2 - 0.3];
  for (const x of xs) {
    parts.push(box(0.36, 0.16, 0.06, x, y, -L / 2 - 0.02, 0xfff6d8));
    parts.push(box(0.32, 0.14, 0.06, x, y, L / 2 + 0.02, 0xff2a1a));
  }
  return mergeGeometries(parts);
}

function poolTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 120, 4, 32, 70, 70);
  grad.addColorStop(0, "rgba(255,240,200,0.9)");
  grad.addColorStop(0.5, "rgba(255,230,180,0.35)");
  grad.addColorStop(1, "rgba(255,230,180,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class VehicleLayer {
  constructor(scene, capacity = 3000) {
    this.capacity = capacity;
    this.meshes = {};
    this.lampMeshes = {};
    this.lampMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15 });
    for (const cls of Object.keys(CLASS_INFO)) {
      const m = new THREE.InstancedMesh(model(cls), mat, capacity);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.frustumCulled = false;
      m.count = 0;
      // seed the per-instance colour buffer
      m.setColorAt(0, new THREE.Color(1, 1, 1));
      scene.add(m);
      this.meshes[cls] = m;
      const lm = new THREE.InstancedMesh(lamps(cls), this.lampMat, capacity);
      lm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      lm.frustumCulled = false;
      lm.count = 0;
      scene.add(lm);
      this.lampMeshes[cls] = lm;
    }
    const poolGeo = new THREE.PlaneGeometry(7, 26);
    poolGeo.rotateX(-Math.PI / 2);
    poolGeo.translate(0, 0.1, -12.5);
    this.poolMat = new THREE.MeshBasicMaterial({
      map: poolTexture(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.pools = new THREE.InstancedMesh(poolGeo, this.poolMat, capacity);
    this.pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pools.frustumCulled = false;
    this.pools.renderOrder = 3;
    this.pools.count = 0;
    scene.add(this.pools);

    const pg = new THREE.BufferGeometry();
    this.pointPos = new Float32Array(capacity * 3);
    this.pointCol = new Float32Array(capacity * 3);
    pg.setAttribute("position", new THREE.BufferAttribute(this.pointPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute("color", new THREE.BufferAttribute(this.pointCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(
      pg,
      new THREE.PointsMaterial({ size: 3.5, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    scene.add(this.points);
    this.classColor = Object.fromEntries(Object.entries(CLASS_INFO).map(([k, v]) => [k, new THREE.Color(v.color)]));
    this.tmp = new THREE.Object3D();
    this.col = new THREE.Color();
  }

  static colorFor(cls, id) {
    const p = PALETTES[cls] ?? PALETTES[1];
    return p[Math.abs(Math.imul(id, 2654435761)) % p.length];
  }

  /** list: [{ id, cls, x, z, rot }] */
  update(list, night, pointsOpacity, highlightId) {
    const counts = { M: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    const o = this.tmp;
    let pc = 0;
    for (const v of list) {
      const cls = this.meshes[v.cls] ? v.cls : "1";
      const k = counts[cls]++;
      if (k >= this.capacity) continue;
      o.position.set(v.x, 0, v.z);
      o.rotation.set(0, v.rot, 0);
      o.scale.setScalar(1);
      o.updateMatrix();
      this.meshes[cls].setMatrixAt(k, o.matrix);
      this.lampMeshes[cls].setMatrixAt(k, o.matrix);
      this.col.setHex(VehicleLayer.colorFor(cls, v.id));
      if (v.id === highlightId) this.col.lerp(new THREE.Color(0x9fd0ff), 0.25);
      this.meshes[cls].setColorAt(k, this.col);
      if (night > 0.02 && pc < this.capacity) {
        // the pool hangs off the front bumper, not the middle of the body
        o.translateZ(-classLen(cls) / 2);
        o.updateMatrix();
        this.pools.setMatrixAt(pc, o.matrix);
      }
      const c = v.id === highlightId ? this.col.setHex(0xffffff) : this.classColor[cls];
      this.pointPos[pc * 3] = v.x;
      this.pointPos[pc * 3 + 1] = 3;
      this.pointPos[pc * 3 + 2] = v.z;
      this.pointCol[pc * 3] = c.r;
      this.pointCol[pc * 3 + 1] = c.g;
      this.pointCol[pc * 3 + 2] = c.b;
      pc++;
    }
    for (const cls of Object.keys(this.meshes)) {
      const m = this.meshes[cls];
      m.count = Math.min(counts[cls], this.capacity);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      const lm = this.lampMeshes[cls];
      lm.count = m.count;
      lm.instanceMatrix.needsUpdate = true;
    }
    this.pools.count = night > 0.02 ? pc : 0;
    this.pools.instanceMatrix.needsUpdate = true;
    this.poolMat.opacity = night * 0.55;
    const pg = this.points.geometry;
    pg.setDrawRange(0, pc);
    pg.attributes.position.needsUpdate = true;
    pg.attributes.color.needsUpdate = true;
    this.points.material.opacity = pointsOpacity;
    this.points.visible = pointsOpacity > 0.01;
  }
}
