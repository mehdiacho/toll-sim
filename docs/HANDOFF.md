# Handoff: toll-sim

Start here if you are picking this project up cold. The README covers the system in depth: the
back office, the SUMO bridge, ANPR and the viewer. This file covers where things are, how to run
and deploy them, the decisions made so far, and what's next. Update it in the same commit as any
milestone.

Last updated 2026-10-20.

## Where it is

- **Local checkout:** `X:\Projects\toll-sim`, private `mehdiacho/toll-sim`, branch `main`.
- **CI** (GitHub Actions) runs typecheck, the tests on PGlite and Postgres 17, and a docker
  compose smoke test. It must be green before anything is pushed to `main`.
- **Unreal v2:** `X:\Projects\toll-sim-unreal`, private `mehdiacho/toll-sim-unreal`. Read its
  `docs/HANDOFF.md`.
- **Toolchain:**
  - Node 24.
  - Python 3 with a venv per subproject (`sim/`, `anpr/`).
  - Eclipse SUMO 1.28 at `C:\Program Files (x86)\SUMO` (`SUMO_HOME` is set).
  - CUDA torch, for ANPR training only.
- **Dated decisions:** Mehdi's worklog, `X:\ai.tools\worklog\projects\toll-sim.md`. The key ones
  are copied below.

## Current state

- **Back office:** TypeScript and Fastify on Postgres (PGlite locally), with a mock mobile-money
  service.
- **Simulation:** a SUMO scenario of the A1 from Gaborone to Mahalapye with three
  South-African-style mainline plazas: Mmamashia, Artesia and Dibete.
- **ANPR:** reads synthetic plates.
- **Viewer:** the three.js live viewer (`viewer/`), the public face of the project.
- **Live demo:** runs 24/7 on the NAS.

## Run it locally

```sh
cd X:/Projects/toll-sim
npm ci
npm run typecheck
npm test                      # vitest, on PGlite
npm run dev:lite              # API on :3000 + mock payments on :4000, data in .pglite/

# simulation (separate shell)
cd sim
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python bridge.py                       # 10x real time, headless, into the API above
.venv/Scripts/python bridge.py --gui                 # watch it in sumo-gui

# viewer
cd viewer && npm ci && npm run dev     # npm run build -> viewer/dist, served at /projects/toll-sim/
npm run replay                         # regenerate viewer/public/replay.json from a sim run
```

**The SUMO network is committed** (`sim/net/a1.net.xml`, `a1.rou.xml`, `gantries.add.xml`,
`corridor.json`). Only the OSM extract in `sim/data/osm/` is git-ignored. To rebuild the network
from scratch:

```sh
cd sim
# ~90 MB from Geofabrik. A download, so get Mehdi's OK first.
curl -o data/osm/botswana-latest.osm.pbf --create-dirs https://download.geofabrik.de/africa/botswana-latest.osm.pbf
.venv/Scripts/python build_network.py      # cuts the A1 out, runs netconvert (left-hand traffic)
.venv/Scripts/python demand.py --hours 2   # net/a1.rou.xml
```

ANPR (`anpr/`) has its own venv and training commands in the README, under the ANPR section.

## Hosting

| Piece | Where | Notes |
|---|---|---|
| Live demo stack | NAS `192.168.0.2` (dxp2800, ssh host `nassync`), `/volume4/v4/toll-sim` (`src/`, `pg/`, `sim-data/`, and `.env` with generated secrets, mode 600) | 5 containers from `deploy/docker-compose.nas.yml`, compose project `toll-sim`: `db` (Postgres), `momo` (payment mock), `api`, `anpr`, and `sim` (SUMO bridge in `--live` mode). Only the API is published, on host port **8796**. |
| Tunnel | Cloudflare tunnel hostname `toll-sim-origin.mehdiacho.tech` → `http://192.168.0.2:8796` | Mehdi set it up in the dashboard. DNS and tunnel changes are his to make. |
| Public live path | `https://mehdiacho.tech/projects/toll-sim/live/*` | The `projects-proxy` Worker (source in `projects-proxy/` of `mehdiacho/mehdiacho.github.io`) forwards it to the tunnel. The API runs with `BASE_PATH=/projects/toll-sim/live`. |
| Static 3D viewer | `https://mehdiacho.tech/projects/toll-sim/` | Built from `viewer/` and served by the portfolio's Cloudflare Pages site. It falls back to the bundled replay if the feed is down. |

