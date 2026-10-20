// Portfolio captures of the built viewer, taken with headless Chrome.
//
//   npx vite build && npx vite preview --port 4187 --strictPort &
//   node scripts/capture.mjs [baseUrl] [outDir]
//
// baseUrl defaults to http://localhost:4187/projects/toll-sim/ and outDir to
// ../docs/portfolio. Writes cover.png (1600x900), landing.png, overview.png,
// plaza-booths.png, canopy-night.png, follow.png, mobile.png and a ~24 s
// clip.mp4 + clip.webm (needs ffmpeg on PATH).
//
// playwright-core is not a dependency of the viewer: point PLAYWRIGHT_CORE at
// an installed copy (a node_modules/playwright-core folder) if it can't be
// imported. The browser is CHROME_PATH, else the system Chrome or Edge.

import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] ?? "http://localhost:4187/projects/toll-sim/").replace(/\/?$/, "/");
const OUT = resolve(process.argv[3] ?? resolve(here, "../../docs/portfolio"));
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
mkdirSync(OUT, { recursive: true });

async function loadPlaywright() {
  try {
    return await import("playwright-core");
  } catch {
    const p = process.env.PLAYWRIGHT_CORE;
    if (!p) throw new Error("playwright-core not found; set PLAYWRIGHT_CORE to its folder");
    return await import(pathToFileURL(join(p, "index.mjs")).href);
  }
}

function chromePath() {
  const c = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return c.find((p) => existsSync(p));
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--autoplay-policy=no-user-gesture-required"],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = (q) => `${BASE}#/live?replay&${q}`;

/** Open the live view and wait until traffic is moving and the camera is placed. */
async function openLive(page, q, settle = 9000) {
  page.on("console", (m) => m.type() === "error" && console.error("  console:", m.text()));
  page.on("pageerror", (e) => console.error("  pageerror:", e.message));
  await page.goto(live(q));
  await page.waitForFunction(() => window.__viewer && window.__viewer.vehicles > 50, null, { timeout: 30000 });
  await sleep(settle);
}

async function shot(name, { width = 1440, height = 900, url, q, settle, dsf = 1, mobile = false, before } = {}) {
  if (ONLY && !ONLY.includes(name)) return;
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dsf,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await ctx.newPage();
  if (url) {
    await page.goto(url);
    await sleep(settle ?? 2500);
  } else {
    await openLive(page, q, settle);
  }
  if (before) await before(page);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log("wrote", file);
  await ctx.close();
}

await shot("landing", { url: `${BASE}#/`, settle: 3500 });
await shot("cover", { width: 1600, height: 900, q: "cam=plaza:A1-G01:overview&time=18:28", settle: 14000 });
await shot("overview", { q: "cam=overview&time=day", settle: 8000 });
await shot("plaza-booths", { q: "cam=plaza:A1-G01:booths&time=day", settle: 11000 });
await shot("canopy-night", { q: "cam=plaza:A1-G01:canopy&time=night", settle: 11000 });
await shot("follow", { q: "cam=follow&time=day", settle: 14000 });
await shot("mobile", { width: 390, height: 844, dsf: 2, mobile: true, q: "cam=plaza:A1-G01:overview&time=dusk", settle: 11000 });

// ---------------------------------------------------------------- clip
// A CDP screencast keeps every frame with its timestamp, so the clip plays at
// real speed and looks sharper than the built-in recorder's output.
if (!ONLY || ONLY.includes("clip")) {
  const W = 1280;
  const H = 720;
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  await openLive(page, "cam=plaza:A1-G01:overview&time=dusk", 9000);
  const frames = [];
  const cdp = await ctx.newCDPSession(page);
  cdp.on("Page.screencastFrame", async (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const plan = [
    [6000, null],
    [7000, () => window.__viewer.plazaShot("A1-G01", "booths")],
    [6000, () => window.__viewer.plazaShot("A1-G01", "canopy")],
    [6000, () => window.__viewer.plazaShot("A1-G02", "overview")],
  ];
  for (const [ms, fn] of plan) {
    if (fn) await page.evaluate(fn);
    await sleep(ms);
  }
  await cdp.send("Page.stopScreencast");
  await ctx.close();

  const dir = join(tmpdir(), `toll-clip-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  let list = "";
  frames.forEach((f, i) => {
    const name = `f${String(i).padStart(5, "0")}.jpg`;
    writeFileSync(join(dir, name), Buffer.from(f.data, "base64"));
    const next = frames[i + 1];
    const dur = next ? Math.max(0.01, next.t - f.t) : 0.04;
    list += `file '${name}'\nduration ${dur.toFixed(4)}\n`;
  });
  list += `file 'f${String(frames.length - 1).padStart(5, "0")}.jpg'\n`;
  writeFileSync(join(dir, "list.txt"), list);
  const total = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
  console.log(`clip: ${frames.length} frames over ${total.toFixed(1)} s`);
  const common = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-t", "27", "-vf", `fps=30,scale=${W}:${H}`];
  execFileSync("ffmpeg", [...common, "-c:v", "libx264", "-preset", "slow", "-crf", "24", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, "clip.mp4")], { stdio: "inherit" });
  execFileSync("ffmpeg", [...common, "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", join(OUT, "clip.webm")], { stdio: "inherit" });
  rmSync(dir, { recursive: true, force: true });
  console.log("wrote", join(OUT, "clip.mp4"), join(OUT, "clip.webm"));
}

await browser.close();
