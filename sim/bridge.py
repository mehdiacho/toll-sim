"""Drive the A1 simulation and stream gantry passages into the back office.

  1. Creates (or reuses) a synthetic fleet in the back office: accounts, vehicles
     with Botswana plates, some with tags, funded through the mock mobile-money
     top-up flow. A few accounts are left short on purpose.
  2. Runs SUMO via TraCI. Each vehicle that enters the network is given an
     identity: usually a registered vehicle of its class, sometimes an
     unregistered one.
  3. Every simulation step it reads the gantries' induction loops and turns each
     crossing into a gantry read, with realistic noise: missed tag reads, camera
     misreads and the odd wrong classification. With --anpr, plates are instead
     rendered as camera crops and read by the trained model (anpr/server.py), and
     low-confidence reads carry the image so they can go to the review queue.
  4. Reads are POSTed to /passages in batches, timestamped on a simulated clock.
     When the back office reports a passage unpaid for lack of funds, the owner
     sometimes tops up, which settles the debt on the back office side.

Usage (back office running, e.g. `npm run dev:lite` in the repo root):
  .venv/Scripts/python bridge.py                 # headless, 10x real time
  .venv/Scripts/python bridge.py --gui           # watch it in sumo-gui
  .venv/Scripts/python bridge.py --speed 0       # as fast as possible
  .venv/Scripts/python bridge.py --anpr http://127.0.0.1:4100   # real plate reader
"""

from __future__ import annotations

import argparse
import json
import os
import random
import string
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import sumolib
import traci

HERE = Path(__file__).resolve().parent
CORRIDOR = HERE / "net" / "corridor.json"
CLASSES = ["M", "1", "2", "3", "4"]
PROVIDERS = ["orange_money", "myzaka", "smega", "card"]


# --------------------------------------------------------------------------- API


class Api:
    def __init__(self, base: str, admin_key: str, ingest_key: str):
        self.base = base.rstrip("/")
        self.admin_key = admin_key
        self.ingest_key = ingest_key

    def call(self, method: str, path: str, body=None, ingest: bool = False, timeout: float = 30):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("authorization", f"Bearer {self.ingest_key if ingest else self.admin_key}")
        if data is not None:
            req.add_header("content-type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                text = res.read().decode()
                return res.status, json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            return e.code, json.loads(text) if text else None


def http_json(url: str, body: dict, timeout: float = 10):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# ------------------------------------------------------------------------- fleet


@dataclass
class FleetVehicle:
    plate: str
    vehicle_class: str
    account_id: str
    tag_id: str | None = None
    vehicle_id: str | None = None


@dataclass
class Fleet:
    api_base: str
    vehicles: list[FleetVehicle] = field(default_factory=list)
    accounts: list[str] = field(default_factory=list)


def random_plate(rng: random.Random) -> str:
    """Standard Botswana private plate, B 123 ABC (stored without spaces)."""
    return f"B{rng.randint(100, 999)}{''.join(rng.choices(string.ascii_uppercase, k=3))}"


def random_msisdn(rng: random.Random) -> str:
    return f"7{rng.choice('1234567')}{rng.randint(100000, 999999)}"


def wait_topup(api: Api, topup_id: str, timeout: float = 15) -> str:
    until = time.time() + timeout
    while time.time() < until:
        _, t = api.call("GET", f"/topups/{topup_id}")
        if t and t.get("status") != "pending":
            return t["status"]
        time.sleep(0.3)
    return "pending"


def topup(api: Api, rng: random.Random, account_id: str, amount: int, wait: bool = True) -> str:
    provider = rng.choices(PROVIDERS, weights=[45, 25, 20, 10])[0]
    body = {"provider": provider, "amount_thebe": amount}
    if provider == "card":
        body["card_token"] = rng.choice(["tok_visa_4242", "tok_mc_5454", "tok_visa_1881"])
    else:
        # About 1 in 20 wallets is empty, so some top-ups fail like real ones do.
        body["msisdn"] = random_msisdn(rng)[:4] + "0000" if rng.random() < 0.05 else random_msisdn(rng)
    status, t = api.call("POST", f"/accounts/{account_id}/topups", body)
    if status != 202:
        return "rejected"
    return wait_topup(api, t["id"]) if wait else "pending"


def create_fleet(api: Api, rng: random.Random, n_accounts: int) -> Fleet:
    fleet = Fleet(api_base=api.base)
    first = ["Kagiso", "Neo", "Mpho", "Lesego", "Tumelo", "Onalenna", "Boitumelo", "Kabelo", "Masego", "Thato"]
    last = ["Molefe", "Sebego", "Kgosi", "Mothibi", "Seretse", "Modise", "Tau", "Ramotswa", "Dintwe", "Moremi"]
    fleets = [f"{a} {b}" for a in ("Kalahari", "Mahalapye", "Seabelo", "Gaborone", "Tswapong", "Limpopo")
              for b in ("Freight", "Haulage", "Express", "Bus Services", "Logistics")]
    seen: set[str] = set()

    def new_plate() -> str:
        while True:
            p = random_plate(rng)
            if p not in seen:
                seen.add(p)
                return p

    def build_account(i: int):
        local = random.Random(rng.random())
        operator = i < len(fleets)
        name = fleets[i] if operator else f"{local.choice(first)} {local.choice(last)}"
        status, acc = api.call("POST", "/accounts", {"holder_name": name, "phone": random_msisdn(local)})
        if status != 201:
            raise SystemExit(f"could not create account: {status} {acc}")
        # Operators run several heavy vehicles; households one or two cars.
        if operator:
            classes = local.choices(["2", "3", "4"], weights=[30, 30, 40], k=local.randint(12, 30))
        else:
            classes = local.choices(CLASSES[:3], weights=[4, 90, 6], k=local.choice([1, 1, 1, 2, 2, 3]))
        vehicles = []
        for cls in classes:
            with lock:
                plate = new_plate()
            tag = f"BW{local.randint(10**9, 10**10 - 1)}" if local.random() < (0.8 if operator else 0.35) else None
            body = {"plate": plate, "vehicle_class": cls, **({"tag_id": tag} if tag else {})}
            s, v = api.call("POST", f"/accounts/{acc['id']}/vehicles", body)
            if s == 201:
                vehicles.append(FleetVehicle(plate, cls, acc["id"], tag, v["id"]))
        # Most accounts are funded properly; about 1 in 8 runs on fumes.
        amount = local.choice([2000, 3000]) if local.random() < 0.125 else local.choice([20000, 50000, 100000])
        if operator:
            amount = 500000
        topup(api, local, acc["id"], amount)
        return acc["id"], vehicles

    lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=16) as pool:
        for account_id, vehicles in pool.map(build_account, range(n_accounts)):
            fleet.accounts.append(account_id)
            fleet.vehicles.extend(vehicles)
    return fleet


