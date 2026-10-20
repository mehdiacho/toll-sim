// Static scenery built from road.json: ground, asphalt, junctions, markings,
// gantry portals, labels and a scatter of acacia trees.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";

/** SUMO metres -> scene coordinates around a local origin (y up, -z north). */
export function makeFrame(road) {
  const [x0, y0, x1, y1] = road.bounds;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return {
    cx,
    cy,
    x: (X) => X - cx,
    z: (Y) => -(Y - cy),
  };
}

// deterministic random for the scenery
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function groundTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#b9a678";
  g.fillRect(0, 0, 256, 256);
  const r = rng(7);
  for (let i = 0; i < 2600; i++) {
    const x = r() * 256;
    const y = r() * 256;
    const s = 1 + r() * 5;
    const tone = r();
    g.fillStyle =
      tone < 0.45 ? `rgba(150,128,82,${0.25 + r() * 0.3})` : tone < 0.8 ? `rgba(206,190,146,${0.2 + r() * 0.3})` : `rgba(112,120,70,${0.25 + r() * 0.35})`;
    g.beginPath();
    g.ellipse(x, y, s, s * (0.5 + r()), r() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A flat ribbon along a polyline, offset sideways by [left, right] metres. */
function ribbon(pts, F, left, right, y, out) {
  const n = pts.length;
  if (n < 2) return;
  const base = out.pos.length / 3;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const L = Math.hypot(tx, ty) || 1;
    tx /= L;
    ty /= L;
    // left normal in SUMO coords
    const nx = -ty;
    const ny = tx;
    const p = pts[i];
    out.pos.push(F.x(p[0] + nx * left), y, F.z(p[1] + ny * left));
    out.pos.push(F.x(p[0] + nx * right), y, F.z(p[1] + ny * right));
  }
  for (let i = 0; i < n - 1; i++) {
    const k = base + i * 2;
    out.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
  }
}

function dashed(pts, every, on) {
  // split a polyline into dash segments
  const out = [];
  let acc = 0;
  let cur = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let s = 0;
    while (s < L) {
      const phase = acc % every;
      const inDash = phase < on;
      const step = Math.min(L - s, inDash ? on - phase : every - phase);
      const f0 = s / L;
      const f1 = (s + step) / L;
      if (inDash) {
        const p0 = [a[0] + (b[0] - a[0]) * f0, a[1] + (b[1] - a[1]) * f0];
        const p1 = [a[0] + (b[0] - a[0]) * f1, a[1] + (b[1] - a[1]) * f1];
        if (!cur) cur = [p0];
        cur.push(p1);
      } else if (cur) {
        out.push(cur);
        cur = null;
      }
      s += step;
      acc += step;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function geometryOf(buf) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setIndex(buf.idx);
  g.computeVertexNormals();
  return g;
}

function label(text, cls) {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  return new CSS2DObject(el);
}

function tinted(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return g;
}

export function buildWorld(road, scene) {
  const F = makeFrame(road);
  const group = new THREE.Group();
  scene.add(group);

  // ---------------------------------------------------------------- ground
  const tex = groundTexture();
  tex.repeat.set(5600, 5600);
  // large-scale tone variation (vertex colours) under the fine texture
  const gg = new THREE.PlaneGeometry(1200000, 1200000, 240, 240);
  const gp = gg.attributes.position;
  const gcol = new Float32Array(gp.count * 3);
  const c0 = new THREE.Color(0xd8c9a0);
  const c1 = new THREE.Color(0xa7a46c);
  const c2 = new THREE.Color(0xe6d7ae);
  const tc = new THREE.Color();
  for (let i = 0; i < gp.count; i++) {
    const x = gp.getX(i) / 26000;
    const y = gp.getY(i) / 26000;
    const n = Math.sin(x * 1.3 + Math.sin(y * 0.7) * 2) * 0.5 + Math.sin(y * 1.9 + x * 0.4) * 0.3 + Math.sin((x - y) * 3.1) * 0.2;
    const m = Math.sin(x * 4.7 + y * 3.3) * Math.sin(y * 5.1 - x * 1.7);
    tc.copy(c0).lerp(c1, Math.max(0, n) * 0.6).lerp(c2, Math.max(0, m) * 0.35);
    gcol.set([tc.r, tc.g, tc.b], i * 3);
  }
  gg.setAttribute("color", new THREE.BufferAttribute(gcol, 3));
  const ground = new THREE.Mesh(gg, new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, vertexColors: true, roughness: 1, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // ---------------------------------------------------------------- roads
  const asphalt = { pos: [], idx: [] };
  const shoulder = { pos: [], idx: [] };
  const white = { pos: [], idx: [] };
  const yellow = { pos: [], idx: [] };
  const edges = new Map();
  for (const lane of road.lanes) {
    const id = lane.id.replace(/_\d+$/, "");
    if (!edges.has(id)) edges.set(id, []);
    edges.get(id).push(lane);
    const h = lane.w / 2;
    ribbon(lane.pts, F, h, -h, 0.05, asphalt);
  }
  // Botswana drives on the left: SUMO lane 0 is the outer (left) lane and the
  // opposite carriageway lies to the right of the highest lane index.
  for (const lanes of edges.values()) {
    lanes.sort((a, b) => a.idx - b.idx);
    const outer = lanes[0];
    const inner = lanes[lanes.length - 1];
    const h = outer.w / 2;
    // gravel shoulder and the solid edge line on the outside (left)
    ribbon(outer.pts, F, h + 1.6, h, 0.03, shoulder);
    ribbon(outer.pts, F, h - 0.2, h - 0.35, 0.07, white);
    // centre line on the inside (right), dashed white between lanes
    ribbon(inner.pts, F, -inner.w / 2 + 0.2, -inner.w / 2 + 0.05, 0.07, yellow);
    for (let i = 1; i < lanes.length; i++) {
      const hh = lanes[i].w / 2;
      for (const d of dashed(lanes[i].pts, 12, 4)) ribbon(d, F, hh + 0.07, hh - 0.07, 0.07, white);
    }
  }
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x3b3d40, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -2 });
  const asphaltMesh = new THREE.Mesh(geometryOf(asphalt), roadMat);
  asphaltMesh.receiveShadow = true;
  group.add(asphaltMesh);
  const shoulderMesh = new THREE.Mesh(
    geometryOf(shoulder),
    new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1 }),
  );
  shoulderMesh.receiveShadow = true;
  group.add(shoulderMesh);
  const markMat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -4 });
  group.add(new THREE.Mesh(geometryOf(white), markMat(0xe9e9e2)));
  group.add(new THREE.Mesh(geometryOf(yellow), markMat(0xe2b33c)));

  // junction plates
  const jgeos = [];
  for (const poly of road.junctions) {
    if (poly.length < 3) continue;
    const contour = poly.map((p) => new THREE.Vector2(F.x(p[0]), -F.z(p[1])));
    const shape = new THREE.Shape(contour);
    const g = new THREE.ShapeGeometry(shape);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.045, 0);
    jgeos.push(g);
  }
  if (jgeos.length) {
    const j = new THREE.Mesh(mergeGeometries(jgeos), roadMat.clone());
    j.material.side = THREE.DoubleSide;
    j.receiveShadow = true;
    group.add(j);
  }

  // A thin line copy of the network, visible from far away where the
  // asphalt is narrower than a pixel. Faded in by the viewer with altitude.
  const linePos = [];
  for (const lane of road.lanes) {
    if (lane.idx !== 0) continue;
    for (let i = 1; i < lane.pts.length; i++) {
      const a = lane.pts[i - 1];
      const b = lane.pts[i];
      linePos.push(F.x(a[0]), 2, F.z(a[1]), F.x(b[0]), 2, F.z(b[1]));
    }
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute("position", new THREE.Float32BufferAttribute(linePos, 3));
  const overviewLines = new THREE.LineSegments(
    lg,
    new THREE.LineBasicMaterial({ color: 0x2b2f36, transparent: true, opacity: 0, depthWrite: false }),
  );
  overviewLines.renderOrder = 2;
  group.add(overviewLines);

  // ---------------------------------------------------------------- trees
  const r = rng(42);
  const trunk = tinted(new THREE.CylinderGeometry(0.18, 0.28, 2.4, 5).translate(0, 1.2, 0), 0x5b4632);
  const crownA = tinted(new THREE.IcosahedronGeometry(1, 0).scale(3.2, 0.9, 3.2).translate(0, 3.0, 0), 0x56662f);
  const acacia = mergeGeometries([trunk, crownA]);
  const bush = tinted(new THREE.IcosahedronGeometry(1, 0).scale(1.3, 0.8, 1.3).translate(0, 0.6, 0), 0x6d7438);
  const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  const lanes0 = road.lanes.filter((l) => l.idx === 0);
  const placeAlong = (count, near, far, geo, scaleMin, scaleMax) => {
    const mesh = new THREE.InstancedMesh(geo, treeMat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const tint = new THREE.Color();
    let k = 0;
    let guard = 0;
    while (k < count && guard++ < count * 10) {
      const lane = lanes0[Math.floor(r() * lanes0.length)];
      const i = 1 + Math.floor(r() * (lane.pts.length - 1));
      const a = lane.pts[i - 1];
      const b = lane.pts[i];
      const f = r();
      const x = a[0] + (b[0] - a[0]) * f;
      const y = a[1] + (b[1] - a[1]) * f;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const side = r() < 0.5 ? -1 : 1;
      const off = near + Math.pow(r(), 1.6) * (far - near);
      const X = x + (-(b[1] - a[1]) / L) * off * side;
      const Y = y + ((b[0] - a[0]) / L) * off * side;
      const sc = scaleMin + r() * (scaleMax - scaleMin);
      p.set(F.x(X), 0, F.z(Y));
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
      s.set(sc * (0.8 + r() * 0.4), sc, sc * (0.8 + r() * 0.4));
      m.compose(p, q, s);
      mesh.setMatrixAt(k, m);
      tint.setHSL(0.17 + r() * 0.06, 0.3 + r() * 0.2, 0.75 + r() * 0.35);
      mesh.setColorAt(k, tint);
      k++;
    }
    mesh.count = k;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };
  placeAlong(3200, 14, 420, acacia, 0.7, 1.5);
  placeAlong(3800, 9, 260, bush, 0.6, 1.6);

  // ---------------------------------------------------------------- gantries
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.45, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.6, metalness: 0.3 });
  const gantries = [];
  // floodlight pools under the portals, faded in at night by the viewer
  const gc = document.createElement("canvas");
  gc.width = gc.height = 128;
  const gx = gc.getContext("2d");
  const grad = gx.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, "rgba(255,244,214,0.95)");
  grad.addColorStop(0.45, "rgba(255,236,196,0.4)");
  grad.addColorStop(1, "rgba(255,236,196,0)");
  gx.fillStyle = grad;
  gx.fillRect(0, 0, 128, 128);
  const glowTex = new THREE.CanvasTexture(gc);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  const glowMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  for (const g of road.gantries) {
    const portal = new THREE.Group();
    const half = g.span / 2 + 1.2;
    const H = 6.6;
    const post = new THREE.BoxGeometry(0.45, H, 0.45);
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(post, steel);
      m.position.set(0, H / 2, side * half);
      m.castShadow = true;
      portal.add(m);
      const footing = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.4, 1.1), dark);
      footing.position.set(0, 0.2, side * half);
      portal.add(footing);
    }
    // lattice beam: two chords
    for (const dy of [0, 0.9]) {
      const chord = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, half * 2 + 0.4), steel);
      chord.position.set(0, H + dy, 0);
      chord.castShadow = true;
      portal.add(chord);
    }
    // the flashing light bar under the beam
    const flashMat = new THREE.MeshStandardMaterial({ color: 0x111418, emissive: 0x75aadb, emissiveIntensity: 0.15, roughness: 0.4 });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.18, half * 2 - 0.6), flashMat);
    bar.position.set(0, H - 0.25, 0);
    portal.add(bar);
    // cameras and tag readers above each lane
    const n = Math.max(2, g.lanes);
    for (let i = 0; i < n; i++) {
      const z = -g.span / 2 + (g.span / n) * (i + 0.5);
      const cam = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.32, 0.32), dark);
      cam.position.set(0.25, H - 0.45, z);
      portal.add(cam);
      const reader = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.5, 0.5), steel);
      reader.position.set(-0.2, H + 0.45, z);
      portal.add(reader);
    }
    // the sign panel
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 1.2, 3.6),
      new THREE.MeshStandardMaterial({ color: 0x1d5fa8, roughness: 0.5 }),
    );
    sign.position.set(0.1, H + 1.7, 0);
    portal.add(sign);

    const pool = new THREE.Mesh(glowGeo, glowMat);
    pool.scale.set(30, 1, g.span + 22);
    pool.position.y = 0.12;
    pool.renderOrder = 3;
    portal.add(pool);

    // orient: heading is the travel direction (math convention, SUMO coords);
    // the portal's local x axis points along the road.
    portal.position.set(F.x(g.x), 0, F.z(g.y));
    portal.rotation.y = g.heading; // scene z is -north so math angle maps directly
    group.add(portal);

    const tag = label(`${g.name} · ${g.id}${g.dir === "NS" ? "" : " " + g.dir}`, "lbl lbl-gantry");
    tag.position.set(0, H + 3.4, 0);
    portal.add(tag);

    gantries.push({ ...g, portal, flashMat, flash: 0, label: tag, pos: portal.position.clone() });
  }

  // ---------------------------------------------------------------- places
  const places = road.places.map((p) => {
    const l = label(p.name, "lbl lbl-place");
    l.position.set(F.x(p.x), 30, F.z(p.y));
    group.add(l);
    return { ...p, label: l, pos: l.position.clone() };
  });

  return { F, group, gantries, places, overviewLines, ground, glowMat };
}