The demo safety settings are described in the README under "The always-on public demo":

- `PUBLIC_DASHBOARD`
- `DEMO_SIGNIN`
- `DEMO_ACCOUNT_HOURS`
- `DEMO_RESET_HOUR=3`
- `TRUST_PROXY`

## Deploy to the NAS

Push to `main` with CI green, then run this from the local checkout:

```sh
git archive HEAD | ssh nassync 'rm -rf /volume4/v4/toll-sim/src && mkdir -p /volume4/v4/toll-sim/src && tar -x -C /volume4/v4/toll-sim/src'
ssh nassync 'cd /volume4/v4/toll-sim/src && sh deploy/nas.sh up'
ssh nassync 'cd /volume4/v4/toll-sim/src && sh deploy/nas.sh ps'
```

- `/volume4/v4/toll-sim/.env` already holds the secrets. Never regenerate it, print it or commit
  it.
- The NAS has no sftp, so everything goes through ssh pipes.
- `sh deploy/nas.sh logs sim` follows a service's logs.

Then verify:

- `https://mehdiacho.tech/projects/toll-sim/live/` returns 200.
- `/live/dashboard` works (no trailing slash).
- `/live/live/snapshot` includes `booms`, `lanes_open` and `stats.plazas`.

Viewer changes reach the public page through the portfolio's Pages deploy. Portfolio merges need
Mehdi's OK.

The database is wiped and re-seeded nightly at 03:00 CAT.

## Decisions so far

- **Full South-African-style mainline plazas** instead of open-road gantries: five lanes per
  direction (heavy, heavy, mixed, mixed, e-tag), with booms, booths and a canopy. Mehdi confirmed
  "Full plazas".
- **Cash service stays at 8–12 s.** Manual lanes that give change are slow, and the queues are
  part of the show. Cash lanes top out near 300 veh/h, against 450–600 at real SA plazas.
- **Lane spacing is a viewer-side remap.** The sim packs plaza lanes edge to edge, and
  `plaza-layout.js` re-spaces them for drawing.
- **The public demo has safeguards:**
  - synthetic data only;
  - sandbox sign-in, with no phone number, PIN, card or ID ever asked for;
  - sandbox accounts close after 24 h;
  - a nightly reset;
  - CSP, rate limits keyed on `CF-Connecting-IP`, and a 1 MB body cap;
  - a demo notice on every page.
- **Hosting split:** the static 3D viewer is on Pages; the live server runs on the NAS behind the
  `projects-proxy` Worker and a tunnel. The web 3D view stays the public link.
- **v2 is Unreal Engine 5.** SUMO stays authoritative and Unreal only reads the feed. It is shown
  as clips plus a Windows download (see toll-sim-unreal).

## Next steps and open asks

- **v2 (toll-sim-unreal):**
  - M3: the 30 s dusk clip.
  - M4: post-processing and hero stills.
  - M5: clips on the project page and a packaged build on R2.
- If the feed format, plaza layout or vehicle class lengths change here, re-run
  `toll-sim-unreal/Scripts/sync-data.sh` and its GoldenPositions test.
- Open for Mehdi:
  - whether to raise cash throughput, which means shorter service times;
  - any portfolio merges;
  - any Cloudflare DNS or tunnel changes.

## Conventions

See `CLAUDE.md`. Commit as `mehdiacho <mehdiacho@gmail.com>`. No `Co-Authored-By`, AI trailers
or "Generated with" lines, and no model names. Never commit secrets.
