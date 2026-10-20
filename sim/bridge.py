"""Drive the A1 simulation and stream toll plaza payments into the back office.

  1. Creates (or reuses) a synthetic fleet in the back office: accounts, vehicles
     with Botswana plates, some with tags, funded through the mock mobile-money
     top-up flow. A few accounts are left short on purpose.
  2. Runs SUMO via TraCI. Each vehicle that enters the network is given an
     identity: usually a registered vehicle of its class, sometimes an
     unregistered one.
  3. At each of the three toll plazas a vehicle picks a lane on the approach by
     how it will pay: heavy vehicles the two kerb-side heavy lanes, tagged light
     vehicles the e-tag lane (sometimes a mixed lane), everyone else a mixed lane
     to pay cash or card. It stops at the booth line for its service time:
     e-tag 1-2 s at rest, a tag in another lane 3-5 s, cash or card 8-12 s.
     Fewer lanes are open at night (demand.day_factor); all are open at peaks.
  4. A tag read is POSTed to /passages at once and the boom waits for the answer:
     charged, or declined (no funds, unknown tag), in which case the driver pays
     by card at the booth, 15-25 s later. Cash and card go to /plaza/transactions.
     The plate camera audits every vehicle, with realistic noise: missed tags,
     misreads, the odd wrong classification. A few drivers run the boom; the
     loops past the booms catch them and they become boom_runner violations.
     With --anpr, plates are rendered as camera crops and read by the trained
     model (anpr/server.py), and low-confidence reads carry the image for review.
  5. When a tag is declined for lack of funds the owner sometimes tops up.

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
import queue
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
import traci.constants as tc

import demand

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
            f"reads {c.get('reads', 0)} | tag {c.get('charged', 0)} cash {c.get('cash', 0)} card {c.get('card', 0)} | "
            f"declined {c.get('declined', 0)} | runners {c.get('runners', 0)} | unpaid {c.get('unpaid', 0)} | "
            f"review {c.get('review', 0)} | ocr wrong {c.get('ocr_wrong', 0)} | dup {c.get('duplicate', 0)} | errors {c.get('error', 0)} | top-ups {c.get('topups', 0)}"
        )


class FrameFeed:
    """Pushes the picture the 3D live view draws: positions, new and departed
    vehicles, and the result of every gantry read. One frame in flight at a time;
    if the back office is slow a frame is skipped, never queued."""

    def __init__(self, api: Api, interval: float):
        self.api = api
        self.interval = interval
        self.ids: dict[str, int] = {}
        self.next_id = 1
        self.spawn: list[list] = []
        self.gone: list[int] = []
        self.events: list[dict] = []
        self.lock = threading.Lock()
        self.busy = threading.Event()
        self.last = 0.0
        self.failures = 0
        self.extra = None  # () -> {"plazas": ..., "booms": ..., "lanes_open": ...}
        self.on_lost = None  # called when a frame is dropped, so state is resent in full

    def vid(self, sumo_id: str) -> int:
        n = self.ids.get(sumo_id)
        if n is None:
            n = self.ids[sumo_id] = self.next_id
            self.next_id += 1
        return n

    def departed(self, sumo_id: str, ident: Identity):
        traci.vehicle.subscribe(sumo_id, (tc.VAR_POSITION, tc.VAR_ANGLE, tc.VAR_SPEED))
        flags = (1 if ident.registered else 0) | (2 if ident.tag_id else 0)
        with self.lock:
            self.spawn.append([self.vid(sumo_id), ident.plate, ident.true_class, flags])

    def arrived(self, sumo_id: str):
        n = self.ids.pop(sumo_id, None)
        if n is not None:
            with self.lock:
                self.gone.append(n)

    def event(self, e: dict):
        with self.lock:
            self.events.append(e)

    def tick(self, t: float, clock: datetime, stats: Stats):
        now = time.time()
        if now - self.last < self.interval or self.busy.is_set():
            return
        self.last = now
        vehicles = []
        for sid, v in traci.vehicle.getAllSubscriptionResults().items():
            n = self.ids.get(sid)
            if n is None or tc.VAR_POSITION not in v:
                continue
            x, y = v[tc.VAR_POSITION]
            vehicles.append([n, round(x * 10), round(y * 10), round(v[tc.VAR_ANGLE]) % 360, round(v[tc.VAR_SPEED] * 10)])
        with self.lock:
            spawn, gone, events = self.spawn, self.gone, self.events
            self.spawn, self.gone, self.events = [], [], []
        with stats.lock:
            counts = dict(stats.counts)
        frame = {"t": t, "clock": clock.isoformat(timespec="seconds"), "vehicles": vehicles,
                 "spawn": spawn, "gone": gone, "events": events, "stats": counts}
        if self.extra:
            extra = self.extra()
            frame["stats"]["plazas"] = extra.pop("plazas")
            frame.update(extra)
        self.busy.set()
        threading.Thread(target=self._post, args=(frame,), daemon=True).start()

    def _post(self, frame: dict):
        try:
            status, body = self.api.call("POST", "/live/frame", frame, ingest=True, timeout=10)
            if status != 200:
                raise RuntimeError(f"{status} {body}")
            self.failures = 0
        except Exception as e:  # the 3D feed must never stop the simulation
            self.failures += 1
            if self.failures in (1, 10) or self.failures % 100 == 0:
                print(f"live frame not accepted ({self.failures}x): {e}", file=sys.stderr)
            # Keep what was lost so the viewer's registry stays right.
            with self.lock:
                self.spawn[:0] = frame["spawn"]
                self.gone[:0] = frame["gone"]
            if self.on_lost:
                self.on_lost()
        finally:
            self.busy.clear()


HEAVY = {"2", "3", "4"}
BOTSWANA = timezone(timedelta(hours=2))


def lanes_open_for(factor: float) -> list[int]:
    """Lanes staffed at a demand level: all at the peaks, fewer at night. The
    kerb heavy lane, one mixed lane and the e-tag lane never close."""
    if factor >= 0.75:
        return [0, 1, 2, 3, 4]
    if factor >= 0.3:
        return [0, 2, 3, 4]
    return [0, 2, 4]


@dataclass
class BoothVisit:
    vid: str
    plaza: str
    dir: str
    lane: int
    method: str  # tag | cash | card | runner
    assigned_t: float
    waited0: float = 0.0  # accumulated waiting time when the lane was assigned
    stopped_t: float | None = None
    resume_t: float | None = None  # set once the service time is known
    service: float = 0.0
    result: dict | None = None  # the back office's answer to a tag read
    read: dict | None = None


class Plazas:
    """The toll plazas: lane choice on the approach, a stop at the booth line for
    service, the booms, open lanes by time of day, and the per-plaza numbers for
    the live feed. All TraCI calls happen on the main thread; the back office's
    answers arrive from worker threads through `results`."""

    def __init__(self, corridor: dict, rng: random.Random, args):
        self.rng = rng
        self.args = args
        self.sites: dict[str, dict] = {}
        self.approach: dict[str, tuple[str, str]] = {}  # a80 edge -> (plaza, dir)
        for g in corridor["gantries"]:
            p = g.get("plaza")
            if not p:
                continue
            self.sites[g["id"]] = {"name": g["name"], "types": p["lane_types"], "dirs": p["dirs"]}
            for d, info in p["dirs"].items():
                self.approach[info["approach"][0]] = (g["id"], d)
        self.visits: dict[str, BoothVisit] = {}
        self.done: dict[str, set[tuple[str, str]]] = {}  # vid -> plazas already passed
        self.assigned = {(pid, d, i): 0 for pid, s in self.sites.items() for d in s["dirs"] for i in range(len(s["types"]))}
        self.booms = {k: 0 for k in self.assigned}
        self.boom_down_at: dict[tuple, float] = {}
        self.boom_changes: list[list] = []
        self.open: dict[str, dict[str, list[int]]] = {}
        self.open_changed = False
        self.full_state = True  # next frame carries every boom and the open lanes
        self.waits: dict[str, list[float]] = {pid: [] for pid in self.sites}
        self.by_method: dict[str, dict[str, int]] = {pid: {"tag": 0, "cash": 0, "card": 0} for pid in self.sites}
        self.day = None
        self.results: "queue.Queue[tuple[str, dict]]" = queue.Queue()

    # -- lanes --------------------------------------------------------------

    def update_open(self, clock: datetime):
        lanes = lanes_open_for(demand.day_factor(clock.hour + clock.minute / 60))
        new = {pid: {d: list(lanes) for d in s["dirs"]} for pid, s in self.sites.items()}
        if new != self.open:
            self.open = new
            self.open_changed = True

    def choose_lane(self, pid: str, d: str, cls: str, tagged: bool) -> tuple[int, str]:
        types = self.sites[pid]["types"]
        open_ = self.open.get(pid, {}).get(d) or list(range(len(types)))

        def least(kind: set[str]) -> int | None:
            lanes = [i for i in open_ if types[i] in kind]
            if not lanes:
                return None
            low = min(self.assigned[(pid, d, i)] for i in lanes)
            return self.rng.choice([i for i in lanes if self.assigned[(pid, d, i)] == low])

        cash_or_card = "cash" if self.rng.random() < 0.6 else "card"
        if cls in HEAVY:
            lane = least({"heavy"})
            return (lane if lane is not None else open_[0]), ("tag" if tagged else cash_or_card)
        if tagged:
            etag, mixed = least({"etag"}), least({"mixed"})
            # Most tagged drivers head for the e-tag lane unless its queue is clearly longer.
            if etag is not None and (mixed is None or self.rng.random() < 0.88
                                     and self.assigned[(pid, d, etag)] <= self.assigned[(pid, d, mixed)] + 4):
                return etag, "tag"
            return (mixed if mixed is not None else open_[0]), "tag"
        lane = least({"mixed"})
        return (lane if lane is not None else open_[0]), cash_or_card

    def service_time(self, lane_type: str, method: str) -> float:
        if method == "tag":
            return self.rng.uniform(1.0, 2.0) if lane_type == "etag" else self.rng.uniform(3.0, 5.0)
        return self.rng.uniform(8.0, 12.0)

    # -- per step -------------------------------------------------------------

    def assign(self, t: float, identities: dict, warming: bool):
        """Give every vehicle that has just entered a plaza approach its lane and booth stop."""
        for edge, (pid, d) in self.approach.items():
            for vid in traci.edge.getLastStepVehicleIDs(edge):
                if vid in self.visits or (pid, d) in self.done.get(vid, ()):
                    continue
                ident = identities.get(vid)
                if not ident:
                    continue
                self.done.setdefault(vid, set()).add((pid, d))
                tagged = bool(ident.tag_id)
                lane, method = self.choose_lane(pid, d, ident.true_class, tagged)
                info = self.sites[pid]["dirs"][d]
                visit = BoothVisit(vid, pid, d, lane, method, t)
                if not warming and self.rng.random() < self.args.runner_rate:
                    visit.method = "runner"  # drives through the boom without stopping
                    self.visits[vid] = visit
                    continue
                try:
                    traci.vehicle.setStop(vid, info["booth_edge"], pos=info["booth_pos"] - 0.5, laneIndex=lane,
                                          duration=900)
                    visit.waited0 = traci.vehicle.getAccumulatedWaitingTime(vid)
                except traci.TraCIException:
                    continue  # can't reach the booth any more; the loops will see it pass
                self.assigned[(pid, d, lane)] += 1
                self.visits[vid] = visit

    def stopped(self, t: float, vid: str) -> BoothVisit | None:
        """A vehicle has come to rest at its booth. Returns the visit, or None."""
        v = self.visits.get(vid)
        if not v or v.method == "runner" or v.stopped_t is not None:
            return None
        v.stopped_t = t
        lane_type = self.sites[v.plaza]["types"][v.lane]
        v.service = self.service_time(lane_type, v.method)
        return v

    def release_due(self, t: float, warming: bool) -> list[BoothVisit]:
        """Raise the boom for every vehicle whose service is over."""
        out = []
        while True:
            try:
                vid, result = self.results.get_nowait()
            except queue.Empty:
                break
            v = self.visits.get(vid)
            if v and v.resume_t is None:
                v.result = result
                extra = self.rng.uniform(15, 25) if result.get("declined") else 0.0
                v.resume_t = max(t, (v.stopped_t or t) + v.service) + extra
        for vid, v in list(self.visits.items()):
            if v.stopped_t is None or v.method == "runner":
                continue
            if v.resume_t is None and (warming or v.method != "tag"):
                v.resume_t = v.stopped_t + v.service
            if v.resume_t is None or v.resume_t > t:
                continue
            try:
                traci.vehicle.resume(vid)
                waited = max(0.0, traci.vehicle.getAccumulatedWaitingTime(vid) - v.waited0)
            except traci.TraCIException:
                waited = 0.0
            self.finish(vid)
            key = (v.plaza, v.dir, v.lane)
            if not warming:
                w = self.waits[v.plaza]
                w.append(waited + (t - v.stopped_t))
                del w[:-60]
                self.set_boom(key, 1)
            self.boom_down_at[key] = t + 3
            out.append(v)
        for key, at in list(self.boom_down_at.items()):
            if at <= t:
                del self.boom_down_at[key]
                if not warming:
                    self.set_boom(key, 0)
        return out

    def finish(self, vid: str):
        v = self.visits.pop(vid, None)
        if v and v.method != "runner":
            k = (v.plaza, v.dir, v.lane)
            self.assigned[k] = max(0, self.assigned[k] - 1)

    def gone(self, vid: str):
        self.finish(vid)
        self.done.pop(vid, None)

    def set_boom(self, key: tuple, up: int):
        if self.booms[key] != up:
            self.booms[key] = up
            self.boom_changes.append([key[0], key[1], key[2], up])

    def count(self, pid: str, method: str, clock: datetime):
        day = clock.astimezone(BOTSWANA).date()
        if day != self.day:
            if self.day is not None:
                self.by_method = {p: {"tag": 0, "cash": 0, "card": 0} for p in self.sites}
            self.day = day
        self.by_method[pid][method] += 1

    def seed_counts(self, api: "Api", clock: datetime):
        try:
            status, rows = api.call("GET", "/plazas", ingest=True, timeout=10)
        except OSError:
            return
        if status == 200 and isinstance(rows, list):
            for r in rows:
                if r.get("id") in self.by_method:
                    self.by_method[r["id"]] = {k: int(r["by_method"].get(k, 0)) for k in ("tag", "cash", "card")}
            self.day = clock.astimezone(BOTSWANA).date()

    # -- the live feed ----------------------------------------------------------

    def frame_extra(self) -> dict:
        """stats.plazas, booms and lanes_open for the next live frame."""
        at_booth: dict[tuple[str, str], int] = {}
        for v in self.visits.values():
            if v.stopped_t is not None:
                at_booth[(v.plaza, v.dir)] = at_booth.get((v.plaza, v.dir), 0) + 1
        plazas = {}
        for pid, s in self.sites.items():
            queue_ = {}
            for d, info in s["dirs"].items():
                halted = sum(traci.edge.getLastStepHaltingNumber(e) for e in (*info["approach"], info["booth_edge"]))
                queue_[d] = max(0, halted - at_booth.get((pid, d), 0))
            w = self.waits[pid]
            plazas[pid] = {
                "open": {d: len(self.open.get(pid, {}).get(d, [])) for d in ("N", "S")},
                "queue": {d: queue_.get(d, 0) for d in ("N", "S")},
                "wait_s": round(sum(w) / len(w), 1) if w else 0.0,
                "by_method": dict(self.by_method[pid]),
            }
        extra: dict = {"plazas": plazas}
        if self.full_state:
            extra["booms"] = [[k[0], k[1], k[2], up] for k, up in self.booms.items()]
            extra["lanes_open"] = self.open
            self.full_state = False
            self.open_changed = False
            self.boom_changes = []
        else:
            if self.boom_changes:
                extra["booms"], self.boom_changes = self.boom_changes, []
            if self.open_changed:
                extra["lanes_open"] = self.open
                self.open_changed = False
        return extra


class LiveDemand:
    """Always-on mode: vehicles are inserted by the bridge, not from a route file,
    so the simulation can run forever. The busy-hour flows of demand.py are
    scaled by the time of day in Botswana."""

    def __init__(self, corridor: dict, scale: float, rng: random.Random):
        self.rng = rng
        self.flows = []
        for fid, frm, to, vph in demand.corridor_flows(corridor, scale):
            route = traci.simulation.findRoute(frm, to).edges
            if not route:
                print(f"no route for flow {fid}; skipped", file=sys.stderr)
                continue
            traci.route.add(f"r_{fid}", route)
            self.flows.append((fid, vph / 3600))
        self.types = [v[0] for v in demand.VTYPES]
        self.weights = [v[2] for v in demand.VTYPES]
        self.n = 0

    def step(self, clock: datetime):
        factor = demand.day_factor(clock.hour + clock.minute / 60)
        for fid, per_second in self.flows:
            if self.rng.random() < per_second * factor:
                self.n += 1
                vtype = self.rng.choices(self.types, self.weights)[0]
                traci.vehicle.add(f"{fid}.{self.n}", f"r_{fid}", typeID=vtype, departLane="best", departSpeed="max")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", default=os.environ.get("TOLL_API", "http://127.0.0.1:3000"))
    ap.add_argument("--admin-key", default=os.environ.get("ADMIN_API_KEY", "dev-admin-key"))
    ap.add_argument("--ingest-key", default=os.environ.get("INGEST_API_KEY", "dev-ingest-key"))
    ap.add_argument("--gui", action="store_true", help="run sumo-gui instead of headless sumo")
    ap.add_argument("--hours", type=float, default=2.0, help="simulated duration")
    ap.add_argument("--speed", type=float, default=10.0, help="simulated seconds per real second; 0 = flat out")
    ap.add_argument("--start", default=None, help="simulated clock start, ISO 8601 (default: today 06:00 UTC+2)")
    ap.add_argument("--live", action="store_true",
                    help="always-on: real time, the real clock, demand by time of day, runs until stopped")
    ap.add_argument("--warmup", type=float, default=1.5, help="--live: hours simulated flat out first, so the road starts full")
    ap.add_argument("--scale", type=float, default=1.0, help="--live: demand scale")
    ap.add_argument("--frame-interval", type=float, default=2.0, help="wall seconds between live 3D frames")
    ap.add_argument("--no-frames", action="store_true", help="don't feed the 3D live view")
    # ~1,600 vehicles are on the corridor at once at the default demand, and a
    # registered vehicle can only be in one place, so the fleet must be bigger.
    ap.add_argument("--accounts", type=int, default=1200, help="accounts in a new fleet")
    ap.add_argument("--registered-share", type=float, default=0.85, help="share of traffic that is a registered vehicle")
    ap.add_argument("--tag-miss-rate", type=float, default=0.01)
    ap.add_argument("--misread-rate", type=float, default=0.02)
    ap.add_argument("--misclass-rate", type=float, default=0.03)
    ap.add_argument("--topup-response", type=float, default=0.5, help="chance an owner tops up after an unpaid passage")
    ap.add_argument("--anpr", default=os.environ.get("ANPR_URL") or None, metavar="URL",
                    help="read plates with the ANPR service (e.g. http://127.0.0.1:4100) instead of a misread rate")
    ap.add_argument("--review-threshold", type=float, default=float(os.environ.get("REVIEW_CONFIDENCE_THRESHOLD", 0.96)),
                    help="attach the image to reads below this confidence (match the back office's setting)")
    ap.add_argument("--runner-rate", type=float, default=0.003, help="share of vehicles that run a plaza boom")
    ap.add_argument("--batch", type=int, default=50, help="max reads per POST")
    ap.add_argument("--fleet-file", default=os.environ.get("FLEET_FILE", str(HERE / "out" / "fleet.json")))
    ap.add_argument("--fresh-fleet", action="store_true")
    ap.add_argument("--seed", type=int, default=None, help="random seed (default 7, or random with --live)")
    args = ap.parse_args()

    seed = args.seed if args.seed is not None else (random.randrange(1 << 30) if args.live else 7)
    rng = random.Random(seed)
    api = Api(args.api, args.admin_key, args.ingest_key)
    epoch = None
    for attempt in range(60 if args.live else 1):
        try:
            status, health = api.call("GET", "/health", timeout=5)
            if status == 200:
                epoch = (health or {}).get("epoch")
                break
            reason = f"health check returned {status}"
        except OSError as e:
            reason = str(e)
        if not args.live:
            sys.exit(f"back office not reachable at {args.api}: {reason}. Start it with `npm run dev:lite`.")
        print(f"waiting for the back office ({reason})", flush=True)
        time.sleep(5)
    else:
        sys.exit("back office never came up")

    fleet = load_or_create_fleet(api, rng, Path(args.fleet_file), args.accounts, args.fresh_fleet)
    by_class: dict[str, list[FleetVehicle]] = {c: [] for c in CLASSES}
    for v in fleet.vehicles:
        by_class[v.vehicle_class].append(v)

    corridor = json.loads(CORRIDOR.read_text(encoding="utf-8"))
    # Loops just past the booms: they catch boom runners (lane = the loop's index).
    loops = {lp["id"]: (g["id"], lp["direction"], int(lp["id"].rsplit("_", 1)[1])) for g in corridor["gantries"] for lp in g["loops"]}

    tz = timezone(timedelta(hours=2))  # Botswana, CAT
    if args.live:
        start = datetime.now(tz) - timedelta(hours=args.warmup)
    else:
        start = (
            datetime.fromisoformat(args.start)
            if args.start
            else datetime.now(tz).replace(hour=6, minute=0, second=0, microsecond=0)
        )
    run_id = time.strftime("%Y%m%d%H%M%S")  # keeps event ids unique across reruns

    binary = sumolib.checkBinary("sumo-gui" if args.gui else "sumo")
    cmd = [binary, "-c", str(HERE / "a1.sumocfg"), "--seed", str(seed % (1 << 31)),
           # A plaza queue at the peak can hold a vehicle for minutes: remember its
           # waiting time that long, and don't teleport it out of the queue.
           "--waiting-time-memory", "3600", "--time-to-teleport", "900"]
    if args.live:
        # Only the vehicle types from a route file; LiveDemand inserts the traffic.
        types = HERE / "net" / "types.rou.xml"
        types.write_text("\n".join(['<?xml version="1.0" encoding="UTF-8"?>', "<routes>", *demand.vtype_lines(), "</routes>"]) + "\n",
                         encoding="utf-8")
        cmd += ["--route-files", str(types)]
    else:
        cmd += ["--end", str(int(args.hours * 3600))]
    if args.gui:
        cmd += ["--start", "--quit-on-end", "--delay", "0"]
    traci.start(cmd)

    identities: dict[str, Identity] = {}
    on_road: set[str] = set()  # fleet plates currently driving, so no plate is in two places
    buffer: list[dict] = []
    stats = Stats()
    pool = ThreadPoolExecutor(max_workers=4)
    pending_topups: set[str] = set()
    feed = None if args.no_frames else FrameFeed(api, args.frame_interval)
    plazas = Plazas(corridor, rng, args)
    plazas.seed_counts(api, start)
    booth_buffer: list[dict] = []
    if feed:
        feed.extra = plazas.frame_extra
        feed.on_lost = lambda: setattr(plazas, "full_state", True)
    live_demand = LiveDemand(corridor, args.scale, rng) if args.live else None
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

    def release(read: dict, result: dict):
        """Let a vehicle waiting on a tag answer go (or pay at the booth)."""
        if read.get("_sumo"):
            plazas.results.put((read["_sumo"], result))

    def send(batch: list[dict]):
        # true_plate and the _ keys are simulation ground truth; they never reach the API.
        events = [{k: v for k, v in r.items() if k != "true_plate" and not k.startswith("_")} for r in batch]
        try:
            status, body = api.call("POST", "/passages", {"events": events}, ingest=True)
        except OSError as e:
            status, body = 0, str(e)
        if status != 200:
            stats.add("error", len(batch))
            print(f"batch rejected: {status} {body}", file=sys.stderr)
            for read in batch:
                release(read, {"declined": False})
            return
        for read, r in zip(batch, body["results"]):
            if not r["ok"]:
                stats.add("error")
                release(read, {"declined": False})
                continue
            if r["duplicate"]:
                stats.add("duplicate")
                release(read, {"declined": False})
                continue
            declined = r["status"] == "declined"
            release(read, {"declined": declined, "passage_id": r["passage_id"], "reason": r.get("decline_reason")})
            if read.get("plate") != read.get("true_plate"):
                stats.add("ocr_wrong")
            stats.add(r["status"])
            if r["violation_reason"]:
                stats.add(r["violation_reason"])
            if r.get("decline_reason"):
                stats.add("declined_" + r["decline_reason"])
            if r.get("tag_plate_mismatch"):
                stats.add("tag_plate_mismatch")
            gantry, direction = read["_vid"][1], read["_vid"][2]
            method = read.get("payment") or "plate"
            if method == "tag" and r["status"] == "charged":
                plazas.count(gantry, "tag", read["_clock"])
            if feed:
                feed.event({"vid": read["_vid"][0], "gantry": gantry, "dir": direction, "plate": read.get("plate"),
                            "status": r["status"], "amount_thebe": r["amount_thebe"],
                            "reason": r["violation_reason"] or r.get("decline_reason"), "match": r["match_method"],
                            "plaza": gantry, "lane": read.get("lane", 0), "method": method})
            if r["violation_reason"] == "insufficient_funds" or r.get("decline_reason") == "insufficient_funds":
                account = plate_owner.get(read.get("true_plate", ""))
                if account and account not in pending_topups and rng.random() < args.topup_response:
                    pending_topups.add(account)
                    try:
                        pool.submit(owner_tops_up, account)
                    except RuntimeError:
                        pending_topups.discard(account)  # shutting down

    def send_booth(batch: list[dict]):
        body_rows = [{k: v for k, v in r.items() if not k.startswith("_")} for r in batch]
        try:
            status, body = api.call("POST", "/plaza/transactions", {"transactions": body_rows}, ingest=True)
        except OSError as e:
            status, body = 0, str(e)
        if status != 200:
            stats.add("error", len(batch))
            print(f"booth batch rejected: {status} {body}", file=sys.stderr)
            return
        for row, r in zip(batch, body["results"]):
            if not r["ok"]:
                stats.add("error")
                print(f"booth payment refused: {r}", file=sys.stderr)
                continue
            if r["duplicate"]:
                stats.add("duplicate")
                continue
            stats.add(row["method"])
            plazas.count(row["plaza_id"], row["method"], row["_clock"])
            if feed:
                feed.event({"vid": row["_vid"], "gantry": row["plaza_id"], "dir": row["direction"], "plate": row.get("plate"),
                            "status": "paid", "amount_thebe": r["amount_thebe"], "reason": None, "match": None,
                            "plaza": row["plaza_id"], "lane": row["lane"], "method": row["method"]})

    def safe_send_booth(batch: list[dict]):
        try:
            send_booth(batch)
        except Exception as e:
            stats.add("error", len(batch))
            print(f"booth batch failed: {e}", file=sys.stderr)

    def safe_send(batch: list[dict]):
        try:
            send(batch)
        except Exception as e:  # a bad batch must not take the run down
            stats.add("error", len(batch))
            print(f"batch failed: {e}", file=sys.stderr)

    # The back office reports a new epoch on /health when it restarts (its live
    # feed has forgotten the vehicles on the road) or when the public demo wipes
    # its database at night (the fleet is gone). Either way, stop and let the
    # container restart: the fleet is reused or recreated, and every vehicle is
    # announced to the feed again.
    reset_seen = threading.Event()

    def watch_epoch():
        while not reset_seen.wait(60):
            try:
                status, health = api.call("GET", "/health", timeout=5)
            except OSError:
                continue
            if status == 200 and epoch and (health or {}).get("epoch") not in (None, epoch):
                print("back office restarted or its data was reset; restarting so the fleet and the 3D feed start clean", flush=True)
                reset_seen.set()

    if args.live and epoch:
        threading.Thread(target=watch_epoch, daemon=True).start()

    warmup_end = args.warmup * 3600 if args.live else 0
    wall0 = time.time()
    last_report = wall0
    try:
        end = float("inf") if args.live else args.hours * 3600  # TraCI runs ignore sumo's --end, so stop here
        if args.live:
            print(f"warming up: {args.warmup} h of traffic flat out, then real time", flush=True)
        while (args.live or traci.simulation.getMinExpectedNumber() > 0) and traci.simulation.getTime() < end:
            t = traci.simulation.getTime()
            clock = start + timedelta(seconds=t)
            if live_demand:
                live_demand.step(clock)
            traci.simulationStep()
            t = traci.simulation.getTime()
            warming = t < warmup_end
            if args.live and not warming and wall0 and t - warmup_end < 1:
                wall0 = time.time() - (t - warmup_end)  # real time starts now
                print(f"warm-up done: {traci.vehicle.getIDCount()} vehicles on the road; running in real time", flush=True)
            clock = datetime.now(tz) if args.live and not warming else start + timedelta(seconds=t)
            for vid in traci.simulation.getDepartedIDList():
                identities[vid] = ident = identify(vid)
                if feed:
                    feed.departed(vid, ident)
            for vid in traci.simulation.getArrivedIDList():
                ident = identities.pop(vid, None)
                seen.pop(vid, None)
                plazas.gone(vid)
                if feed:
                    feed.arrived(vid)
                if ident and ident.registered:
                    on_road.discard(ident.plate)
            if int(t) % 60 == 0 or not plazas.open:
                plazas.update_open(clock)
            plazas.assign(t, identities, warming)
            for vid in traci.simulation.getStopStartingVehiclesIDList():
                v = plazas.stopped(t, vid)
                if not v or warming:
                    continue
                ident = identities.get(vid)
                if not ident:
                    continue
                try:
                    read = gantry_read(ident, rng, args)
                except Exception as e:  # the plate reader being down costs a read, not the run
                    stats.add("error")
                    print(f"read failed: {e}", file=sys.stderr)
                    read = {"plate": ident.plate, "read_confidence": 0.9, "detected_class": ident.true_class}
                v.read = read
                stats.add("reads")
                if v.method != "tag":
                    continue
                if not read.get("tag_id"):
                    # The reader missed the tag: the boom stays down and the driver pays by card.
                    v.method = "card"
                    v.service += rng.uniform(10, 20)
                    stats.add("tag_missed")
                    continue
                read.update(
                    source_event_id=f"{run_id}-{v.plaza}-{v.dir}-{vid}",
                    gantry_id=v.plaza, passed_at=clock.isoformat(), payment="tag", lane=v.lane, direction=v.dir,
                    true_plate=ident.plate, _vid=[feed.vid(vid) if feed else 0, v.plaza, v.dir], _sumo=vid, _clock=clock,
                )
                buffer.append(read)
            for v in plazas.release_due(t, warming):
                if warming or v.method not in ("cash", "card", "tag"):
                    continue
                declined = bool(v.result and v.result.get("declined"))
                if v.method == "tag" and not declined:
                    continue
                read = v.read or {}
                ident = identities.get(v.vid)
                row = {
                    "plaza_id": v.plaza, "source_event_id": f"{run_id}-{v.plaza}-{v.dir}-{v.vid}-booth", "lane": v.lane,
                    "direction": v.dir, "method": "card" if declined else v.method,
                    "vehicle_class": ident.true_class if ident else (read.get("detected_class") or "1"),
                    "transacted_at": clock.isoformat(), "plate": read.get("plate"),
                    "read_confidence": read.get("read_confidence"),
                    "_vid": feed.vid(v.vid) if feed else 0, "_clock": clock,
                }
                if declined and v.result.get("passage_id"):
                    row["declined_passage_id"] = v.result["passage_id"]
                booth_buffer.append(row)
            if not warming:
                for loop_id, (gantry, direction, lane) in loops.items():
                    for vid in traci.inductionloop.getLastStepVehicleIDs(loop_id):
                        ident = identities.get(vid)
                        visit = plazas.visits.get(vid)
                        if not ident or not visit or visit.method != "runner" or visit.plaza != gantry:
                            continue
                        plazas.finish(vid)
                        try:
                            read = gantry_read(ident, rng, args)
                        except Exception as e:
                            stats.add("error")
                            print(f"read failed: {e}", file=sys.stderr)
                            continue
                        read.pop("tag_id", None)  # a runner is enforced on the plate
                        read.update(
                            source_event_id=f"{run_id}-{gantry}-{direction}-{vid}",
                            gantry_id=gantry, passed_at=clock.isoformat(), payment="runner", lane=lane, direction=direction,
                            true_plate=ident.plate, _vid=[feed.vid(vid) if feed else 0, gantry, direction], _clock=clock,
                        )
                        if not read.get("plate"):
                            continue
                        buffer.append(read)
                        stats.add("reads")
                        stats.add("runners")
                # Live, every read goes out at once so the 3D view shows it at the gantry.
                # Tag reads go out at once: a driver is waiting at the boom for the answer.
                if buffer:
                    pool.submit(safe_send, list(buffer))
                    buffer.clear()
                if len(booth_buffer) >= args.batch or (booth_buffer and (args.live or int(t) % 5 == 0)):
                    pool.submit(safe_send_booth, list(booth_buffer))
                    booth_buffer.clear()
                if feed:
                    feed.tick(t, clock, stats)
            if warming:
                pass
            elif args.live:
                ahead = (t - warmup_end) - (time.time() - wall0)
                if ahead > 0:
                    time.sleep(ahead)
                elif ahead < -30:
                    wall0 = time.time() - (t - warmup_end)  # fell behind (host was busy): don't sprint to catch up
            elif args.speed > 0:
                ahead = (t / args.speed) - (time.time() - wall0)
                if ahead > 0:
                    time.sleep(ahead)
            if reset_seen.is_set():
                break
            if time.time() - last_report > (60 if args.live else 5):
                last_report = time.time()
                print(f"[{clock.strftime('%H:%M')}] vehicles {traci.vehicle.getIDCount():>4} | {stats.line()}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        if buffer:
            safe_send(buffer)
        if booth_buffer:
            safe_send_booth(booth_buffer)
        try:
            traci.close()
        except Exception:
            pass
        pool.shutdown(wait=True)
        print(f"done in {time.time() - wall0:.0f}s | {stats.line()}")
    if reset_seen.is_set():
        sys.exit(3)


if __name__ == "__main__":
    main()
