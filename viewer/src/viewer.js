// The 3D live view: scene, feed handling, interpolation, cameras and HUD.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { buildWorld } from "./world.js";
import { VehicleLayer, CLASS_INFO } from "./vehicles.js";
import { classLen, frontToCentre } from "./vehicle-geometry.js";
import { LAG, ingestVehicles, sampleAt } from "./traffic.js";
import { Sky } from "./sky.js";
import { Feed } from "./feed.js";
import { footerHtml, esc, money, plateHtml, STATUS_LABEL, REASON_LABEL, METHOD_LABEL } from "./ui.js";
import * as PL from "./plaza-layout.js";

const BASE = import.meta.env.BASE_URL;
const TIME_PRESETS = { auto: null, day: "10:30", dusk: "18:35", night: "22:15" };
const SHOT_KINDS = { overview: "Overview", booths: "Booths", canopy: "Canopy" };

function hashParams() {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

function hash32(n) {
  return Math.abs(Math.imul(n ^ 0x9e3779b9, 2654435761)) >>> 0;
}

export async function mountViewer(root) {
  root.innerHTML = `
    <div class="viewer">
      <div class="stage" id="stage"></div>
      <div class="fade" id="fade"></div>
      <header class="hud-top">
        <a class="brand" href="#/" aria-label="Back to the overview">A1 Toll Simulator</a>
        <div class="status">
          <span class="badge" id="badge"><i></i><b>Connecting</b></span>
          <span class="clock"><span id="day"></span> <span id="clock">--:--:--</span></span>
        </div>
        <dl class="stats" id="stats">
          <div><dt>Vehicles</dt><dd id="s-veh">0</dd></div>
          <div><dt>Transactions</dt><dd id="s-reads">0</dd></div>
          <div><dt>Collected</dt><dd id="s-rev">P 0.00</dd></div>
          <div id="s-watch-wrap"><dt>Watching</dt><dd id="s-watch">–</dd></div>
        </dl>
      </header>
      <nav class="cams" id="cams" aria-label="Camera">
        <button data-cam="director" class="on" title="Cuts between shots automatically">Director</button>
        <button data-cam="overview">Overview</button>
        <button data-cam="follow">Follow random</button>
        <span class="gsel">
          <button data-cam="plaza-menu" aria-haspopup="true">Plaza cams</button>
          <span class="gmenu" id="gmenu" hidden></span>
        </span>
        <button data-cam="time" id="timebtn" title="Lighting follows Botswana time; tap to preview day, dusk or night">Time: auto</button>
      </nav>
      <section class="plazas" id="plazapanel" aria-label="Toll plazas"></section>
      <section class="ticker" id="ticker" aria-live="polite" aria-label="Recent toll transactions">
        <h2>Toll transactions</h2>
        <ol id="events"></ol>
      </section>
      <aside class="card" id="card" hidden></aside>
      <div class="shot" id="shot"></div>
      <footer class="vfoot">
        <span>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors (ODbL)</a></span>
        ${footerHtml()}
      </footer>
    </div>`;

  const stage = root.querySelector("#stage");
  const $ = (id) => root.querySelector(`#${id}`);

  // ------------------------------------------------------------ renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = "labels";
  stage.appendChild(labels.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 700000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 6;
  controls.maxDistance = 330000;
  controls.screenSpacePanning = false;

  const road = await (await fetch(`${BASE}road.json`)).json();
  const world = buildWorld(road, scene);
  const F = world.F;
  const plazas = world.plazas.list;
  const sky = new Sky(scene, renderer);
  const layer = new VehicleLayer(scene);

  // floating payment labels above the booths
  const pops = [];

  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  // ------------------------------------------------------------ state
  const reg = new Map(); // id -> { plate, cls, flags }
  const veh = new Map(); // id -> { s: [[t,x,y,ang,spd] x up to 4], goneAt }
  let newestT = 0;
  let renderT = 0;
  let clockBase = null; // { t, ms } mapping sim time to wall-clock ms
  let live = false;
  let reads = 0;
  let revenue = 0;
  const pendingEvents = []; // { t, e }
  const pendingBooms = []; // { t, b: [plaza, dir, idx, up] }
  const eventLog = [];
  let lastWatchers = null;
  // plaza data from the feed, all optional
  let feedOpen = null; // { [plazaId]: { N: [idx], S: [idx] } }
  let feedPlazaStats = null; // stats.plazas
  let plazaAware = !plazas.some((p) => p.derived); // the simulation routes vehicles through plaza lanes
  const local = new Map(plazas.map((p) => [p.id, { methods: { tag: 0, cash: 0, card: 0 }, waits: [], queue: { N: 0, S: 0 } }]));
  const slow = new Map(); // vehicle id -> { plaza, s, t }
  const assigned = new Map(); // vehicle id -> lane key, for steering

  function resetState() {
    reg.clear();
    veh.clear();
    pendingEvents.length = 0;
    pendingBooms.length = 0;
    slow.clear();
    assigned.clear();
    for (const l of local.values()) {
      l.methods = { tag: 0, cash: 0, card: 0 };
      l.waits = [];
    }
    newestT = 0;
    renderT = 0;
  }

  function ingest(frame, first) {
    for (const [id, plate, cls, flags] of frame.spawn ?? []) reg.set(id, { plate, cls, flags });
    const t = frame.t;
    ingestVehicles(veh, frame);
    newestT = t;
    if (first) renderT = t - LAG;
    if (frame.clock) {
      const ms = Date.parse(frame.clock);
      if (!Number.isNaN(ms)) clockBase = { t, ms };
    }
    const at = first ? t - LAG : t - 0.6;
    for (const e of frame.events ?? []) {
      if (e.lane != null || e.method) plazaAware = true;
      pendingEvents.push({ t: at, e, clock: frame.clock });
    }
    if (frame.lanes_open) {
      feedOpen = frame.lanes_open;
      plazaAware = true;
    }
    if (frame.stats?.plazas) {
      feedPlazaStats = frame.stats.plazas;
      plazaAware = true;
    }
    for (const b of frame.booms ?? []) {
      plazaAware = true;
      pendingBooms.push({ t: at, b });
    }
    if (frame.watchers != null) lastWatchers = frame.watchers;
  }

  const feed = new Feed({
    onMode(mode) {
      const badge = $("badge");
      badge.className = `badge ${mode}`;
      badge.querySelector("b").textContent = mode === "live" ? "Live" : mode === "replay" ? "Replay" : "Offline";
      badge.title =
        mode === "live"
          ? "Streaming from the running simulation"
          : "The live simulation is not running right now. This is a recorded loop of synthetic traffic.";
      $("s-watch-wrap").hidden = mode !== "live";
    },
    onInit(init) {
      live = !!init.live;
      resetState();
      feedOpen = null;
      feedPlazaStats = null;
      for (const [id, plate, cls, flags] of init.registry ?? []) reg.set(id, { plate, cls, flags });
      if (init.frame) ingest(init.frame, true);
      if (init.watchers != null) lastWatchers = init.watchers;
      for (const e of (init.recent ?? []).slice(-6)) addTicker(e, false);
    },
    onFrame(frame) {
      ingest(frame, false);
    },
  });

  // ------------------------------------------------------------ plazas
  const plazaById = new Map(plazas.map((p) => [p.id, p]));
  function findPlaza(e) {
    return plazaById.get(e.plaza) ?? plazaById.get(e.gantry) ?? plazas.find((p) => p.name === e.gantry) ?? null;
  }
  function W(p, u, y, v) {
    return p.group.localToWorld(new THREE.Vector3(u, y, -v));
  }
  function methodOf(e) {
    if (e.method) return e.method;
    if (e.match === "tag") return "tag";
    return null;
  }
  /** Which lane an event belongs to: from the event, else where the vehicle is. */
  function laneFor(p, e) {
    const dir = e.dir === "S" ? "S" : "N";
    if (e.lane != null) return p.byKey.get(`${dir}${e.lane}`) ?? null;
    const v = current.get(e.vid);
    if (v) {
      const q = PL.toUV(p, v.X, v.Y);
      const l = PL.laneAt(p, dir, q.v, 1.2);
      if (l) return l;
    }
    const info = reg.get(e.vid);
    const type = info && (info.cls === "3" || info.cls === "4" || info.cls === "2") ? "heavy" : methodOf(e) === "tag" ? "etag" : "mixed";
    return p.lanes.find((l) => l.dir === dir && l.type === type) ?? p.lanes.find((l) => l.dir === dir) ?? null;
  }

  // ------------------------------------------------------------ ticker
  function addTicker(e, flash = true) {
    const st = e.status ?? "unknown";
    reads++;
    if (st === "charged" || st === "paid") revenue += e.amount_thebe ?? 0;
    const p = findPlaza(e);
    const lane = p ? laneFor(p, e) : null;
    const method = methodOf(e);
    if (p && method && local.get(p.id).methods[method] != null && (st === "charged" || st === "paid")) local.get(p.id).methods[method]++;
    const li = document.createElement("li");
    li.className = `ev st-${st}`;
    const reason = e.reason ? REASON_LABEL[e.reason] ?? e.reason : st === "review" ? "low-confidence read, to a person" : "";
    li.innerHTML = `
      <span class="pill">${esc(STATUS_LABEL[st] ?? st)}</span>
      ${plateHtml(e.plate)}
      <span class="where">${esc(p ? p.name : e.gantry)} <small>${lane ? `Lane ${lane.number} · ` : ""}${esc(e.dir ?? "")}</small></span>
      <span class="amt">${e.amount_thebe != null ? money(e.amount_thebe) : ""}</span>
      <span class="why">${method ? `<b class="m m-${esc(method)}">${esc(METHOD_LABEL[method] ?? method)}</b>` : ""}${reason ? `<span>${esc(reason)}</span>` : ""}</span>`;
    const ol = $("events");
    ol.prepend(li);
    while (ol.children.length > 5) ol.lastChild.remove();
    eventLog.push(e);
    if (eventLog.length > 50) eventLog.shift();
    if (flash && p) {
      const now = performance.now();
      if (lane) {
        const stLane = p.state.get(lane.key);
        if (st === "charged" || st === "paid") {
          p.queueFare(lane.key, [[money(e.amount_thebe), "fare", 1300], ["Thank you", "ok", 2600]], now);
          stLane.feedUp = true;
          stLane.feedUntil = now + 3500;
        } else if (e.reason === "insufficient_funds") {
          p.queueFare(lane.key, [["Insufficient funds", "bad", 4200]], now);
        } else if (method === "runner") {
          p.queueFare(lane.key, [["Violation recorded", "bad", 3500]], now);
        } else if (method === "plate") {
          p.queueFare(lane.key, [["Plate billed", "bad", 3000]], now);
        } else {
          p.queueFare(lane.key, [["See operator", "bad", 3000]], now);
        }
      }
      const el = document.createElement("div");
      el.className = `pop st-${st}`;
      el.innerHTML = `${plateHtml(e.plate)}<span>${method ? esc(METHOD_LABEL[method] ?? method) + " · " : ""}${e.reason === "insufficient_funds" ? "Insufficient funds" : `${esc(STATUS_LABEL[st] ?? st)} ${e.amount_thebe != null ? money(e.amount_thebe) : ""}`}</span>`;
      const obj = new CSS2DObject(el);
      obj.position.copy(lane ? W(p, PL.tToU(lane.dir, PL.BOOTH_T), 9.5, lane.v) : p.pos.clone().add(new THREE.Vector3(0, 15, 0)));
      scene.add(obj);
      pops.push({ obj, born: now, p });
      lastReadPlaza = p;
      lastReadAt = now;
    }
    if (followId && e.vid === followId) lastFollowRead = e;
  }

  // ------------------------------------------------------------ interpolation
  const current = new Map(); // id -> { id, cls, x, z, rot, X, Y, spd, heading }
  /** Plaza and travel direction a vehicle is in, with its along-lane t and lateral v. */
  function plazaContext(X, Y, headingDeg) {
    for (const p of plazas) {
      const dx = X - p.x;
      const dy = Y - p.y;
      if (dx * dx + dy * dy > 420 * 420) continue;
      const q = PL.toUV(p, X, Y);
      if (Math.abs(q.v) > p.halfWidth + 8) continue;
      const th = (headingDeg * Math.PI) / 180;
      const dir = Math.sin(th) * p.ux + Math.cos(th) * p.uy >= 0 ? "N" : "S";
      const t = PL.uToT(dir, q.u);
      if (t < PL.ZONE[0] || t > PL.ZONE[1]) continue;
      return { p, dir, t, u: q.u, v: q.v };
    }
    return null;
  }

  function openLanes(p) {
    return feedOpen?.[p.id] ?? defaultOpenFor(p);
  }
  let hourNow = 12;
  function defaultOpenFor(p) {
    return PL.defaultOpen(p, hourNow);
  }

  /** Lane for a vehicle the simulation doesn't route through the plaza (no plaza data yet). */
  function steerLane(id, cls, p, dir) {
    const key = `${id}:${p.id}`;
    let lane = assigned.get(key);
    if (lane && lane.dir === dir) return lane;
    const flags = reg.get(id)?.flags ?? 0;
    const open = openLanes(p)[dir] ?? [];
    const heavy = cls === "2" || cls === "3" || cls === "4";
    const want = heavy ? "heavy" : flags & 2 ? "etag" : "mixed";
    let cands = p.lanes.filter((l) => l.dir === dir && l.type === want && open.includes(l.idx));
    if (!cands.length) cands = p.lanes.filter((l) => l.dir === dir && l.type !== "etag" && open.includes(l.idx));
    if (!cands.length) cands = p.lanes.filter((l) => l.dir === dir);
    lane = cands[hash32(id) % cands.length];
    assigned.set(key, lane);
    return lane;
  }

  function updateVehicles(dt) {
    current.clear();
    const list = [];
    for (const l of local.values()) l.queue = { N: 0, S: 0 };
    for (const p of plazas) for (const st of p.state.values()) st.localUp = false;
    for (const [id, v] of veh) {
      if (v.goneAt != null && renderT >= v.goneAt) {
        veh.delete(id);
        slow.delete(id);
        continue;
      }
      if (v.s[0][0] > renderT + 0.01) continue; // not yet born at render time
      const p = sampleAt(v, renderT);
      if (!p) continue;
      const info = reg.get(id);
      const cls = info?.cls ?? "1";
      // the feed gives the front bumper; everything below works on the centre
      let [X, Y] = frontToCentre(p[1], p[2], p[3], classLen(cls));
      const ctx = plazaContext(X, Y, p[3]);
      if (ctx) {
        let vv = ctx.v;
        if (!plazaAware) {
          // the feed knows nothing of plaza lanes: ease the vehicle into one
          const f = PL.flare(ctx.t);
          if (f > 0) {
            const lane = steerLane(id, cls, ctx.p, ctx.dir);
            vv = ctx.v + (lane.v - ctx.v) * f;
            [X, Y] = PL.fromUV(ctx.p, ctx.u, vv);
          }
        } else if (ctx.p.remap) {
          // the feed's lanes are packed tighter than the drawn ones
          const f = PL.flare(ctx.t);
          if (f > 0) {
            vv = ctx.v + (PL.mapV(ctx.p, ctx.dir, ctx.v) - ctx.v) * f;
            [X, Y] = PL.fromUV(ctx.p, ctx.u, vv);
          }
        }
        const lane = PL.laneAt(ctx.p, ctx.dir, vv, 0.8);
        const len = CLASS_INFO[cls]?.len ?? 4.5;
        const spd = p[4];
        const lp = local.get(ctx.p.id);
        if (ctx.t < PL.BOOM_T && ctx.t > -300 && spd < 2.5) lp.queue[ctx.dir]++;
        if (lane) {
          const front = ctx.t + len / 2;
          const rear = ctx.t - len / 2;
          const reach = lane.type === "etag" ? 9 : 2.2;
          if (front > PL.BOOM_T - reach && rear < PL.BOOM_T + 0.8 && spd > (lane.type === "etag" ? 1.0 : 0.35)) ctx.p.state.get(lane.key).localUp = true;
        }
        // time spent crawling before the booms, for the average wait
        let sl = slow.get(id);
        if (!sl || sl.plaza !== ctx.p.id) {
          sl = { plaza: ctx.p.id, s: 0, t: ctx.t, done: false };
          slow.set(id, sl);
        }
        if (ctx.t < PL.BOOM_T && spd < 3) sl.s += dt;
        if (!sl.done && sl.t < PL.BOOM_T && ctx.t >= PL.BOOM_T) {
          sl.done = true;
          lp.waits.push(sl.s);
          if (lp.waits.length > 30) lp.waits.shift();
        }
        sl.t = ctx.t;
      }
      const item = { id, cls, x: F.x(X), z: F.z(Y), rot: (-p[3] * Math.PI) / 180, X, Y, spd: p[4], heading: p[3] };
      current.set(id, item);
      list.push(item);
    }
    return list;
  }

  // ------------------------------------------------------------ cameras
  let mode = "director";
  let followId = null;
  let lastFollowRead = null;
  let plazaCam = null; // { p, kind }
  let lastReadPlaza = null;
  let lastReadAt = 0;
  let transition = null;
  const focus = new THREE.Vector3();

  function setButtons() {
    for (const b of root.querySelectorAll("#cams [data-cam]")) {
      const c = b.dataset.cam;
      b.classList.toggle("on", c === mode || (c === "plaza-menu" && mode === "plaza"));
    }
  }

  function moveTo(pos, target, dur = 1.6) {
    const far = camera.position.distanceTo(pos) > 6000 && dur > 0;
    if (far || dur === 0) {
      if (far) {
        const fade = $("fade");
        fade.classList.add("on");
        setTimeout(() => fade.classList.remove("on"), 380);
      }
      camera.position.copy(pos);
      controls.target.copy(target);
      transition = null;
      return;
    }
    transition = {
      fp: camera.position.clone(),
      ft: controls.target.clone(),
      tp: pos.clone(),
      tt: target.clone(),
      start: performance.now(),
      dur: dur * 1000,
    };
  }

  function overviewShot(dur = 1.8) {
    // look up the corridor from the south-west so its whole length fits
    const len = Math.hypot(road.bounds[2] - road.bounds[0], road.bounds[3] - road.bounds[1]);
    const narrow = camera.aspect < 0.9;
    const fit = (len * 0.5) / Math.tan((camera.fov * Math.PI) / 360) / Math.min(1.25, Math.max(0.5, narrow ? camera.aspect * 1.6 : 1));
    const d = fit * (narrow ? 1.0 : 0.95);
    moveTo(new THREE.Vector3(3000 - d * 0.22, d * 0.6, 22000 + d * 0.72), new THREE.Vector3(3000, 0, 22000), dur);
  }

  function aerialShot(place) {
    const p = place.pos;
    moveTo(new THREE.Vector3(p.x - 2200, 2600, p.z + 3600), new THREE.Vector3(p.x, 0, p.z), 0);
  }

  function busierDir(p) {
    const q = feedPlazaStats?.[p.id]?.queue ?? local.get(p.id).queue;
    return (q.S ?? 0) > (q.N ?? 0) ? "S" : "N";
  }

  function plazaShot(p, kind = "overview", dur = 1.4, dir = busierDir(p)) {
    plazaCam = { p, kind };
    const s = dir === "N" ? 1 : -1; // mirror u and v for the southbound side
    const narrow = camera.aspect < 0.9;
    const lanes = p.lanes.filter((l) => l.dir === dir);
    const mid = lanes.reduce((a, l) => a + l.v, 0) / lanes.length;
    if (kind === "booths") {
      // above a mixed lane, behind the queue, looking at the booths
      const mixed = lanes.filter((l) => l.type === "mixed").sort((a, b) => Math.abs(a.v) - Math.abs(b.v));
      const l = mixed[0] ?? lanes[0];
      const pos = W(p, s * (narrow ? -50 : -44), narrow ? 6 : 4.6, l.v);
      const target = W(p, s * 4, 1.6, l.v + (l.islandV - l.v) * 0.6);
      moveTo(pos, target, dur);
    } else if (kind === "canopy") {
      const pos = W(p, s * (narrow ? -58 : -46), narrow ? 5.5 : 4.2, mid - s * 4);
      const target = W(p, 0, 6.2, mid + s * 2);
      moveTo(pos, target, dur);
    } else {
      const k = narrow ? 1.5 : 1;
      const pos = W(p, s * -88 * k, 34 * k, s * (p.halfWidth + 44) * k);
      const target = W(p, s * -26, 0, s * 6);
      moveTo(pos, target, dur);
    }
  }

  function followShot(id, dur = 1.2) {
    const v = current.get(id);
    if (!v) return false;
    followId = id;
    lastFollowRead = eventLog.findLast?.((e) => e.vid === id) ?? null;
    const th = (v.heading * Math.PI) / 180;
    const back = new THREE.Vector3(-Math.sin(th), 0, Math.cos(th)); // behind the vehicle
    const L = CLASS_INFO[v.cls]?.len ?? 5;
    const target = new THREE.Vector3(v.x, 1.5, v.z);
    const pos = target.clone().addScaledVector(back, 18 + L * 1.2).add(new THREE.Vector3(0, 6 + L * 0.25, 0));
    moveTo(pos, target, dur);
    return true;
  }

  function randomVehicle(prefer) {
    const all = [...current.values()];
    if (!all.length) return null;
    if (prefer === "approaching") {
      // something that will reach a plaza in the next 10-30 s
      const cands = all.filter((v) => {
        const eta = plazaEta(v);
        return eta && eta.t > 8 && eta.t < 30;
      });
      if (cands.length) return cands[Math.floor(Math.random() * cands.length)];
    }
    return all[Math.floor(Math.random() * all.length)];
  }

  function plazaEta(v) {
    if (v.spd < 3) return null;
    const th = (v.heading * Math.PI) / 180;
    const vx = Math.sin(th);
    const vy = Math.cos(th);
    let best = null;
    for (const p of plazas) {
      const dx = p.x - v.X;
      const dy = p.y - v.Y;
      const d = Math.hypot(dx, dy);
      if (d > 1200 || d < 60) continue;
      if ((dx * vx + dy * vy) / d < 0.9) continue;
      const t = d / v.spd;
      if (!best || t < best.t) best = { p, t };
    }
    return best;
  }

  function busiestPlaza() {
    let best = null;
    for (const p of plazas) {
      const q = feedPlazaStats?.[p.id]?.queue ?? local.get(p.id).queue;
      let n = (q.N ?? 0) + (q.S ?? 0);
      for (const v of current.values()) {
        const eta = plazaEta(v);
        if (eta && eta.p === p && eta.t < 30) n += 0.5;
      }
      n += Math.random() * 1.5;
      if (!best || n > best[1]) best = [p, n];
    }
    return best ? best[0] : plazas[0];
  }

  function setMode(m, opts = {}) {
    mode = m;
    if (m !== "follow") followId = null;
    if (m !== "plaza") plazaCam = null;
    if (m === "overview") overviewShot();
    if (m === "follow") {
      const v = opts.id ? current.get(opts.id) : randomVehicle("approaching");
      if (!v || !followShot(v.id)) mode = "free";
    }
    if (m === "plaza") plazaShot(opts.plaza ?? busiestPlaza(), opts.kind ?? "overview", 1.4, opts.dir);
    if (m === "director") director.next = 0;
    setButtons();
    updateCard();
  }

  // the director: cuts between shots on its own until the visitor takes over
  const director = { next: 0, n: 0 };
  function runDirector(now) {
    if (mode !== "director" && !(mode === "follow" && director.active) && !(mode === "plaza" && director.active)) return;
    if (now < director.next) return;
    director.active = true;
    const plan = ["plaza:overview", "follow", "plaza:booths", "plaza:canopy", "follow", "plaza:overview", "aerial", "plaza:booths", "overview"];
    const kind = plan[director.n++ % plan.length];
    let label = "";
    if (kind.startsWith("plaza")) {
      const shot = kind.split(":")[1];
      const p = shot === "overview" || !director.p ? busiestPlaza() : director.p;
      director.p = p;
      followId = null;
      plazaShot(p, shot, 0);
      label = shot === "overview" ? `${p.name} Toll Plaza` : `${p.name} · ${SHOT_KINDS[shot].toLowerCase()}`;
      director.next = now + (shot === "overview" ? 11000 : 12000);
    } else if (kind === "follow") {
      plazaCam = null;
      const v = randomVehicle("approaching");
      if (v && followShot(v.id, 0)) {
        const info = reg.get(v.id);
        const eta = plazaEta(v);
        label = `Following ${info?.plate ?? "a vehicle"} · ${CLASS_INFO[v.cls]?.name ?? ""}${eta ? ` to ${eta.p.name}` : ""}`;
      }
      director.next = now + 20000;
    } else if (kind === "aerial") {
      followId = null;
      plazaCam = null;
      const p = road.places[Math.floor(Math.random() * road.places.length)];
      aerialShot(p);
      label = `Over ${p.name}`;
      director.next = now + 8000;
    } else {
      followId = null;
      plazaCam = null;
      overviewShot(0);
      label = "The A1, Gaborone to Mahalapye";
      director.next = now + 7000;
    }
    showShot(label);
    updateCard();
  }

  let shotTimer = null;
  function showShot(text) {
    const el = $("shot");
    el.textContent = text;
    el.classList.add("on");
    clearTimeout(shotTimer);
    shotTimer = setTimeout(() => el.classList.remove("on"), 3200);
  }

  function stopDirector() {
    if (mode === "director" || director.active) {
      director.active = false;
      if (mode === "director") mode = followId ? "follow" : plazaCam ? "plaza" : "free";
      setButtons();
    }
  }

  // ------------------------------------------------------------ input
  renderer.domElement.addEventListener("pointerdown", (ev) => {
    stopDirector();
    transition = null;
    downAt = { x: ev.clientX, y: ev.clientY, t: performance.now() };
  });
  let downAt = null;
  renderer.domElement.addEventListener("pointerup", (ev) => {
    if (!downAt) return;
    const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
    if (moved < 6 && performance.now() - downAt.t < 400) pick(ev.clientX, ev.clientY);
    downAt = null;
  });
  renderer.domElement.addEventListener(
    "wheel",
    () => {
      stopDirector();
      transition = null;
    },
    { passive: true },
  );

  function pick(cx, cy) {
    const rect = renderer.domElement.getBoundingClientRect();
    const v3 = new THREE.Vector3();
    let best = null;
    for (const v of current.values()) {
      v3.set(v.x, 1.2, v.z).project(camera);
      if (v3.z > 1) continue;
      const sx = rect.left + ((v3.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - v3.y) / 2) * rect.height;
      const d = Math.hypot(sx - cx, sy - cy);
      if (d < 26 && (!best || d < best.d)) best = { d, v };
    }
    if (best) {
      mode = "follow";
      director.active = false;
      plazaCam = null;
      followShot(best.v.id);
      setButtons();
      updateCard();
    }
  }

  const gmenu = $("gmenu");
  gmenu.innerHTML = plazas
    .map(
      (p, i) =>
        `<div class="prow"><span>${esc(p.name)} <small>km ${esc(p.km ?? "")}</small></span><span class="pbtn">${Object.entries(SHOT_KINDS)
          .map(([k, label]) => `<button data-p="${i}" data-k="${k}">${label}</button>`)
          .join("")}</span></div>`,
    )
    .join("");
  let timePreset = hashParams().get("time") ?? "auto";
  function setTimeLabel() {
    $("timebtn").textContent = `Time: ${timePreset}`;
  }
  setTimeLabel();
  root.querySelector("#cams").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.p != null) {
      gmenu.hidden = true;
      director.active = false;
      setMode("plaza", { plaza: plazas[Number(b.dataset.p)], kind: b.dataset.k });
      return;
    }
    const c = b.dataset.cam;
    if (c === "plaza-menu") {
      gmenu.hidden = !gmenu.hidden;
      return;
    }
    gmenu.hidden = true;
    if (c === "time") {
      const keys = Object.keys(TIME_PRESETS);
      timePreset = keys[(keys.indexOf(timePreset) + 1) % keys.length] ?? "auto";
      setTimeLabel();
      return;
    }
    director.active = false;
    setMode(c);
  });
  const closeMenu = (ev) => {
    if (!ev.target.closest(".gsel")) gmenu.hidden = true;
  };
  document.addEventListener("click", closeMenu);

  // ------------------------------------------------------------ card
  function updateCard() {
    const card = $("card");
    if (!followId || !current.get(followId)) {
      card.hidden = true;
      return;
    }
    const v = current.get(followId);
    const info = reg.get(followId) ?? {};
    const reg1 = info.flags & 1;
    const tag = info.flags & 2;
    let last = "None yet";
    if (lastFollowRead) {
      const p = findPlaza(lastFollowRead);
      const lane = p ? laneFor(p, lastFollowRead) : null;
      const m = methodOf(lastFollowRead);
      last = `${esc(STATUS_LABEL[lastFollowRead.status] ?? lastFollowRead.status)} ${lastFollowRead.amount_thebe != null ? money(lastFollowRead.amount_thebe) : ""}${m ? ` by ${esc((METHOD_LABEL[m] ?? m).toLowerCase())}` : ""} at ${esc(p?.name ?? lastFollowRead.gantry)}${lane ? `, lane ${lane.number}` : ""}`;
    }
    card.hidden = false;
    card.innerHTML = `
      <div class="card-h">${plateHtml(info.plate)}<button class="x" aria-label="Stop following">×</button></div>
      <div class="card-b">
        <div><span>Class</span><b>${esc(CLASS_INFO[v.cls]?.name ?? v.cls)} <small>(${esc(v.cls)})</small></b></div>
        <div><span>Speed</span><b>${Math.round(v.spd * 3.6)} km/h</b></div>
        <div><span>Account</span><b>${reg1 ? (tag ? "Registered, e-tag" : "Registered, no tag") : "Unregistered"}</b></div>
        <div><span>Last toll</span><b>${last}</b></div>
      </div>`;
    card.querySelector(".x").onclick = () => {
      followId = null;
      mode = "free";
      setButtons();
      updateCard();
    };
  }

  // ------------------------------------------------------------ plaza panel
  const panel = $("plazapanel");
  panel.innerHTML = `<h2>Toll plazas</h2>${plazas
    .map(
      (p) => `<div class="pz" data-id="${esc(p.id)}">
        <b class="pz-n">${esc(p.name)}</b>
        <span class="pz-o" title="Lanes open, northbound and southbound"></span>
        <span class="pz-q" title="Vehicles queueing"></span>
        <span class="pz-w" title="Average wait at the booths"></span>
        <span class="pz-m" title="Transactions by payment method"></span>
      </div>`,
    )
    .join("")}`;
  const rows = new Map(plazas.map((p) => [p.id, panel.querySelector(`[data-id="${CSS.escape(p.id)}"]`)]));
  function updatePanel() {
    // the plaza nearest the camera target gets the highlight (and is the only row on a phone)
    let near = null;
    for (const p of plazas) {
      const d = p.pos.distanceTo(controls.target);
      if (!near || d < near[1]) near = [p, d];
    }
    for (const p of plazas) {
      const row = rows.get(p.id);
      const fs = feedPlazaStats?.[p.id];
      const lp = local.get(p.id);
      const open = fs?.open ?? (() => {
        const o = openLanes(p);
        return { N: o.N?.length ?? 0, S: o.S?.length ?? 0 };
      })();
      const nN = p.lanes.filter((l) => l.dir === "N").length;
      const nS = p.lanes.filter((l) => l.dir === "S").length;
      const openN = Array.isArray(open.N) ? open.N.length : open.N;
      const openS = Array.isArray(open.S) ? open.S.length : open.S;
      const q = fs?.queue ?? lp.queue;
      const wait = fs?.wait_s ?? (lp.waits.length ? lp.waits.reduce((a, b) => a + b, 0) / lp.waits.length : null);
      const m = fs?.by_method ?? lp.methods;
      row.classList.toggle("focus", near && near[0] === p);
      row.querySelector(".pz-o").innerHTML = `<i>Open</i> N ${openN}/${nN} · S ${openS}/${nS}`;
      row.querySelector(".pz-q").innerHTML = `<i>Queue</i> ${(q.N ?? 0) + (q.S ?? 0)}`;
      row.querySelector(".pz-w").innerHTML = `<i>Wait</i> ${wait == null ? "–" : `${Math.round(wait)} s`}`;
      row.querySelector(".pz-m").innerHTML = `<i>Tag</i> ${m.tag ?? 0} <i>Cash</i> ${m.cash ?? 0} <i>Card</i> ${m.card ?? 0}`;
    }
  }

  // ------------------------------------------------------------ clock
  const clockFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Gaborone", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const dayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Gaborone", weekday: "short", day: "numeric", month: "short" });
  function wallMs() {
    if (!clockBase) return Date.now();
    return clockBase.ms + (renderT - clockBase.t) * 1000;
  }
  function lightingMs(ms) {
    const preset = TIME_PRESETS[timePreset] ?? (/^\d{1,2}:\d{2}$/.test(timePreset) ? timePreset : null);
    if (!preset) return ms;
    const [h, m] = preset.split(":").map(Number);
    const d = new Date(ms + 2 * 3600e3);
    d.setUTCHours(h, m, 0, 0);
    return d.getTime() - 2 * 3600e3;
  }

  // ------------------------------------------------------------ loop
  // initial camera from the URL, e.g. #/live?cam=plaza:A1-G01:booths or ?cam=follow
  const camParam = hashParams().get("cam");
  overviewShot(0);
  let pendingCam = camParam;

  let last = performance.now();
  let raf = 0;
  let hudTick = 0;
  let running = true;
  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    // advance render time, easing toward newest - LAG
    if (newestT) {
      const target = newestT - LAG;
      const err = target - renderT;
      if (Math.abs(err) > 8) renderT = target;
      else renderT += dt * (1 + Math.max(-0.5, Math.min(0.5, err * 0.4)));
    }
    while (pendingEvents.length && pendingEvents[0].t <= renderT) addTicker(pendingEvents.shift().e, true);
    while (pendingBooms.length && pendingBooms[0].t <= renderT) {
      const [pid, dir, idx, up] = pendingBooms.shift().b;
      const st = plazaById.get(pid)?.state.get(`${dir}${idx}`);
      if (st) {
        st.feedUp = !!up;
        st.feedUntil = up ? now + 6000 : 0;
      }
    }

    const list = updateVehicles(dt);

    if (pendingCam && list.length) {
      const [kind, a, b] = pendingCam.split(":");
      director.active = false;
      if (kind === "overview") setMode("overview");
      else if (kind === "follow") setMode("follow");
      else if (kind === "plaza" || kind === "gantry") {
        const p = plazaById.get(a) ?? plazas[0];
        setMode("plaza", { plaza: p, kind: SHOT_KINDS[b] ? b : "overview", dir: b === "S" ? "S" : undefined });
      } else if (kind === "free") setMode("free");
      pendingCam = null;
    }
    runDirector(now);

    // camera
    if (transition) {
      const f = Math.min(1, (now - transition.start) / transition.dur);
      const e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
      camera.position.lerpVectors(transition.fp, transition.tp, e);
      controls.target.lerpVectors(transition.ft, transition.tt, e);
      if (f >= 1) transition = null;
    }
    if (followId) {
      const v = current.get(followId);
      if (v) {
        const target = new THREE.Vector3(v.x, 1.5, v.z);
        const delta = target.clone().sub(controls.target);
        if (transition) {
          transition.tt.add(delta);
          transition.tp.add(delta);
          transition.ft.add(delta);
          transition.fp.add(delta);
        }
        camera.position.add(delta);
        controls.target.copy(target);
        // gently swing behind the vehicle while the director is driving
        if (director.active && !transition && v.spd > 2) {
          const th = (v.heading * Math.PI) / 180;
          const off = camera.position.clone().sub(target);
          const r = Math.hypot(off.x, off.z);
          const want = Math.atan2(-Math.sin(th), Math.cos(th));
          const have = Math.atan2(off.x, off.z);
          let d = want - have;
          d = Math.atan2(Math.sin(d), Math.cos(d));
          const ang = have + d * Math.min(1, dt * 0.8);
          camera.position.x = target.x + Math.sin(ang) * r;
          camera.position.z = target.z + Math.cos(ang) * r;
        }
      } else {
        // vehicle left the network
        followId = null;
        if (director.active) director.next = 0;
        else mode = "free";
        setButtons();
      }
    }
    controls.update();

    const height = Math.max(1, camera.position.y);
    const distT = camera.position.distanceTo(controls.target);
    camera.near = Math.max(0.3, Math.min(height, distT) / 60);
    camera.far = Math.max(40000, height * 6 + distT * 3);
    camera.updateProjectionMatrix();
    scene.fog.density = 1.6 / (height * 4 + distT * 1.5 + 6000);

    // lighting
    focus.copy(controls.target);
    const ms = lightingMs(wallMs());
    hourNow = new Date(ms + 2 * 3600e3).getUTCHours();
    sky.update(ms, focus, camera);
    const night = sky.night;

    // plazas: lanes open, booms, signals and lights
    for (const p of plazas) p.setOpen(openLanes(p));
    // plaza lighting switches on with a photocell, around sunset
    const lamps = 1 - THREE.MathUtils.smoothstep(sky.elevationDeg, -3, 6);
    world.plazas.update(dt, now, lamps);

    // altitude-dependent layers
    const alt = Math.max(height, distT * 0.6);
    const far = THREE.MathUtils.smoothstep(alt, 1500, 9000);
    world.overviewLines.material.opacity = far * 0.95;
    world.overviewLines.material.color.set(night > 0.5 ? 0x8b97a8 : 0x262a30);
    layer.update(list, night, far, followId);

    for (const p of plazas) {
      const popping = pops.some((q) => q.p === p && q.obj.visible);
      const d = camera.position.distanceTo(p.pos);
      p.label.visible = !popping && ((d > 450 && d < 25000) || far > 0.5);
    }
    for (const pl of world.places) {
      const nearPlaza = far > 0.5 && plazas.some((p) => p.name === pl.name);
      pl.label.visible = alt > 300 && !nearPlaza && camera.position.distanceTo(pl.pos) < 420000;
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i];
      const age = (now - p.born) / 1000;
      p.obj.position.y += dt * 1.2;
      p.obj.element.style.opacity = String(Math.max(0, 1 - Math.max(0, age - 2.4) / 1.2));
      p.obj.visible = camera.position.distanceTo(p.obj.position) < 900;
      if (age > 3.6) {
        scene.remove(p.obj);
        p.obj.element.remove();
        pops.splice(i, 1);
      }
    }

    renderer.render(scene, camera);
    labels.render(scene, camera);

    // HUD at ~4 Hz
    if (now - hudTick > 250) {
      hudTick = now;
      const wm = lightingMs(wallMs());
      $("day").textContent = dayFmt.format(wm);
      $("clock").textContent = clockFmt.format(wm);
      $("s-veh").textContent = String(list.length);
      $("s-reads").textContent = reads.toLocaleString("en-GB");
      $("s-rev").textContent = money(revenue);
      $("s-watch").textContent = lastWatchers != null ? String(lastWatchers) : "–";
      updatePanel();
      if (followId) updateCard();
    }
  }
  raf = requestAnimationFrame(frame);
  feed.start();

  // expose a little for automated captures and debugging
  window.__viewer = {
    setMode,
    plazaShot(id, kind = "overview", dir) {
      director.active = false;
      setMode("plaza", { plaza: plazaById.get(id) ?? plazas[0], kind, dir });
    },
    get mode() {
      return mode;
    },
    get vehicles() {
      return current.size;
    },
    get debug() {
      return { renderT, newestT, veh: veh.size, reg: reg.size, plazaAware };
    },
    get lastReadAt() {
      return lastReadAt;
    },
    get lastReadPlaza() {
      return lastReadPlaza ? lastReadPlaza.id : null;
    },
    queues() {
      return Object.fromEntries(plazas.map((p) => [p.id, feedPlazaStats?.[p.id]?.queue ?? local.get(p.id).queue]));
    },
    feed,
  };

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    feed.stop();
    ro.disconnect();
    document.removeEventListener("click", closeMenu);
    renderer.dispose();
    renderer.forceContextLoss?.();
    delete window.__viewer;
  };
}
