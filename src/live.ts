import { constants, createGzip, type Gzip } from "node:zlib";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

/**
 * The live feed behind the 3D view. The simulation bridge pushes a frame every
 * couple of simulated seconds (vehicle positions plus the gantry reads since the
 * last frame); the hub keeps the current picture in memory and fans each frame
 * out to every watcher over Server-Sent Events. Nothing here touches the
 * database: it is a broadcast of what the simulation sees, and a viewer that
 * joins late gets the whole current state in its first message.
 */

/** [id, x_dm, y_dm, angle_deg, speed_dm_s]: positions in SUMO metres x10. */
const vehicleTuple = z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int(), z.number().int()]);
/** [id, plate, class, flags]; flags bit 0 = registered, bit 1 = has a tag. */
const spawnTuple = z.tuple([z.number().int(), z.string().max(16), z.string().max(2), z.number().int()]);

export const liveFrameInput = z.object({
  /** Simulation time in seconds: the viewer interpolates on it. */
  t: z.number(),
  /** The simulated wall clock, ISO 8601 with offset (real time in always-on mode). */
  clock: z.string().max(40),
  vehicles: z.array(vehicleTuple).max(20000),
  spawn: z.array(spawnTuple).max(20000).default([]),
  gone: z.array(z.number().int()).max(20000).default([]),
  events: z
    .array(
      z.object({
        vid: z.number().int(),
        gantry: z.string().max(20),
        dir: z.string().max(2),
        plate: z.string().max(16).nullable(),
        status: z.string().max(20),
        amount_thebe: z.number().int().nullable(),
        reason: z.string().max(40).nullable(),
        match: z.string().max(20).nullable(),
      }),
    )
    .max(2000)
    .default([]),
  stats: z.record(z.string(), z.number()).default({}),
});
export type LiveFrame = z.infer<typeof liveFrameInput>;

interface Client {
  write(chunk: string): void;
  end(): void;
}

export class LiveHub {
  private registry = new Map<number, [string, string, number]>();
  private last: LiveFrame | null = null;
  private lastAt = 0;
  private recent: (LiveFrame["events"][number] & { clock: string })[] = [];
  private clients = new Set<Client>();

  constructor(private maxClients = 300) {}

  get watchers() {
    return this.clients.size;
  }

  publish(frame: LiveFrame) {
    for (const [id, plate, cls, flags] of frame.spawn) this.registry.set(id, [plate, cls, flags]);
    for (const id of frame.gone) this.registry.delete(id);
    this.last = frame;
    this.lastAt = Date.now();
    for (const e of frame.events) this.recent.push({ ...e, clock: frame.clock });
    if (this.recent.length > 40) this.recent.splice(0, this.recent.length - 40);
    if (!this.clients.size) return;
    const msg = `event: frame\ndata: ${JSON.stringify({ ...frame, watchers: this.clients.size })}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  /** The whole current picture, for a viewer that has just connected. */
  snapshot() {
    return {
      live: !!this.last && Date.now() - this.lastAt < 30_000,
      frame: this.last,
      registry: [...this.registry].map(([id, [plate, cls, flags]]) => [id, plate, cls, flags]),
      recent: this.recent,
      watchers: this.clients.size,
    };
  }

  /** Streams frames to one viewer until it disconnects. gzip when the client accepts it. */
  stream(req: FastifyRequest, reply: FastifyReply) {
    if (this.clients.size >= this.maxClients) {
      return reply.code(503).send({ error: "busy", message: "too many viewers right now; try again shortly" });
    }
    const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...(gzip ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}),
    });
    let z: Gzip | null = null;
    if (gzip) {
      z = createGzip({ flush: constants.Z_SYNC_FLUSH, level: 6 });
      z.pipe(res);
    }
    const out = z ?? res;
    const client: Client = {
      write: (chunk) => {
        // A viewer that can't keep up is dropped rather than buffered without bound.
        if (res.writableLength > 4 * 1024 * 1024) return close();
        out.write(chunk);
      },
      end: () => out.end(),
    };
    const close = () => {
      if (!this.clients.delete(client)) return;
      clearInterval(ping);
      try {
        client.end();
      } catch {
        /* already closed */
      }
    };
    this.clients.add(client);
    out.write(`retry: 3000\nevent: init\ndata: ${JSON.stringify(this.snapshot())}\n\n`);
    const ping = setInterval(() => client.write(`: ping\n\n`), 15_000);
    req.raw.on("close", close);
    res.on("error", close);
  }

  close() {
    for (const c of [...this.clients]) {
      this.clients.delete(c);
      try {
        c.end();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * A fixed-window counter per key (client address). Enough to stop a public demo
 * from being hammered by one visitor; not a substitute for an edge rate limit.
 */
export class RateLimiter {
  private hits = new Map<string, { n: number; until: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.until <= now) {
      if (this.hits.size > 50_000) this.sweep(now);
      this.hits.set(key, { n: 1, until: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }

  private sweep(now: number) {
    for (const [k, h] of this.hits) if (h.until <= now) this.hits.delete(k);
  }
}
