// The 3D live view: scene, feed handling, interpolation, cameras and HUD.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { buildWorld } from "./world.js";
import { VehicleLayer, CLASS_INFO } from "./vehicles.js";
import { Sky } from "./sky.js";
import { Feed } from "./feed.js";
import { footerHtml, esc, money, plateHtml, STATUS_LABEL, REASON_LABEL } from "./ui.js";

const BASE = import.meta.env.BASE_URL;
const LAG = 2.4; // seconds the view runs behind the newest frame, to interpolate
const TIME_PRESETS = { auto: null, day: "10:30", dusk: "18:35", night: "22:15" };

function hashParams() {
  return new URLSearchParams(location.hash.split("?")[1] ?? "");
}

function shortAngle(a, b) {
  let d = ((b - a + 540) % 360) - 180;
  return a + d;
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
          <span class="clock" id="clock">--:--:--</span>
        </div>
        <dl class="stats" id="stats">
          <div><dt>Vehicles</dt><dd id="s-veh">0</dd></div>
          <div><dt>Reads</dt><dd id="s-reads">0</dd></div>
          <div><dt>Collected</dt><dd id="s-rev">P 0.00</dd></div>
          <div id="s-watch-wrap"><dt>Watching</dt><dd id="s-watch">–</dd></div>
        </dl>
      </header>
      <nav class="cams" id="cams" aria-label="Camera">
        <button data-cam="director" class="on" title="Cuts between shots automatically">Director</button>
        <button data-cam="overview">Overview</button>
        <button data-cam="follow">Follow random</button>
        <span class="gsel">
          <button data-cam="gantry-menu" aria-haspopup="true">Gantry cams</button>
          <span class="gmenu" id="gmenu" hidden></span>
        </span>
        <button data-cam="time" id="timebtn" title="Lighting follows Botswana time; tap to preview day, dusk or night">Time: auto</button>
      </nav>
      <section class="ticker" id="ticker" aria-live="polite" aria-label="Recent gantry reads">
        <h2>Gantry reads</h2>
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
  const sky = new Sky(scene, renderer);
  const layer = new VehicleLayer(scene);

  // floating read labels above the gantries
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
  const veh = new Map(); // id -> { s: [[t,x,y,ang,spd] x up to 3], goneAt }
  let newestT = 0;
  let renderT = 0;
  let clockBase = null; // { t, ms } mapping sim time to wall-clock ms
  let live = false;
  let reads = 0;
  let revenue = 0;
  const pendingEvents = []; // { t, e }
  const eventLog = [];
  let lastWatchers = null;

  function resetState() {
    reg.clear();
    veh.clear();
    pendingEvents.length = 0;
    newestT = 0;
    renderT = 0;
  }

  function ingest(frame, first) {
    for (const [id, plate, cls, flags] of frame.spawn ?? []) reg.set(id, { plate, cls, flags });
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
    newestT = t;
    if (first) renderT = t - LAG;
    if (frame.clock) {
      const ms = Date.parse(frame.clock);
      if (!Number.isNaN(ms)) clockBase = { t, ms };
    }
    for (const e of frame.events ?? []) pendingEvents.push({ t: first ? t - LAG : t - 0.6, e, clock: frame.clock });
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
      for (const [id, plate, cls, flags] of init.registry ?? []) reg.set(id, { plate, cls, flags });
      if (init.frame) ingest(init.frame, true);
      if (init.watchers != null) lastWatchers = init.watchers;
      for (const e of (init.recent ?? []).slice(-6)) addTicker(e, false);
    },
    onFrame(frame) {
      ingest(frame, false);
    },
  });

  // ------------------------------------------------------------ ticker
  function addTicker(e, flash = true) {
    reads++;
    if (e.status === "charged" || e.status === "paid") revenue += e.amount_thebe ?? 0;
    const g = findGantry(e.gantry, e.dir);
    const li = document.createElement("li");
    const st = e.status ?? "unknown";
    li.className = `ev st-${st}`;
    li.innerHTML = `
      <span class="pill">${esc(STATUS_LABEL[st] ?? st)}</span>
      ${plateHtml(e.plate)}
      <span class="where">${esc(g ? g.name : e.gantry)} <small>${esc(e.dir ?? "")}</small></span>
      <span class="amt">${e.amount_thebe != null ? money(e.amount_thebe) : ""}</span>
      ${e.reason ? `<span class="why">${esc(REASON_LABEL[e.reason] ?? e.reason)}</span>` : e.match ? `<span class="why">via ${esc(e.match)}</span>` : ""}`;
    const ol = $("events");
    ol.prepend(li);
    while (ol.children.length > 7) ol.lastChild.remove();
    eventLog.push(e);
    if (eventLog.length > 50) eventLog.shift();
    if (flash && g) {
      g.flash = 1;
      g.flashColor = st === "charged" || st === "paid" ? 0x4fd18b : st === "review" ? 0xf5b83d : 0xff5a4f;
      const el = document.createElement("div");
      el.className = `pop st-${st}`;
      el.innerHTML = `${plateHtml(e.plate)}<span>${esc(STATUS_LABEL[st] ?? st)} ${e.amount_thebe != null ? money(e.amount_thebe) : ""}</span>`;
      const obj = new CSS2DObject(el);
      obj.position.copy(g.pos).add(new THREE.Vector3(0, 12, 0));
      scene.add(obj);
      pops.push({ obj, born: performance.now() });
      lastReadGantry = g;
      lastReadAt = performance.now();
    }
    if (followId && e.vid === followId) lastFollowRead = e;
  }

  function findGantry(id, dir) {
    return world.gantries.find((g) => g.id === id && (g.dir === dir || g.dir.includes(dir ?? ""))) ?? world.gantries.find((g) => g.id === id);
  }

  // ------------------------------------------------------------ interpolation
  const current = new Map(); // id -> { id, cls, x, z, rot, X, Y, spd, heading }
  function sampleAt(v, t) {
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

  function updateVehicles() {
    current.clear();
    const list = [];
    for (const [id, v] of veh) {
      if (v.goneAt != null && renderT >= v.goneAt) {
        veh.delete(id);
        continue;
      }
      if (v.s[0][0] > renderT + 0.01) continue; // not yet born at render time
      const p = sampleAt(v, renderT);
      if (!p) continue;
      const info = reg.get(id);
      const cls = info?.cls ?? "1";
      const item = { id, cls, x: F.x(p[1]), z: F.z(p[2]), rot: (-p[3] * Math.PI) / 180, X: p[1], Y: p[2], spd: p[4], heading: p[3] };
      current.set(id, item);
      list.push(item);
    }
    return list;
  }

  // ------------------------------------------------------------ cameras
  let mode = "director";
  let followId = null;
  let lastFollowRead = null;
  let gantryCam = null;
  let lastReadGantry = null;
  let lastReadAt = 0;
  let transition = null; // { from: {p,t}, to: {p,t}, start, dur }
  const focus = new THREE.Vector3();

  function setButtons() {
    for (const b of root.querySelectorAll("#cams [data-cam]")) {
      const c = b.dataset.cam;
      b.classList.toggle("on", c === mode || (c === "gantry-menu" && mode === "gantry"));
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
    const span = Math.max(road.bounds[2] - road.bounds[0], road.bounds[3] - road.bounds[1]);
    const narrow = camera.aspect < 0.9;
    const dist = span * (narrow ? 1.05 : 0.62) / Math.tan((camera.fov * Math.PI) / 360) * 0.75;
    moveTo(new THREE.Vector3(-span * 0.18, dist * 0.82, dist * 0.55), new THREE.Vector3(0, 0, 0), dur);
  }

  function aerialShot(place) {
    const p = place.pos;
    moveTo(new THREE.Vector3(p.x - 2200, 2600, p.z + 3600), new THREE.Vector3(p.x, 0, p.z), 0);
  }

  function gantryShot(g, dur = 1.4) {
    gantryCam = g;
    // stand on the verge ~45 m upstream of the portal, looking at it
    const h = g.heading;
    const along = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
    const side = new THREE.Vector3(Math.sin(h), 0, Math.cos(h)); // right of travel
    const pos = g.pos.clone().addScaledVector(along, -48).addScaledVector(side, 16).add(new THREE.Vector3(0, 9, 0));
    moveTo(pos, g.pos.clone().add(new THREE.Vector3(0, 3.5, 0)), dur);
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
      // something that will reach a gantry in the next 10-25 s
      const cands = all.filter((v) => {
        const eta = gantryEta(v);
        return eta && eta.t > 8 && eta.t < 25;
      });
      if (cands.length) return cands[Math.floor(Math.random() * cands.length)];
    }
    return all[Math.floor(Math.random() * all.length)];
  }

  function gantryEta(v) {
    if (v.spd < 3) return null;
    const th = (v.heading * Math.PI) / 180;
    const vx = Math.sin(th);
    const vy = Math.cos(th);
    let best = null;
    for (const g of world.gantries) {
      const dx = g.x - v.X;
      const dy = g.y - v.Y;
      const d = Math.hypot(dx, dy);
      if (d > 900 || d < 5) continue;
      if ((dx * vx + dy * vy) / d < 0.96) continue;
      const t = d / v.spd;
      if (!best || t < best.t) best = { g, t };
    }
    return best;
  }

  function busiestGantry() {
    const score = new Map();
    for (const v of current.values()) {
      const eta = gantryEta(v);
      if (eta && eta.t > 3 && eta.t < 20) score.set(eta.g, (score.get(eta.g) ?? 0) + 1);
    }
    let best = null;
    for (const [g, n] of score) if (!best || n > best[1]) best = [g, n];
    return best ? best[0] : world.gantries[Math.floor(Math.random() * world.gantries.length)];
  }

  function setMode(m, opts = {}) {
    mode = m;
    if (m !== "follow") followId = null;
    if (m !== "gantry") gantryCam = null;
    if (m === "overview") overviewShot();
    if (m === "follow") {
      const v = opts.id ? current.get(opts.id) : randomVehicle("approaching");
      if (!v || !followShot(v.id)) mode = "free";
    }
    if (m === "gantry") gantryShot(opts.gantry ?? busiestGantry());
    if (m === "director") director.next = 0;
    setButtons();
    updateCard();
  }

  // the director: cuts between shots on its own until the visitor takes over
  const director = { next: 0, shot: null, n: 0 };
  function runDirector(now) {
    if (mode !== "director" && !(mode === "follow" && director.active) && !(mode === "gantry" && director.active)) return;
    if (now < director.next) return;
    director.active = true;
    const plan = ["gantry", "follow", "gantry", "aerial", "follow", "overview"];
    const kind = plan[director.n++ % plan.length];
    let label = "";
    if (kind === "gantry") {
      const g = busiestGantry();
      followId = null;
      gantryShot(g, 0);
      label = `Gantry cam · ${g.name}${g.dir === "NS" ? "" : " " + g.dir}`;
      director.next = now + 13000;
    } else if (kind === "follow") {
      gantryCam = null;
      const v = randomVehicle("approaching");
      if (v && followShot(v.id, 0)) {
        const info = reg.get(v.id);
        label = `Following ${info?.plate ?? "a vehicle"} · ${CLASS_INFO[v.cls]?.name ?? ""}`;
      }
      director.next = now + 16000;
    } else if (kind === "aerial") {
      followId = null;
      gantryCam = null;
      const p = road.places[Math.floor(Math.random() * road.places.length)];
      aerialShot(p);
      label = `Over ${p.name}`;
      director.next = now + 9000;
    } else {
      followId = null;
      gantryCam = null;
      overviewShot(0);
      label = "The A1, Gaborone to Mahalapye";
      director.next = now + 8000;
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
      if (mode === "director") mode = followId ? "follow" : gantryCam ? "gantry" : "free";
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
  renderer.domElement.addEventListener("wheel", () => {
    stopDirector();
    transition = null;
  }, { passive: true });

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
      gantryCam = null;
      followShot(best.v.id);
      setButtons();
      updateCard();
    }
  }

  const gmenu = $("gmenu");
  gmenu.innerHTML = world.gantries
    .map((g, i) => `<button data-g="${i}">${esc(g.name)} <small>${esc(g.id)}${g.dir === "NS" ? "" : " · " + g.dir}</small></button>`)
    .join("");
  let timePreset = hashParams().get("time") ?? "auto";
  function setTimeLabel() {
    $("timebtn").textContent = `Time: ${TIME_PRESETS[timePreset] !== undefined ? timePreset : timePreset}`;
  }
  setTimeLabel();
  root.querySelector("#cams").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    if (b.dataset.g != null) {
      gmenu.hidden = true;
      director.active = false;
      setMode("gantry", { gantry: world.gantries[Number(b.dataset.g)] });
      return;
    }
    const c = b.dataset.cam;
    if (c === "gantry-menu") {
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
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".gsel")) gmenu.hidden = true;
  });

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
    card.hidden = false;
    card.innerHTML = `
      <div class="card-h">${plateHtml(info.plate)}<button class="x" aria-label="Stop following">×</button></div>
      <div class="card-b">
        <div><span>Class</span><b>${esc(CLASS_INFO[v.cls]?.name ?? v.cls)} <small>(${esc(v.cls)})</small></b></div>
        <div><span>Speed</span><b>${Math.round(v.spd * 3.6)} km/h</b></div>
        <div><span>Account</span><b>${reg1 ? (tag ? "Registered, tag" : "Registered, plate only") : "Unregistered"}</b></div>
        <div><span>Last read</span><b>${
          lastFollowRead
            ? `${esc(STATUS_LABEL[lastFollowRead.status] ?? lastFollowRead.status)} ${lastFollowRead.amount_thebe != null ? money(lastFollowRead.amount_thebe) : ""} at ${esc(findGantry(lastFollowRead.gantry, lastFollowRead.dir)?.name ?? lastFollowRead.gantry)}`
            : "None yet"
        }</b></div>
      </div>`;
    card.querySelector(".x").onclick = () => {
      followId = null;
      mode = "free";
      setButtons();
      updateCard();
    };
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
  // initial camera from the URL, e.g. #/live?cam=gantry:A1-G01:N or ?cam=follow
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

    const list = updateVehicles();

    if (pendingCam && list.length) {
      const [kind, a, b] = pendingCam.split(":");
      director.active = false;
      if (kind === "overview") setMode("overview");
      else if (kind === "follow") setMode("follow");
      else if (kind === "gantry") setMode("gantry", { gantry: findGantry(a, b) });
      else if (kind === "free") setMode("free");
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
        if (director.active && !transition) {
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
    scene.fog.density = 1.6 / (height * 22 + distT * 4 + 6000);

    // lighting
    focus.copy(controls.target);
    const ms = lightingMs(wallMs());
    sky.update(ms, focus, camera);
    const night = sky.night;

    // altitude-dependent layers
    const alt = Math.max(height, distT * 0.6);
    const far = THREE.MathUtils.smoothstep(alt, 1500, 9000);
    world.overviewLines.material.opacity = far * 0.95;
    world.overviewLines.material.color.set(night > 0.5 ? 0x8b97a8 : 0x262a30);
    layer.update(list, night, far, followId);

    // gantry flashes
    for (const g of world.gantries) {
      if (g.flash > 0) {
        g.flash = Math.max(0, g.flash - dt * 1.3);
        g.flashMat.emissive.setHex(g.flashColor ?? 0x4fd18b);
        g.flashMat.emissiveIntensity = 0.3 + g.flash * 6;
      } else {
        g.flashMat.emissive.setHex(0x75aadb);
        g.flashMat.emissiveIntensity = 0.15 + night * 0.8;
      }
      g.label.visible = camera.position.distanceTo(g.pos) < 25000;
    }
    for (const p of world.places) p.label.visible = alt > 300 && camera.position.distanceTo(p.pos) < 160000;
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i];
      const age = (now - p.born) / 1000;
      p.obj.position.y += dt * 1.5;
      p.obj.element.style.opacity = String(Math.max(0, 1 - Math.max(0, age - 2.4) / 1.2));
      p.obj.visible = camera.position.distanceTo(p.obj.position) < 3000;
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
      const wm = wallMs();
      $("clock").textContent = `${dayFmt.format(wm)} ${clockFmt.format(wm)}`;
      $("s-veh").textContent = String(list.length);
      $("s-reads").textContent = reads.toLocaleString("en-GB");
      $("s-rev").textContent = money(revenue);
      $("s-watch").textContent = lastWatchers != null ? String(lastWatchers) : "–";
      if (followId) updateCard();
    }
  }
  raf = requestAnimationFrame(frame);
  feed.start();

  // expose a little for automated captures and debugging
  window.__viewer = {
    setMode,
    get mode() {
      return mode;
    },
    get vehicles() {
      return current.size;
    },
    get debug() {
      return { renderT, newestT, veh: veh.size, reg: reg.size };
    },
    get lastReadAt() {
      return lastReadAt;
    },
    feed,
  };

  return () => {
    running = false;
    cancelAnimationFrame(raf);
    feed.stop();
    ro.disconnect();
    renderer.dispose();
    renderer.forceContextLoss?.();
    delete window.__viewer;
  };
}
