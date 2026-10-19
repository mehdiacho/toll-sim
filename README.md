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

**Status:** steps 1 and 2 of 4 are done: the back-office core, and a SUMO traffic
simulation of the A1 streaming passages into it, with a live dashboard. See [Roadmap](#roadmap).

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
npm test            # 48 tests, about 6 s
npm run dev:lite    # API on :3000 + mock payments on :4000, data in .pglite/
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

Every route except `/health` and the provider callbacks needs `Authorization: Bearer <key>`.
The ingest key can only call `POST /passages`.

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

## Layout

```
db/migrations/     schema, triggers, audit hash chain
db/seed.sql        vehicle classes, A1 gantries, tariffs
src/app.ts         HTTP routes
src/services/      accounts, tariffs, passages, ledger, topups, violations, statements, audit
src/payments/      gateway client and callback signing
src/momo/          the mock mobile-money service
scripts/dev-lite.ts
dashboard/         operations dashboard (one HTML file) and the corridor map
sim/               SUMO network builder, demand generator, TraCI bridge
test/              end-to-end tests over real HTTP, with PGlite or Postgres
```

## Roadmap

1. **Back-office core.** Done.
2. **Traffic simulation.** Done. A SUMO scenario of the A1 from Gaborone to Mahalapye,
   built from OSM, streams passages from three virtual gantries over TraCI, with a
   live dashboard.
3. **ANPR.** Synthetic Botswana plates, a plate-reading model, and a review queue for
   low-confidence reads.
4. **Enforcement, disputes and a customer app.**

The tariffs and gantry positions are illustrative. They are not a published or
proposed Botswana toll schedule.