def load_or_create_fleet(api: Api, rng: random.Random, path: Path, n_accounts: int, fresh: bool) -> Fleet:
    if path.exists() and not fresh:
        data = json.loads(path.read_text(encoding="utf-8"))
        fleet = Fleet(data["api_base"], [FleetVehicle(**v) for v in data["vehicles"]], data["accounts"])
        status, _ = api.call("GET", f"/accounts/{fleet.accounts[0]}") if fleet.accounts else (404, None)
        if fleet.api_base == api.base and status == 200:
            print(f"reusing fleet: {len(fleet.accounts)} accounts, {len(fleet.vehicles)} vehicles ({path.name})")
            return fleet
        print("saved fleet does not match this back office; creating a new one")
    t0 = time.time()
    fleet = create_fleet(api, rng, n_accounts)
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(asdict(fleet), indent=1), encoding="utf-8")
    print(f"created fleet: {len(fleet.accounts)} accounts, {len(fleet.vehicles)} vehicles in {time.time() - t0:.0f}s")
    return fleet


# ---------------------------------------------------------------- roadside noise

# Characters an OCR engine confuses on plates.
CONFUSIONS = {"0": "D", "D": "0", "8": "B", "B": "8", "1": "I", "5": "S", "S": "5", "2": "Z", "Z": "2", "6": "G", "O": "0"}


@dataclass
class Identity:
    plate: str
    true_class: str
    tag_id: str | None
    registered: bool


def misread(plate: str, rng: random.Random) -> str:
    i = rng.randrange(1, len(plate))  # the leading B is read reliably
    ch = plate[i]
    sub = CONFUSIONS.get(ch) or rng.choice(string.ascii_uppercase if ch.isalpha() else string.digits)
    return plate[:i] + sub + plate[i + 1 :]


def gantry_read(ident: Identity, rng: random.Random, args) -> dict:
    read: dict = {}
    if ident.tag_id and rng.random() > args.tag_miss_rate:
        read["tag_id"] = ident.tag_id
    if args.anpr:
        # The real reader: render the plate as the gantry camera would capture it and read it.
        # Most passages are easy; a tail are night, rain, dirt or a fast lane change.
        difficulty = min(1.6, rng.betavariate(2, 3) * 2)
        status, r = http_json(f"{args.anpr}/capture", {"plate": ident.plate, "difficulty": difficulty, "seed": rng.getrandbits(32)})
        if status != 200:
            raise RuntimeError(f"ANPR service: {status} {r}")
        read["plate"] = r["plate"] or None
        read["read_confidence"] = r["confidence"]
        read["read_candidates"] = r["candidates"][:5]
        if r["confidence"] < args.review_threshold:
            read["image_b64"] = r["image_b64"]  # only reads that may go to a reviewer carry the crop
    elif rng.random() < args.misread_rate:
        read["plate"] = misread(ident.plate, rng)
        read["read_confidence"] = round(rng.uniform(0.55, 0.85), 3)
    else:
        read["plate"] = ident.plate
        read["read_confidence"] = round(min(0.999, rng.betavariate(30, 1.2)), 3)
    cls = ident.true_class
    if rng.random() < args.misclass_rate:
        i = CLASSES.index(cls)
        cls = CLASSES[max(0, min(len(CLASSES) - 1, i + rng.choice([-1, 1])))]
    read["detected_class"] = cls
    return read


