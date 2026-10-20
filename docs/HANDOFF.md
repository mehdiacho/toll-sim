# Handoff: toll-sim

Start here if you are picking this project up cold. The README covers the system itself (the
back office, the SUMO bridge, ANPR and the viewer). This file covers what is running where and
how to change it.

Last updated 2026-10-20.

## Current state

- **Back office:** TypeScript and Node 24, Fastify, Postgres (PGlite in tests and
  `npm run dev:lite`). It includes a mock mobile-money service.
- **Simulation:** a SUMO scenario of the A1 from Gaborone to Mahalapye, with three mainline toll
  plazas (Mmamashia, Artesia, Dibete). It runs as an always-on live demo.
- **ANPR:** synthetic plates.
- **Viewer:** a three.js live viewer (`viewer/`), the public face of the project.
- **CI** must be green before anything is pushed to `main`.
- **v2:** an Unreal Engine 5 rendering of the same corridor, in progress in a separate repo
  (below).

## Hosting

| Piece | Where | Notes |
|---|---|---|
| Live demo stack | NAS `192.168.0.2` (dxp2800), `/volume4/v4/toll-sim` (`src/`, `pg/`, `sim-data/`, `.env` with generated secrets, mode 600) | 5 containers from `deploy/docker-compose.nas.yml`, project `toll-sim`: `db` (Postgres), `momo` (payment mock), `api`, `anpr`, `sim` (SUMO bridge in `--live` mode). Only the API is published, on host port **8796**. |
| Tunnel | Cloudflare tunnel hostname `toll-sim-origin.mehdiacho.tech` → `http://192.168.0.2:8796` | Mehdi set this up himself in the dashboard. DNS and tunnel changes are his to make. |
| Public live path | `https://mehdiacho.tech/projects/toll-sim/live/*` | The `projects-proxy` Worker (source in `projects-proxy/` of `mehdiacho/mehdiacho.github.io`) forwards it to the tunnel hostname. The API runs with `BASE_PATH=/projects/toll-sim/live`. |
| Static 3D viewer | `https://mehdiacho.tech/projects/toll-sim/` | Built from `viewer/` and served by the portfolio's Cloudflare Pages site. It falls back to the bundled replay if the feed is down. |

The demo safety settings (`PUBLIC_DASHBOARD`, `DEMO_SIGNIN`, `DEMO_ACCOUNT_HOURS`,
`DEMO_RESET_HOUR=3`, `TRUST_PROXY`) are in the README under "The always-on public demo".

## Deploy

1. Push to `main` with CI green.
2. Update the repo copy on the NAS at `/volume4/v4/toll-sim/src`. SSH host `nassync` reaches
   it. The NAS has no sftp, so copy over ssh pipes, for example with `git archive` or a `tar`
   piped through `ssh`.
3. On the NAS, from that directory:
   - `sh deploy/nas.sh up` builds and restarts. On the first run it also generates `../.env`.
   - Then check with `sh deploy/nas.sh ps` and `sh deploy/nas.sh logs sim`.
4. Verify the public URLs:
   - `https://mehdiacho.tech/projects/toll-sim/live/` returns 200;
   - `/live/dashboard` works (no trailing slash);
   - `/live/live/snapshot` has `booms`, `lanes_open` and `stats.plazas`.
5. Viewer changes reach the public page through the portfolio's Pages deploy. Portfolio merges
   need Mehdi's OK.

The database is wiped and re-seeded nightly at 03:00 CAT, so nothing on the NAS needs pruning.

## v2: Unreal

[mehdiacho/toll-sim-unreal](https://github.com/mehdiacho/toll-sim-unreal) (private) lives at
`X:\Projects\toll-sim-unreal`. Read its `docs/HANDOFF.md` and `CLAUDE.md`. It consumes this
repo's feed and data:

- `Scripts/sync-data.sh` copies `viewer/public/replay.json` and `live/road.json`.
- It runs `viewer/scripts/export-golden.mjs` and `export-plazas.mjs`.

Changes to the feed format, plaza layout or class lengths therefore need a re-sync there, and
its GoldenPositions test re-run. The original plan is `docs/v2-unreal-plan.md`.

## Conventions

- Commit as `mehdiacho <mehdiacho@gmail.com>`. No `Co-Authored-By`, AI trailers or "Generated
  with" lines.
- Never commit secrets; the NAS `.env` stays on the NAS.
- Dated decisions are in Mehdi's worklog, `X:\ai.tools\worklog\projects\toll-sim.md`.
