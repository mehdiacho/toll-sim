import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

// The road geometry is exported by sim/export_3d.py into live/road.json; keep
// the viewer's copy in sync whenever the source is present.
function syncRoad() {
  const src = resolve(__dirname, "../live/road.json");
  const dst = resolve(__dirname, "public/road.json");
  return {
    name: "sync-road",
    buildStart() {
      if (existsSync(src)) copyFileSync(src, dst);
    },
  };
}

export default defineConfig({
  base: "/projects/toll-sim/",
  plugins: [syncRoad()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
  preview: { port: 4173 },
});