# ----------------------------------------------------------------------- the run


class Stats:
    def __init__(self):
        self.lock = threading.Lock()
        self.counts: dict[str, int] = {}

    def add(self, key: str, n: int = 1):
        with self.lock:
            self.counts[key] = self.counts.get(key, 0) + n

    def line(self) -> str:
        with self.lock:
            c = dict(self.counts)
        return (
            f"reads {c.get('reads', 0)} | charged {c.get('charged', 0)} | unpaid {c.get('unpaid', 0)} "
            f"(no funds {c.get('insufficient_funds', 0)}, unregistered {c.get('unregistered_vehicle', 0)}) | "
            f"review {c.get('review', 0)} | ocr wrong {c.get('ocr_wrong', 0)} | dup {c.get('duplicate', 0)} | errors {c.get('error', 0)} | top-ups {c.get('topups', 0)}"
        )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", default=os.environ.get("TOLL_API", "http://127.0.0.1:3000"))
    ap.add_argument("--admin-key", default=os.environ.get("ADMIN_API_KEY", "dev-admin-key"))
    ap.add_argument("--ingest-key", default=os.environ.get("INGEST_API_KEY", "dev-ingest-key"))
    ap.add_argument("--gui", action="store_true", help="run sumo-gui instead of headless sumo")
    ap.add_argument("--hours", type=float, default=2.0, help="simulated duration")
    ap.add_argument("--speed", type=float, default=10.0, help="simulated seconds per real second; 0 = flat out")
    ap.add_argument("--start", default=None, help="simulated clock start, ISO 8601 (default: today 06:00 UTC+2)")
    # ~1,600 vehicles are on the corridor at once at the default demand, and a
    # registered vehicle can only be in one place, so the fleet must be bigger.
    ap.add_argument("--accounts", type=int, default=1200, help="accounts in a new fleet")
    ap.add_argument("--registered-share", type=float, default=0.85, help="share of traffic that is a registered vehicle")
    ap.add_argument("--tag-miss-rate", type=float, default=0.01)
    ap.add_argument("--misread-rate", type=float, default=0.02)
    ap.add_argument("--misclass-rate", type=float, default=0.03)
    ap.add_argument("--topup-response", type=float, default=0.5, help="chance an owner tops up after an unpaid passage")
    ap.add_argument("--anpr", default=None, metavar="URL",
                    help="read plates with the ANPR service (e.g. http://127.0.0.1:4100) instead of a misread rate")
    ap.add_argument("--review-threshold", type=float, default=float(os.environ.get("REVIEW_CONFIDENCE_THRESHOLD", 0.96)),
                    help="attach the image to reads below this confidence (match the back office's setting)")
    ap.add_argument("--batch", type=int, default=50, help="max reads per POST")
    ap.add_argument("--fresh-fleet", action="store_true")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    api = Api(args.api, args.admin_key, args.ingest_key)
    try:
        status, _ = api.call("GET", "/health", timeout=5)
    except OSError as e:
        sys.exit(f"back office not reachable at {args.api}: {e}. Start it with `npm run dev:lite`.")
    if status != 200:
        sys.exit(f"back office health check failed: {status}")

    fleet = load_or_create_fleet(api, rng, HERE / "out" / "fleet.json", args.accounts, args.fresh_fleet)
    by_class: dict[str, list[FleetVehicle]] = {c: [] for c in CLASSES}
    for v in fleet.vehicles:
        by_class[v.vehicle_class].append(v)

    corridor = json.loads(CORRIDOR.read_text(encoding="utf-8"))
    loops = {lp["id"]: (g["id"], lp["direction"]) for g in corridor["gantries"] for lp in g["loops"]}

    tz = timezone(timedelta(hours=2))  # Botswana, CAT
    start = (
        datetime.fromisoformat(args.start)
        if args.start
        else datetime.now(tz).replace(hour=6, minute=0, second=0, microsecond=0)
    )
    run_id = time.strftime("%Y%m%d%H%M%S")  # keeps event ids unique across reruns

    binary = sumolib.checkBinary("sumo-gui" if args.gui else "sumo")
    cmd = [binary, "-c", str(HERE / "a1.sumocfg"), "--end", str(int(args.hours * 3600)), "--seed", str(args.seed)]
    if args.gui:
        cmd += ["--start", "--quit-on-end", "--delay", "0"]
    traci.start(cmd)

    identities: dict[str, Identity] = {}
    on_road: set[str] = set()  # fleet plates currently driving, so no plate is in two places
    buffer: list[dict] = []
    stats = Stats()
    pool = ThreadPoolExecutor(max_workers=4)
    pending_topups: set[str] = set()
    # A long vehicle can sit on a loop for two steps, and a lane change can cross
    # two loops of one gantry; the roadside unit reports each vehicle once.
    seen: dict[str, set[tuple[str, str]]] = {}

    def identify(veh_id: str) -> Identity:
        cls = traci.vehicle.getTypeID(veh_id).split("@")[0]
        cls = cls if cls in CLASSES else "1"
        candidates = by_class.get(cls) or []
        if candidates and rng.random() < args.registered_share:
            for _ in range(8):
                v = rng.choice(candidates)
                if v.plate not in on_road:
                    on_road.add(v.plate)
                    return Identity(v.plate, cls, v.tag_id, True)
        return Identity(random_plate(rng), cls, None, False)

    def owner_tops_up(account_id: str):
        try:
            if topup(api, rng, account_id, rng.choice([10000, 20000, 50000])) == "succeeded":
                stats.add("topups")
        finally:
            pending_topups.discard(account_id)

    plate_owner = {v.plate: v.account_id for v in fleet.vehicles}

    def send(batch: list[dict]):
        # true_plate is simulation ground truth; it never reaches the API.
        events = [{k: v for k, v in r.items() if k != "true_plate"} for r in batch]
        status, body = api.call("POST", "/passages", {"events": events}, ingest=True)
        if status != 200:
            stats.add("error", len(batch))
            print(f"batch rejected: {status} {body}", file=sys.stderr)
            return
        for read, r in zip(batch, body["results"]):
            if not r["ok"]:
                stats.add("error")
                continue
            if r["duplicate"]:
                stats.add("duplicate")
                continue
            if read.get("plate") != read.get("true_plate"):
                stats.add("ocr_wrong")
            stats.add(r["status"])
            if r["violation_reason"]:
                stats.add(r["violation_reason"])
            if r["violation_reason"] == "insufficient_funds":
                account = plate_owner.get(read.get("true_plate", ""))
                if account and account not in pending_topups and rng.random() < args.topup_response:
                    pending_topups.add(account)
                    pool.submit(owner_tops_up, account)

    wall0 = time.time()
    last_report = wall0
    try:
        end = args.hours * 3600  # TraCI runs ignore sumo's --end, so stop here
        while traci.simulation.getMinExpectedNumber() > 0 and traci.simulation.getTime() < end:
            traci.simulationStep()
            t = traci.simulation.getTime()
            for vid in traci.simulation.getDepartedIDList():
                identities[vid] = identify(vid)
            for vid in traci.simulation.getArrivedIDList():
                ident = identities.pop(vid, None)
                seen.pop(vid, None)
                if ident and ident.registered:
                    on_road.discard(ident.plate)
            for loop_id, (gantry, direction) in loops.items():
                for vid in traci.inductionloop.getLastStepVehicleIDs(loop_id):
                    ident = identities.get(vid)
                    crossed = seen.setdefault(vid, set())
                    if not ident or (gantry, direction) in crossed:
                        continue
                    crossed.add((gantry, direction))
                    read = gantry_read(ident, rng, args)
                    read.update(
                        source_event_id=f"{run_id}-{gantry}-{direction}-{vid}",
                        gantry_id=gantry,
                        passed_at=(start + timedelta(seconds=t)).isoformat(),
                        true_plate=ident.plate,
                    )
                    buffer.append(read)
                    stats.add("reads")
            if len(buffer) >= args.batch or (buffer and int(t) % 10 == 0):
                pool.submit(send, list(buffer))
                buffer.clear()
            if args.speed > 0:
                ahead = (t / args.speed) - (time.time() - wall0)
                if ahead > 0:
                    time.sleep(ahead)
            if time.time() - last_report > 5:
                last_report = time.time()
                clock = (start + timedelta(seconds=t)).strftime("%H:%M")
                print(f"[{clock}] vehicles {traci.vehicle.getIDCount():>4} | {stats.line()}", flush=True)
    finally:
        if buffer:
            send(buffer)
        traci.close()
        pool.shutdown(wait=True)
        print(f"done in {time.time() - wall0:.0f}s | {stats.line()}")


if __name__ == "__main__":
    main()
