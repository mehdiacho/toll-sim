import { footerHtml, DASHBOARD_URL, esc } from "./ui.js";

const BASE = import.meta.env.BASE_URL;

const CARDS = [
  [
    "Traffic",
    "SUMO drives a few hundred vehicles over the real A1 between Gaborone and Mahalapye, imported from OpenStreetMap. Cars, buses, trucks and trailers keep their own speeds and queue behind each other on the single-carriageway stretches.",
  ],
  [
    "Toll plazas",
    "Three mainline plazas at Mmamashia, Artesia and Dibete, laid out like the N1 and N4 plazas in South Africa: the road flares to five lanes each way under a lit canopy, with heavy-vehicle, mixed and e-tag lanes, booths, booms and a tag reader and plate camera in every lane.",
  ],
  [
    "Plate reading",
    "A small CRNN model trained on synthetic Botswana plates reads every camera image. Reads it isn't sure of go to a human review queue rather than straight to a bill.",
  ],
  [
    "Settlement",
    "Prepaid accounts topped up through a stand-in mobile-money service whose callbacks can arrive late, twice or never. Every balance change goes through one ledger, in integer thebe.",
  ],
  [
    "Back office",
    "Tag first, then plate. Each read is matched, priced by class, charged or recorded as unpaid. Operators get a live dashboard, an append-only audit log, disputes and an enforcement ladder.",
  ],
];

const STEPS = [
  ["Arrive", "A vehicle picks a lane at the plaza: e-tag, mixed or heavy."],
  ["Read", "The tag reader and the plate camera fire as it reaches the boom."],
  ["Match", "The read is matched to an account, by tag if there is one."],
  ["Charge", "The class tariff comes off the prepaid balance, or is paid in cash or by card at the booth. The boom lifts."],
  ["Follow up", "No account or no money: an unpaid passage with a grace period."],
];

async function corridorSvg(el) {
  try {
    const road = await (await fetch(`${BASE}road.json`)).json();
    const [x0, y0, x1, y1] = road.bounds;
    const W = 320;
    const H = 600;
    const s = Math.min(W / (x1 - x0), H / (y1 - y0)) * 0.9;
    const ox = (W - (x1 - x0) * s) / 2;
    const oy = (H - (y1 - y0) * s) / 2;
    const P = (x, y) => [ox + (x - x0) * s, oy + (y1 - y) * s];
    let d = "";
    for (const l of road.lanes) {
      if (l.idx !== 0 || l.id.startsWith("-")) continue;
      let last = null;
      let seg = "";
      for (const [x, y] of l.pts) {
        const q = P(x, y);
        if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 1) continue;
        seg += `${seg ? "L" : "M"}${q[0].toFixed(1)} ${q[1].toFixed(1)}`;
        last = q;
      }
      d += seg;
    }
    const seen = new Set();
    const gantries = (road.plazas?.length ? road.plazas : road.gantries)
      .filter((g) => !seen.has(g.id) && seen.add(g.id))
      .map((g, i) => {
        const [x, y] = P(g.x, g.y);
        return `<g class="g" style="--d:${i * 0.7}s"><circle class="ring" cx="${x}" cy="${y}" r="7"/><circle cx="${x}" cy="${y}" r="4"/>
          <text x="${x + 12}" y="${y + 4}">${esc(g.name)} <tspan>km ${g.km}</tspan></text></g>`;
      })
      .join("");
    const places = road.places
      .filter((p) => p.name === "Gaborone" || p.name === "Mahalapye")
      .map((p) => {
        const [x, y] = P(p.x, p.y);
        const south = p.name === "Gaborone";
        return `<g class="p"><rect x="${x - 3}" y="${y - 3}" width="6" height="6"/><text x="${south ? x + 10 : x - 10}" y="${south ? y + 14 : y + 4}" text-anchor="${south ? "start" : "end"}">${esc(p.name)}</text></g>`;
      })
      .join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Map of the A1 corridor from Gaborone to Mahalapye with the three toll plazas">
      <path class="road-glow" d="${d}"/><path class="road" d="${d}"/><path class="road-flow" d="${d}"/>${places}${gantries}</svg>
      <p class="map-credit">Road network © OpenStreetMap contributors (ODbL)</p>`;
  } catch {
    el.remove();
  }
}

export function mountLanding(root) {
  root.innerHTML = `
  <div class="landing">
    <header class="top">
      <a class="brand" href="#/">A1 Toll Simulator</a>
      <nav><a href="#/live">Live view</a><a href="${DASHBOARD_URL}">Dashboard</a></nav>
    </header>
    <main>
      <section class="hero">
        <div class="hero-text">
          <p class="eyebrow">Botswana · A1 · simulated toll plazas</p>
          <h1>A1 Toll Simulator</h1>
          <p class="lead">
            A working model of an electronic toll on the A1 from Gaborone to Mahalapye.
            Simulated traffic drives the real road network and queues at three toll plazas, where tags, cash and cards are taken,
            and a back office matches every read to an account and settles it from a mobile-money wallet.
          </p>
          <div class="cta">
            <a class="btn primary" href="#/live">Watch it in 3D</a>
            <a class="btn" href="${DASHBOARD_URL}">Operations dashboard</a>
            <span class="btn ghost" title="The code is not public yet; ask and I'll share it">Source on request</span>
          </div>
          <p class="note">The 3D view streams the running simulation when it is up, and plays a recorded loop when it isn't. The badge in the corner tells you which.</p>
        </div>
        <div class="hero-map" id="map"></div>
      </section>

      <section class="cards">
        <h2>What's in it</h2>
        <div class="grid">
          ${CARDS.map(([h, p]) => `<article><h3>${esc(h)}</h3><p>${esc(p)}</p></article>`).join("")}
        </div>
      </section>

      <section class="flow">
        <h2>One passage, end to end</h2>
        <ol>${STEPS.map(([h, p]) => `<li><b>${esc(h)}</b><span>${esc(p)}</span></li>`).join("")}</ol>
      </section>

      <section class="closing">
        <p>Prices, plates, accounts and payments are all made up. The road geometry is real.</p>
        <a class="btn primary" href="#/live">Open the live view</a>
      </section>
    </main>
    <footer class="foot">
      ${footerHtml()}
      <span>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors (ODbL)</a></span>
    </footer>
  </div>`;
  corridorSvg(root.querySelector("#map"));
  return () => {};
}
