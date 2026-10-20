// Plaza geometry for the Unreal client (toll-sim-unreal), taken from the
// browser's own builder so the two never drift apart.
//
//   node scripts/export-plazas.mjs <outDir>
//
// Starts a Vite dev server on this viewer, loads tools/export-plazas.html in
// headless Chrome, and writes:
//   <outDir>/plazas.json        layout, meshes (base64 float32) and moving-part slots
//   <outDir>/textures/*.png     sign atlases, fare boards, chevrons, lane signals
// Needs playwright-core (or PLAYWRIGHT_CORE pointing at a copy), like capture.mjs.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? resolve(here, "../plaza-export"));
mkdirSync(join(out, "textures"), { recursive: true });

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
    "/opt/pw-browsers/chromium",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  return c.find((p) => existsSync(p));
}

const server = await createServer({ root: resolve(here, ".."), configFile: resolve(here, "../vite.config.js"), server: { port: 4199, strictPort: false }, logLevel: "warn" });
await server.listen();
const port = server.config.server.port;
const url = `http://localhost:${server.httpServer.address().port}/projects/toll-sim/tools/export-plazas.html`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromePath(), headless: true });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__export, null, { timeout: 60000 });
  const data = await page.evaluate(() => window.__export);
  for (const [name, dataUrl] of Object.entries(data.textures)) {
    writeFileSync(join(out, "textures", `${name}.png`), Buffer.from(dataUrl.split(",")[1], "base64"));
  }
  data.textures = Object.keys(data.textures).map((n) => `textures/${n}.png`);
  data.source = "toll-sim viewer/src/plazas.js via scripts/export-plazas.mjs";
  writeFileSync(join(out, "plazas.json"), JSON.stringify(data));
  const verts = data.plazas.reduce((a, p) => a + p.meshes.reduce((b, m) => b + m.geometry.count, 0), 0);
  console.log(`wrote ${out}: ${data.plazas.length} plazas, ${verts} vertices, ${data.textures.length} textures (port ${port})`);
} finally {
  await browser.close();
  await server.close();
}
