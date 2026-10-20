// One interface over the two sources of traffic: the live SSE stream from the
// back office, and the committed replay recording used whenever the stream is
// unavailable (not deployed, full, erroring, or the simulation is paused).
//
// Both emit the same messages:
//   onInit({ live, registry, recent, watchers, frame })
//   onFrame(frame)   frame = { t, clock, vehicles, spawn, gone, events, stats, watchers }

const BASE = import.meta.env.BASE_URL; // "/projects/toll-sim/"
export const STREAM_URL = `${BASE}live/live/stream`;
const REPLAY_URL = `${BASE}replay.json`;

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
    frames.push({ t: f.t, vehicles, spawn: f.s, gone: f.g, events: f.e, stats: f.st });
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

/** Botswana wall clock as an ISO string with +02:00 offset. */
export function botswanaIso(ms) {
  const d = new Date(ms + 2 * 3600 * 1000);
  return d.toISOString().replace(/\.\d+Z$/, "+02:00");
}

export class Feed {
  constructor({ onInit, onFrame, onMode }) {
    this.onInit = onInit;
    this.onFrame = onFrame;
    this.onMode = onMode ?? (() => {});
    this.mode = null;
    this.es = null;
    this.timer = null;
    this.retry = null;
    this.replay = null;
    this.stopped = false;
  }

  start() {
    this.tryLive();
  }

  stop() {
    this.stopped = true;
    this.es?.close();
    clearTimeout(this.timer);
    clearTimeout(this.retry);
  }

  tryLive() {
    if (this.stopped) return;
    if (typeof EventSource === "undefined" || new URLSearchParams(location.hash.split("?")[1]).has("replay")) {
      this.startReplay();
      return;
    }
    let gotInit = false;
    let failTimer = setTimeout(() => {
      if (!gotInit) fail();
    }, 6000);
    const es = new EventSource(STREAM_URL);
    this.es = es;
    const fail = () => {
      clearTimeout(failTimer);
      es.close();
      if (this.es === es) this.es = null;
      if (this.mode !== "replay") this.startReplay();
      // keep probing for the live feed in the background
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.probe(), 45000);
    };
    es.addEventListener("init", (ev) => {
      let init;
      try {
        init = JSON.parse(ev.data);
      } catch {
        return fail();
      }
      if (!init.live) return fail();
      gotInit = true;
      clearTimeout(failTimer);
      this.stopReplay();
      this.mode = "live";
      this.onMode("live");
      this.onInit({ ...init, live: true });
    });
    es.addEventListener("frame", (ev) => {
      if (this.mode !== "live") return;
      try {
        this.onFrame(JSON.parse(ev.data));
      } catch {
        /* ignore a bad frame */
      }
    });
    let errors = 0;
    es.onerror = () => {
      errors++;
      // Before init any error means no live feed. After init, give the
      // browser's own reconnect a few tries before falling back.
      if (!gotInit || es.readyState === EventSource.CLOSED || errors > 3) fail();
    };
    es.onopen = () => {
      if (gotInit) errors = 0;
    };
  }

  /** While in replay, check now and then whether the live feed came back. */
  probe() {
    if (this.stopped || this.mode === "live") return;
    const es = new EventSource(STREAM_URL);
    const done = () => es.close();
    const t = setTimeout(done, 6000);
    es.addEventListener("init", (ev) => {
      clearTimeout(t);
      es.close();
      try {
        if (JSON.parse(ev.data).live) {
          this.tryLive();
          return;
        }
      } catch {
        /* fall through */
      }
      this.retry = setTimeout(() => this.probe(), 60000);
    });
    es.onerror = () => {
      clearTimeout(t);
      es.close();
      this.retry = setTimeout(() => this.probe(), 60000);
    };
  }

  async startReplay() {
    if (this.stopped) return;
    this.mode = "replay";
    this.onMode("replay");
    if (!this.replay) {
      try {
        const res = await fetch(REPLAY_URL);
        this.replay = decodeReplay(await res.json());
      } catch (e) {
        console.error("replay unavailable", e);
        this.onMode("offline");
        return;
      }
    }
    if (this.mode !== "replay") return;
    this.playFrom(0);
  }

  stopReplay() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  playFrom(k) {
    const { frames, dt } = this.replay;
    const loopStart = Date.now();
    const registry = frames[0].spawn;
    // Replay clocks follow the visitor's real time in Botswana.
    const clock = (t) => botswanaIso(loopStart + t * 1000);
    const toFrame = (f) => ({ ...f, clock: clock(f.t), watchers: null });
    this.onInit({ live: false, registry, recent: [], watchers: null, frame: toFrame(frames[0]) });
    let i = k + 1;
    const tick = () => {
      if (this.mode !== "replay" || this.stopped) return;
      if (i >= frames.length) {
        this.playFrom(0);
        return;
      }
      this.onFrame(toFrame(frames[i]));
      i++;
      this.timer = setTimeout(tick, dt * 1000);
    };
    this.timer = setTimeout(tick, dt * 1000);
  }
}
