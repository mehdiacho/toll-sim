# toll-sim

The back office for an open-road (free-flow) toll on Botswana's A1, built as a
portfolio project. There are no booths. Gantries read a plate or a tag as a vehicle
passes, and everything after that is software: matching the read to an account,
pricing it, taking the money, and following up when there isn't enough.

Botswana is expected to toll the A1 through a PPP. Gauteng's e-tolls are the
cautionary tale next door. They failed less on engineering than on billing that
people didn't trust, enforcement that couldn't keep up, and charges nobody could
check. That is why this back office has an append-only audit log, an exact
statement for every account, a grace period before any unpaid passage counts
against the driver, and payment through the channels Batswana already use:
Orange Money, MyZaka, Smega and card.

**Status:** all four steps are done: the back-office core, a SUMO traffic
simulation of the A1 streaming passages into it with a live dashboard, a plate
reader trained on synthetic Botswana plates with a human review queue for the reads
it isn't sure of, and enforcement, disputes and a mobile-first customer app. See
[Roadmap](#roadmap).

## What it does

- **Accounts, vehicles and tags.** A vehicle is registered by plate, with an optional
  tag id. A plate or tag can be live on only one account at a time.
- **Vehicle classes and versioned tariffs.** Five classes (M, 1–4) and a price per
  class per gantry. A price change closes the old row instead of overwriting it, so
  a passage from last month is always rated at last month's price.
- **Gantries.** Three virtual gantries between Gaborone and Mahalapye: Mmamashia,
  Artesia and Dibete.
- **Passage ingest.** `POST /passages` takes one read or a batch of up to 500. Each read
  is matched (tag first, then plate), rated, and either charged straight away or
  recorded as unpaid with a violation. It is idempotent on
  `(gantry_id, source_event_id)`, so a gantry that retries after a timeout never bills
  twice.
- **Top-ups through a mock mobile-money service.** A separate service stands in for
  Orange Money, MyZaka, Smega and a card acquirer. It answers `pending` at once, then
  sends a signed callback later. That callback can be late, repeated or never arrive,
  just like the real providers.
- **Statements.** For any period: opening balance, every entry, closing balance, and
  outstanding violations. They are built from the ledger alone, so they always add up.
- **Violations.** Unpaid passages get a due date (7 days by default). A top-up
  automatically clears the account's open violations, oldest first. A violation on an
  unregistered vehicle can be paid from any account, and an operator can waive one
  with a reason.
- **Audit log.** Every change writes a row in the same transaction. The table rejects
  `UPDATE`, `DELETE` and `TRUNCATE`, and each row's hash covers the previous row's.
  If someone with enough privilege to disable the triggers edits history anyway,
  `GET /audit/verify` points to the first broken row.

## Design choices worth a look

| Concern | How it's handled |
| --- | --- |
| Money | Integer thebe everywhere (1 BWP = 100 thebe). There are no floats. |
| Balance changes | One function (`ledger.post`) locks the account row, moves the balance and writes the ledger entry. A `CHECK (balance_thebe >= 0)` backs it up. |
| Double charging | Passages are unique on `(gantry_id, source_event_id)`. The ledger allows one toll per passage and one credit per top-up, enforced by partial unique indexes. |
| Concurrency | When 20 passages for one account arrive at once, exactly as many are charged as the balance covers (there's a test for this). |
| Callback trust | HMAC-SHA256 over `timestamp.body`, a 5-minute replay window, and constant-time comparison. A callback reporting a different amount from the one requested is refused, not credited. |
| Lost callbacks | `POST /admin/reconcile-topups` asks the provider about top-ups stuck in `pending`. |
| Class disputes | The registered class is billed. If the roadside classifier disagrees, the passage is flagged `class_mismatch` rather than silently re-priced. |
| Payment data | Wallet numbers are stored masked (`+267 71***567`). Cards arrive as tokens, so the service never sees a card number. |
| Audit integrity | The hash chain is assigned under an advisory lock, so concurrent writers can't fork it. |

## Running it

### Without Docker (PGlite)

[PGlite](https://pglite.dev) is real Postgres compiled to WASM. It runs in the Node
process, so nothing else has to be installed.

```sh
npm install
npm test            # 84 tests, about 16 s
npm run dev:lite    # API on :3000 + mock payments on :4000, data in .pglite/
                    # customer app: http://127.0.0.1:3000/app
```

### With Docker Compose (Postgres 17)

```sh
cp .env.example .env    # then change every value
docker compose up --build
```

This brings up `db` (Postgres), `momo` (the mock payment service) and `api` (the back
office). The API migrates and seeds itself on start.

To run the test suite against a real Postgres server instead of PGlite:

```sh
TEST_DATABASE_URL=postgres://user:pass@host:5432/empty_db npm test
```

The test run drops and recreates the `public` schema in that database. Point it at a
database you don't mind losing.

## A quick tour

```sh
H='authorization: Bearer dev-admin-key'; J='content-type: application/json'
API=http://127.0.0.1:3000

ACC=$(curl -s -H "$H" -H "$J" $API/accounts -d '{"holder_name":"Kagiso Molefe","phone":"71234567"}' | jq -r .id)
curl -s -H "$H" -H "$J" $API/accounts/$ACC/vehicles -d '{"plate":"B 123 ABC","vehicle_class":"1"}'
curl -s -H "$H" -H "$J" $API/accounts/$ACC/topups -d '{"provider":"orange_money","amount_thebe":10000,"msisdn":"72345678"}'
sleep 2   # the "customer" approves on their phone
curl -s -H 'authorization: Bearer dev-ingest-key' -H "$J" $API/passages \
  -d '{"source_event_id":"g01-000001","gantry_id":"A1-G01","passed_at":"2026-10-19T08:00:00Z","plate":"B123ABC"}'
curl -s -H "$H" $API/accounts/$ACC/statement | jq
curl -s -H "$H" $API/audit/verify
```

### Mock payment outcomes

| Payer | Outcome |
| --- | --- |
| wallet ending `0000` | failed: `insufficient_wallet_balance` |
| wallet ending `1111` | failed: `customer_cancelled` |
| wallet ending `9999` | succeeds, but the callback is never sent (use reconcile) |
| card token `tok_declined` | failed: `card_declined` |
| card token `tok_lost` | succeeds, no callback |
| anything else | succeeded |

## API

Every route except `/health`, the provider callbacks, the static pages and `/auth/*`
needs `Authorization: Bearer <key>`. The ingest key can only call `POST /passages`.
The `/me` routes take a customer session token instead, and an admin key is not one.

| Method | Path | |
| --- | --- | --- |
| GET | `/health` | |
| GET | `/vehicle-classes`, `/gantries`, `/tariffs?at=` | reference data |
| POST | `/tariffs` | schedule a new price |
| POST | `/accounts` | open an account |
| GET | `/accounts/:id` | |
| PATCH | `/accounts/:id/status` | suspend, reactivate or close, with a reason |
| POST / GET | `/accounts/:id/vehicles` | |
| DELETE | `/vehicles/:id` | deactivate (soft) |
| GET | `/accounts/:id/statement?from=&to=` | |
| POST | `/passages` | one read, or `{ "events": [...] }` |
| GET | `/passages?plate=&gantry_id=&account_id=&status=` | |
| POST | `/accounts/:id/topups` | honours `Idempotency-Key` |
| GET | `/topups/:id` | |
| POST | `/payments/callbacks/:provider` | signed provider callback |
| POST | `/admin/reconcile-topups` | |
| GET | `/violations?status=&account_id=&plate=` | |
| POST | `/violations/:id/settle`, `/violations/:id/waive` | |
| GET | `/audit?entity_type=&entity_id=`, `/audit/verify` | |
| GET | `/dashboard` | operations dashboard page (public; asks for the admin key) |
| GET | `/dashboard/data?window_minutes=60` | dashboard snapshot |
| GET | `/reviews?status=open&gantry_id=` | plate review queue, oldest first |
| GET | `/reviews/:id`, `/reviews/:id/image` | one review and its camera crop |
| POST | `/reviews/:id/resolve` | `confirmed`, `corrected` (with `plate`) or `unreadable` |
| GET | `/dashboard/review` | keyboard-driven review page |
| POST | `/admin/run-enforcement` | run the enforcement ladder now (`{ "at": ... }` to fast-forward) |
| GET | `/enforcement/hotlist`, `/admin/outbox?kind=` | referred plates; every notice "sent" |
| GET / POST | `/disputes?status=` | dispute queue; raise one for a motorist |
| GET | `/disputes/:id`, `/disputes/:id/evidence/:evidenceId` | one dispute with passage, history and evidence |
| POST | `/disputes/:id/resolve` | `upheld` (optionally with `corrected_class`) or `rejected`, with a note |
| GET | `/passages/:id/image` | camera crop kept for review |
| GET | `/dashboard/disputes` | dispute and enforcement desk |
| POST | `/auth/code`, `/auth/verify`, `/auth/logout` | customer SMS sign-in and sign-up |
| GET / PATCH | `/me` | home summary; update name or email |
| POST / DELETE | `/me/vehicles`, `/me/vehicles/:id` | |
| GET | `/me/passages`, `/me/passages/:id/image`, `/me/statement?from=&to=` | |
| POST / GET | `/me/topups`, `/me/topups/:id` | mobile-money top-up, honours `Idempotency-Key` |
| GET / POST | `/me/violations`, `/me/violations/:id/pay` | |
| GET / POST | `/me/disputes`, `/me/disputes/:id` | |
| GET | `/me/notices` | SMS, email and letters sent to this account |
| GET | `/app` | the customer web app |

## Traffic simulation (step 2)

`sim/` drives the back office with simulated traffic on the A1 between Gaborone and
Mahalapye.

- **`build_network.py`** cuts the A1 out of the Geofabrik Botswana extract and runs
  `netconvert` with left-hand traffic. The result is a 213 km dual carriageway in
  each direction. It places the three gantries next to Mmamashia, Artesia and Dibete
  (the km and coordinates in `db/seed.sql` come from this script), with an
  induction loop on every lane. It also writes the corridor map the dashboard draws.
- **`demand.py`** writes the traffic: through, local and regional flows, about 1,100
  vehicles an hour. The vehicle mix maps onto the toll classes, and each vType id is
  its class code.
- **`bridge.py`** runs SUMO over TraCI. The first time, it creates a synthetic fleet
  through the API: 1,200 accounts and about 2,600 vehicles with Botswana plates. Some
  have tags and some are fleet operators. They are funded through the mock
  mobile-money top-ups, and about 1 in 8 accounts is kept short on purpose. Each
  vehicle that enters the network becomes a registered vehicle of its class (85%) or
  an unregistered one. Each gantry crossing becomes a read with realistic noise: 1% of
  tag reads are missed, 2% of plates are misread with OCR-style confusions such as
  8↔B and 0↔D, and 3% of vehicles get the wrong class. Reads are posted to
  `/passages` in batches on a simulated clock. When a passage comes back unpaid for
  lack of funds, the owner tops up half the time, which settles the violation in the
  back office.

The dashboard at `http://127.0.0.1:3000/dashboard` shows the corridor map with the
gantries pulsing as reads arrive, plus passages per minute, revenue, the class mix,
top-ups by provider, violations and a live passage feed.

### Running it

You need Python 3.11+. SUMO comes from pip, so it doesn't need a separate install.

```sh
cd sim
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt        # .venv/bin/pip on Linux/macOS
# about 90 MB from download.geofabrik.de
curl -o data/osm/botswana-latest.osm.pbf --create-dirs https://download.geofabrik.de/africa/botswana-latest.osm.pbf
.venv/Scripts/python build_network.py                # net/a1.net.xml, gantries, corridor map
.venv/Scripts/python demand.py --hours 2             # net/a1.rou.xml
```

Then start the back office (`npm run dev:lite` in the repo root) and:

```sh
.venv/Scripts/python bridge.py                       # 10x real time, headless
.venv/Scripts/python bridge.py --gui                 # watch it in sumo-gui
.venv/Scripts/python bridge.py --speed 0 --hours 1   # as fast as possible
```

The fleet is saved to `sim/out/fleet.json` and reused while the back office still
has it. Delete `.pglite/` for a clean slate. `bridge.py --help` lists the noise and
behaviour knobs. A simulated hour at the defaults gives roughly 77% charged, 16%
unregistered and 6% short of funds.

## Plate reading and review (step 3)

`anpr/` is a number-plate reader trained entirely on synthetic images, and the back
office holds any read it isn't sure of for a person to check.

- **`plates.py`** draws Botswana plates (`B 123 ABC` on white or yellow, a flag strip
  and a `BOTSWANA` caption on some, a few personalised and older formats) in five
  fonts, then degrades them the way a gantry camera does: perspective from above the
  lane, roll, motion blur, night-time infrared, shadow, glare, dirt, exposure, noise,
  low resolution and JPEG. It renders about 280 crops a second per core, so training
  never sees the same image twice. The layout is illustrative, not the official spec.
- **`model.py`** is a small CRNN (conv layers, a 2-layer BiLSTM, CTC), about 3 M
  parameters. Its confidence is the product of the per-character probabilities on the
  decoded path, and it offers runner-up readings by swapping the least certain
  characters.
- **`train.py`** trains it on the GPU (an RTX 3060 laptop here) with mixed precision.
  **`evaluate.py`** scores it on held-out renders in three difficulty bands, picks
  the review threshold and exports ONNX. **`server.py`** serves the ONNX model on CPU:
  `POST /read` takes a crop, and `POST /capture` renders a plate and reads it, which
  is what the simulation uses.

The results are in [`anpr/out/metrics.json`](anpr/out/metrics.json). The threshold is
the lowest confidence at which automatic reads are at least 99.9% right. Below it a
read goes to review.

**Review queue.** A plate-only read (no tag) below `REVIEW_CONFIDENCE_THRESHOLD`
(default 0.96, from `evaluate.py`) is stored with status `review`, together with the crop and the model's
alternatives. Nobody is charged and no violation is raised while it waits. At
`/dashboard/review` a reviewer sees the crop and the candidates. Enter confirms (or
saves an edited plate), a number key picks an alternative, and Esc marks the plate
unreadable. A confirmed or corrected plate is then rated exactly like an automatic
read, with `match_method = 'manual'`, and its grace period starts from the decision,
not the passage. An unreadable one is waived. Every decision is in the audit log, and
a review can't be resolved twice.

The thinking: an automatic read that bills the wrong person is the most expensive
mistake a free-flow toll can make. It costs money to undo, and it costs the public
trust that e-tolls lost. So the system bills automatically only when it's sure, and
it sizes the human workload from measured accuracy instead of a guess.

### Running it

```sh
cd anpr
python -m venv .venv
.venv/Scripts/pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python plates.py out/samples.png      # contact sheet of synthetic crops
.venv/Scripts/python train.py                       # out/crnn.pt
.venv/Scripts/python evaluate.py                    # out/metrics.json, out/crnn.onnx
.venv/Scripts/python server.py                      # http://127.0.0.1:4100
```

The exported `out/crnn.onnx` is committed, so the service runs without training
first (it needs only `onnxruntime`, `pillow` and `numpy`). Then run the simulation
through the reader:

```sh
cd sim && .venv/Scripts/python bridge.py --speed 0 --hours 1 --anpr http://127.0.0.1:4100
```

## Enforcement, disputes and the customer app (step 4)

**Enforcement.** An unpaid passage starts in a grace period (7 days). After that it
climbs a ladder, one step per run of the enforcement job (hourly by default):

| Stage | When | What happens |
| --- | --- | --- |
| `grace` | from the passage | nothing; paying costs only the toll |
| `notice` | grace ends | first notice, plus a P50 admin fee |
| `final_notice` | 14 days later | final notice, plus a P150 late fee |
| `referred` | 14 days after that | the plate goes on the hotlist for roadside enforcement |

Each step is its own transaction with an audit row and a notice in the outbox. A
registered motorist gets an SMS (and an email if they gave one). An unregistered
plate gets a letter addressed to the registered keeper. Nothing is really sent: the
outbox is the record. The job is idempotent and catches up, so a violation that has
been overdue for a month goes through every step in one run, but is still charged
each fee only once. A violation under dispute is skipped. When a referred plate
passes a gantry again, the passage records the hotlist hit. Fees are posted to the
ledger as separate `penalty` lines, so the statement shows the toll and the fees
apart, and a top-up settles both.

**Disputes.** A motorist can contest any passage on their account within 90 days:
not my vehicle, plate misread, wrong class, already paid, or other. They can attach
up to three photos or PDFs (2 MB each, checked by content, not by the file name).
There can be only one open dispute per passage, and none after one has been upheld.
While a dispute is open, enforcement is paused for that violation. An operator
decides at `/dashboard/disputes`, which shows the claim, the evidence, the camera
crop, the passage facts, the account's registered vehicles and the full audit
trail. The decision needs a note.

- **Upheld** waives an open violation along with its fees, or refunds a toll that
  was already charged.
- **Upheld with a corrected class** re-rates the passage at the right class. It
  refunds the difference and never raises the charge.
- **Rejected** gives back the time the dispute was open, so contesting a charge
  doesn't cost the motorist their grace period.

The motorist is notified either way, and every step is in the audit log.

**Customer app.** `/app` is a mobile-first web app (one HTML file, no build step,
installable through its manifest). People sign in with a code sent by SMS. An
unknown number is asked for a name and becomes a new account. Sessions last 30 days
and are stored hashed. In the app a motorist can:

- register vehicles
- top up through the mock mobile money and watch the payment complete
- see trips with the gantry and the camera image, and monthly statements
- pay violations, including ones from before they registered the plate
- raise and follow disputes
- read every notice sent to them

The `/me` routes only ever see the signed-in account's own data, and there is a test
that checks this. With `EXPOSE_LOGIN_CODES=1` (on in `dev:lite`, off by default) the
sign-in code comes back in the API response, so the demo works without an SMS
gateway.

**Known limitation.** Registering a plate in the app is taken on trust. A real
operator would check ownership against the national vehicle registry before letting
someone see, dispute or pay that plate's passages. That integration is out of scope
here.

## The always-on public demo

`deploy/` runs the whole thing unattended on a small home server behind a Cloudflare
tunnel: Postgres, the payment mock, the plate reader, the API and the SUMO bridge in
`--live` mode (real time, demand by time of day, forever). Only the API is published.

```sh
# on the server, from a copy of this repo at $DATA_DIR/src
sh deploy/nas.sh up      # generates $DATA_DIR/.env with random secrets the first time
sh deploy/nas.sh ps
sh deploy/nas.sh logs sim
```

What makes it safe to leave on a public URL:

| Setting | Effect |
| --- | --- |
| `BASE_PATH=/projects/toll-sim/live` | every route also answers under the prefix; the pages' root-relative links and API calls are rewritten to it |
| `PUBLIC_DASHBOARD=1` | the dashboard numbers need no key (they are synthetic); every write still does |
| `DEMO_SIGNIN=1` | the motorist app signs in with a sandbox account only. Nobody is asked for a phone number, PIN, card or ID, and top-ups pick a simulated wallet outcome |
| `DEMO_ACCOUNT_HOURS=24` | sandbox accounts are closed after a day: sessions revoked, plates released, account closed, all audited (nothing is deleted) |
| `DEMO_RESET_HOUR=3` | at 03:00 CAT the database is wiped and re-seeded so the disk never fills; the bridge sees the new epoch on `/health` and restarts with a fresh fleet |
| `TRUST_PROXY=1` | rate limits key on `CF-Connecting-IP`; without it that header is ignored |

The sandbox account gets a plate the simulation has on the road right now when it
can, so the visitor can watch their own car reach the next gantry. Every page carries
a notice that this is an independent demo with synthetic data, the API sends a CSP and
the usual security headers, public bodies are capped at 1 MB, and container logs
rotate at 3 x 10 MB.

## 3D live viewer and landing page

`viewer/` is a standalone Vite + three.js site with its own `package.json`. It is
built for the public path `/projects/toll-sim/`:

```bash
cd viewer
npm ci
npm run build      # output in viewer/dist, served at /projects/toll-sim/
npm run preview    # http://localhost:4173/projects/toll-sim/
```

Routes use the hash, so the site works from any static host:

- `#/` is the landing page. It has a corridor map drawn from `road.json`, links to
  the 3D view and the operations dashboard (`/projects/toll-sim/live/dashboard`),
  and "Source on request".
- `#/live` is the 3D view of the A1. It draws the road from the exported SUMO
  network, interpolates vehicles between frames, lights the scene for the current
  time in Botswana (UTC+2, sun position and night lighting included), and flashes
  the gantry portal on every read. It has an event ticker, a click-to-inspect
  vehicle card, and overview, follow, gantry and director cameras.

**Data.** The viewer subscribes to the SSE stream at
`/projects/toll-sim/live/live/stream`. If the stream doesn't answer within a few
seconds, or the bridge says it isn't live, the viewer plays `viewer/public/replay.json`
instead, and probes for the live stream about once a minute. The HUD badge shows
**Live** or **Replay**. The replay is a synthetic five-minute recording, about
1.1 MB delta-encoded, made by `npm run replay` (`viewer/scripts/make-replay.mjs`).
Traffic keeps left, as it does in Botswana. `road.json` is copied from `live/road.json`
at build time.

**URL options** for links and captures:
`#/live?cam=overview|follow|free|gantry:A1-G01:N&time=auto|day|dusk|night|HH:MM&replay`.
`replay` skips the live stream.

Screenshots and a short clip are in `docs/portfolio/`: `cover.png` (1600x900),
`landing.png`, `overview.png`, `follow.png`, `gantry-read.png`, `night.png`,
`mobile.png`, and `clip.mp4` / `clip.webm`.

## Layout

```
db/migrations/     schema, triggers, audit hash chain
db/seed.sql        vehicle classes, A1 gantries, tariffs
src/app.ts         HTTP routes
src/services/      accounts, tariffs, passages, reviews, ledger, topups, violations, statements, audit,
                   enforcement, disputes, customers, outbox
src/payments/      gateway client and callback signing
src/momo/          the mock mobile-money service
scripts/dev-lite.ts
dashboard/         operations dashboard, review page, dispute desk and the corridor map
customer/          the customer web app and its manifest
live/              the live feed page and the 3D road geometry
site/              the demo's landing page
deploy/            compose file, Dockerfiles and script for the always-on demo
sim/               SUMO network builder, demand generator, TraCI bridge
anpr/              synthetic plates, CRNN plate reader, ONNX service
test/              end-to-end tests over real HTTP, with PGlite or Postgres
viewer/            public 3D viewer and landing page (Vite, three.js)
```

## Roadmap

1. **Back-office core.** Done.
2. **Traffic simulation.** Done. A SUMO scenario of the A1 from Gaborone to Mahalapye,
   built from OSM, streams passages from three virtual gantries over TraCI, with a
   live dashboard.
3. **ANPR.** Done. Synthetic Botswana plates, a CRNN plate reader trained on them,
   and a review queue for low-confidence reads.
4. **Enforcement, disputes and a customer app.** Done. An escalating notice and fee
   ladder ending in a hotlist, audited disputes with evidence, and a mobile-first
   customer app with SMS sign-in.

The tariffs, fees and gantry positions are illustrative. They are not a published or
proposed Botswana toll schedule.
