# toll-sim v2 — Unreal Engine showpiece

The browser viewer stays the live public link at https://mehdiacho.tech/projects/toll-sim/.
v2 is an Unreal Engine 5 build of the same A1 corridor: rendered clips for the project page and a
Windows download. **SUMO stays authoritative.** Unreal reads the same feed the browser does and
never runs its own traffic, physics bodies or collisions.

Written 2026-10-20 after a read-only check of the PC. Nothing is installed yet.

## 1. The PC (checked 2026-10-20, read-only)

| | |
|---|---|
| CPU / RAM | Intel i7-12700H, 16 GB |
| GPU | NVIDIA RTX 3060 Laptop, 6 GB VRAM, driver 610.88 (2026-07-22); Intel Iris Xe also present |
| Unreal Engine | **not installed** (`LauncherInstalled.dat` lists no installs) |
| Epic Games Launcher | installed, 0.98.1 (`%LOCALAPPDATA%\Epic Games\Launcher`) |
| Unity | **not installed** (no Hub editors, no `Program Files\Unity`) |
| Visual Studio | **no VS IDE**; Visual Studio Build Tools 2022 17.14 with the MSVC x64 tools; Windows SDK 10.0.26100. The "Game development with C++" workload is not installed (it needs the IDE). |
| Free disk | C: 161 GB of 474 · X: 43 GB of 317 · V: 85 GB · Y:/Z: 81 GB (the same volume twice) · D: 5 GB |

What this means:

- **6 GB VRAM** is the tight spot. In the editor and the packaged build, use Lumen software ray
  tracing, Nanite meshes, Virtual Shadow Maps and High rather than Epic scalability, and keep
  foliage density under control. Clips render offline through Movie Render Queue, so they can use
  higher settings (Lumen at higher quality, anti-aliasing samples, path-traced stills) without
  having to hold frame rate.
- **16 GB RAM** is enough, with the browser and other apps closed during shader compiles and
  renders. Keep the laptop plugged in and in performance mode.
- **Disk:** the engine goes on **C:** (about 45–60 GB with Windows as the only target and no debug
  symbols), and so does the shared derived data cache (the default,
  `%LOCALAPPDATA%\UnrealEngine\Common\DerivedDataCache`). The project goes on **X:** next to the
  others. 43 GB is enough to start; move it to C: if Megascans content grows past about 25 GB.

## 2. Engine and project

- **Engine:** the newest Unreal Engine 5 release the launcher offers on install day (5.7 or
  later). Pin it in the `.uproject` (`EngineAssociation`) and never upgrade mid-milestone.
- **Project:** `X:\Projects\toll-sim-unreal`, a C++ project (a small game module plus Blueprints)
  named `TollSimUE`. Plugins: Movie Render Queue, PCG, Sun Position (SunSky), Python Editor
  Script Plugin, Editor Scripting Utilities, Fab.
- **Repo:** a separate private repo, `mehdiacho/toll-sim-unreal`. It does not live inside toll-sim,
  because toll-sim's CI and Node tooling shouldn't drag Unreal content around.

### Keeping big assets out of normal git

The LFS quota on a private repo is small, so third-party content never goes in git:

- **Committed (normal git):** `Source/`, `Config/`, `TollSimUE.uproject`, `Scripts/` (editor
  Python and build scripts), `assets-manifest.json` and `ATTRIBUTION.md`.
- **Committed with LFS (small):** only our own authored `.uasset`/`.umap` files: the maps, the
  Blueprints, materials we make, and data assets. Budget: under 300 MB in total. Generated
  content (the road, plazas and terrain built from `road.json`) is rebuilt by script, so it doesn't
  need to be committed at full size.
- **Not committed:** `Content/ThirdParty/**` (Fab, Megascans, Poly Haven, Quaternius, Kenney),
  `Intermediate/`, `Saved/`, `DerivedDataCache/` and `Binaries/`.
  - `assets-manifest.json` lists each third-party asset: source URL, licence, version or date, and
    target folder.
  - `Scripts/fetch_assets.py` downloads the ones with direct URLs (Poly Haven API, Quaternius and
    Kenney zips).
  - Fab and Megascans items are re-added through the Fab plugin, which is a GUI step (see §9).
- **Backup:** a scheduled robocopy of the whole project, minus `Intermediate/Saved/DDC`, to the NAS
  at `/volume4/v4/toll-sim-unreal/`. This is the real safety net for content.

## 3. Feed client

The client uses the same contract as the browser viewer (all plaza fields are optional), reached
through the projects proxy:

- `GET https://mehdiacho.tech/projects/toll-sim/live/live/road.json` returns the corridor: lanes,
  places, gantries and `plazas[]` with lane geometry.
- `GET .../live/live/stream` is server-sent events. `event: init` carries the snapshot (registry,
  recent events, `booms`, `lanes_open`). `event: frame` carries vehicles
  `[id, x·10, y·10, heading°, speed·10]`, `stats.plazas`, `booms` and events. `retry: 3000`.
- **Offline fallback:** the bundled `replay.json` (the same file the browser uses), decoded the way
  `viewer/src/feed.js` decodes it. The packaged build starts on the replay and switches to live
  when the stream connects. That way the download works even if the NAS is down.

**C++ `UTollFeedSubsystem`** (a GameInstance subsystem):

- **Transport:** the HTTP module's streaming response delegate, with a small SSE parser
  (`event:`/`data:`/blank line) and exponential reconnect.
- **Buffer:** frames go into a ring buffer stamped with arrival time. Rendering runs **2.4 s
  behind** the newest frame and interpolates between samples, as `viewer.js` does (`LAG = 2.4`),
  with a short extrapolation if the feed stalls.
- **Coordinates:** sim metres (X east, Y north, heading clockwise from +Y) map to Unreal
  centimetres (left-handed, Z up) as `UE.X = X·100`, `UE.Y = −Y·100`, `yaw = heading − 90°`.
  The ground height comes from a line trace against the landscape, cached per lane segment.
- **Placement:** the feed position is the **front bumper**. Each vehicle is placed at its centre,
  stepping back half the class length along the heading, the same rule as
  `viewer/src/vehicle-geometry.js`. The class lengths come from `sim/demand.py` (2.2, 4.6, 7.5,
  12 and 18.5 m), and the meshes are scaled or chosen to match.
- **Plaza lanes:** the sim's plaza lanes are packed edge to edge. The browser re-spaces them in
  `plaza-layout.js`. So that layout isn't ported by hand, a new
  `viewer/scripts/export-layout.mjs` writes `plaza-layout.json`: the drawn lanes, islands, booth
  and boom positions, canopy extents and the `mapV` remap as a lookup table. Unreal reads it, and
  JS stays the single source of truth for the layout.

## 4. Terrain and vegetation

- The corridor runs about 150 km from Gaborone to Mahalapye, on flat Kalahari bushveld with low
  relief.
- **World Partition** map. The full-detail landscape covers about 4 × 4 km around each of the
  three plazas, plus about 2 km either side of a few hero stretches. The rest of the corridor uses
  a low-poly ground strip generated along the road, which is enough for overview shots.
- **Heights:** Copernicus GLO-30 DEM (free, with attribution), cut to those tiles by
  `Scripts/make_heightmaps.py` (rasterio) into 16-bit PNG landscape imports. The road is flattened
  into it along the lane polylines.
- **Ground materials:**
  - a layered landscape material: red-brown Kalahari sand, dry grass and darker soil under trees
  - Poly Haven CC0 textures, or Megascans surfaces through Fab
  - layers auto-weighted by slope and by distance from the road
- **Vegetation with PCG graphs:**
  - grass clumps, with density driven by the soil layer
  - acacia (umbrella thorn) and mopane trees with scattered shrubs
  - exclusion zones for the road shoulders, plaza aprons, admin car parks and sign footprints
    (taken from `road.json` and `plaza-layout.json`)
  - on 6 GB, foliage uses Nanite where supported, with aggressive cull distances
- **Road:** generated by an editor Python script from the `road.json` lanes:
  - spline meshes for the carriageway and shoulders
  - decals for lane markings (white edge lines, yellow inner edge line, 12 m on / 4 m off dashes,
    matching the browser)
  - a tileable asphalt material with wear

## 5. Vehicles

- **Models, CC0 first:**
  - Quaternius car packs and Kenney Car Kit, for variety
  - free Fab vehicles for detailed cars
  - buses (midi coach, 7.5 m), rigid trucks (12 m) and articulated trucks (18.5 m) are scarce as
    free models, so Fab and Sketchfab CC-BY are checked one by one, and any gaps are modelled
    simply in Blender from primitives (as in the browser) with better materials
  - every asset goes in `ATTRIBUTION.md`
- **Rendering:** one Instanced Static Mesh component per model, with per-instance custom data for
  body colour (the browser's palettes), brake-light intensity and wheel phase. That keeps 1,000+
  vehicles at a few draw calls. Wheels are a separate ISM so they can spin.
- **Animation:** kinematic only.
  - **Wheel spin:** `speed / (2π·r)`.
  - **Suspension bob:** a small sine at speed, plus a damped spring on the vertical axis.
  - **Brake pitch** from deceleration and **acceleration squat**, both from the speed derivative.
  - **Steering:** rotation is smoothed from the heading derivative.
  - **Lights:** brake lights come on when decelerating. Headlights are emissive on every vehicle,
    plus real spotlights only for the 16 vehicles nearest the camera; everyone else gets a
    light-pool decal.

## 6. Plazas

Rebuilt properly from `plaza-layout.json`, following SA mainline plazas (N1 Pumulani, N4
Swartruggens and Marikana):

- approach signage at 2 km, 1 km and 500 m, then "Prepare to stop" and the fare board
- the apron flaring to five lanes per direction: heavy, heavy, mixed, mixed, e-tag
- booth islands with impact attenuators (yellow and black chevrons), booths with windows and
  card readers
- booms that animate from the `booms` feed field, and lane signals (green arrow or red cross)
  from `lanes_open`
- the canopy with the plaza name (Mmamashia, Artesia, Dibete), high-mast lighting and the admin
  building with its car park
- one modular kit (island, booth, boom, canopy bay, gantry sign) placed by script, so all three
  plazas come from the same layout data

## 7. Camera modes

- **Parity with the browser:** Director (auto-cycling shots), Overview, Follow vehicle, and plaza
  overview, booths and canopy views.
- **New:** a drone orbit around a plaza, a road-level "dashcam" chasing a vehicle, and Sequencer
  cine cameras for authored clip shots.
- **Time of day:** SunSky at lat −24.5, lon 25.9, UTC+2. Day, dusk and night presets plus "auto"
  (real time); plaza lamps follow a photocell curve, as in the browser.

## 8. Headless capture and packaging

Both run from the command line, so no GUI is needed after setup.

```powershell
# render a clip (Movie Render Queue, from a saved MRQ config and a Level Sequence)
& "C:\Program Files\Epic Games\UE_5.x\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" `
  X:\Projects\toll-sim-unreal\TollSimUE.uproject /Game/Maps/A1_Corridor `
  -game -MoviePipelineConfig="/Game/Cinematics/MRQ_PlazaDusk.MRQ_PlazaDusk" `
  -windowed -resx=1920 -resy=1080 -log -unattended -nosplash
# frames -> mp4/webm with ffmpeg (already used by viewer/scripts/capture.mjs)

# package a Windows build
& "C:\Program Files\Epic Games\UE_5.x\Engine\Build\BatchFiles\RunUAT.bat" BuildCookRun `
  -project=X:\Projects\toll-sim-unreal\TollSimUE.uproject -platform=Win64 `
  -clientconfig=Shipping -build -cook -stage -pak -archive `
  -archivedirectory=X:\Builds\toll-sim-unreal -nop4 -utf8output
```

- **Clips:** recorded against the bundled replay, so they're deterministic. MRQ settings: Deferred
  render, warm-up frames for Lumen, anti-aliasing samples, a PNG sequence, then ffmpeg to H.264
  and VP9. They go on the project page next to the browser clip.
- **Packaging:** Shipping build, about 1–3 GB zipped. **Hosting:** a public Cloudflare R2 bucket
  (the account has R2 write access), linked from the project page. It doesn't go in GitHub
  releases, because the repo is private. The page states the minimum spec: a GTX 1660 or RTX
  2060-class GPU or better, and Windows 10/11.
- **Editor scripts** (Python, run headless with
  `UnrealEditor-Cmd.exe TollSimUE.uproject -run=pythonscript -script=Scripts\build_world.py`)
  rebuild the road, plazas and PCG volumes from `road.json` and `plaza-layout.json`. That keeps the
  world reproducible and lets most of the work happen without opening the editor on Mehdi's
  screen.

## 9. GUI steps Mehdi must do himself

I can't do these from the command line, or they need his Epic account.

1. **Install Unreal Engine.**
   - In the Epic Games Launcher, sign in and go to Unreal Engine, then Library, then "+" and the
     newest 5.x. Install to `C:\Program Files\Epic Games`.
   - Under Options, keep only "Core components" and the **Windows** target platform. Untick
     Android, iOS, Linux and "Editor symbols for debugging" to save about 30 GB.
2. **Install the C++ toolchain.**
   - Install Visual Studio 2022 Community from the Visual Studio Installer (already present), with
     the **"Game development with C++"** workload. Inside it, tick "Unreal Engine installer"
     support and the Windows 11 SDK (10.0.26100).
   - The existing Build Tools may compile on their own. If the first build complains about the
     MSVC version, add the toolset version Unreal names in the same installer.
   - (The IDE also gives a debugger. JetBrains Rider is an alternative.)
3. **Fab and Megascans.**
   - Sign in at fab.com with the same Epic account and add the free assets from the list I'll
     provide in `assets-manifest.json` to his library.
   - The first time, open the project's Fab panel in the editor and click "Add to project" for
     each item. After that I can work headless.
4. **First editor launch.**
   - Open the project once, so Unreal registers it and he can accept any plugin prompts. Shader
     compiling takes about 30–60 minutes the first time.
   - I can pre-fill the derived data cache headless beforehand to shorten this.

Nothing else needs his screen. Builds, renders, packaging and uploads all run from the command
line.

## 10. Milestones

| | Outcome | Proof |
|---|---|---|
| **M0** | Mehdi does §9 steps 1–2. I create the empty C++ project, repo, `.gitignore`/`.gitattributes` (LFS for `*.uasset`, `*.umap`) and the NAS backup. | Project compiles headless; empty map packages. |
| **M1 Feed parity** | `UTollFeedSubsystem` (SSE plus replay), with boxes moving on a flat plane at the correct positions and headings. | Frame-by-frame position diff against the browser decoder on the same replay, under 0.1 m. |
| **M2 World** | Road, markings, the three plazas from `plaza-layout.json`, landscape tiles from the DEM. | Overview and plaza screenshots; vehicles drive inside the drawn lanes through the plaza flare. |
| **M3 Vehicles and light** | Models, wheel spin, suspension, brake pitch, lights; the day, dusk and night cycle. | 30 s MRQ test clip at dusk. |
| **M4 Look** | PCG grass, acacia and mopane, materials, plaza dressing, post-processing. | Hero stills at each plaza; under 6 GB VRAM at High in the editor. |
| **M5 Ship** | Clips on the project page, packaged build on R2, `ATTRIBUTION.md` complete, minimum spec stated. | Download, run on this PC from a clean folder, and the live feed connects. |

## 11. Risks

- **6 GB VRAM:** dense foliage plus Lumen can run out of memory. Mitigation: High scalability,
  Nanite foliage, cull distances; clips render offline.
- **Long corridor:** the full 150 km at full detail is not realistic. Detail zones plus a low-poly
  strip keep it manageable.
- **Licences:** each asset is checked on its own page before use. Fab's standard licence allows
  cooked use in a distributed build, not redistribution of source assets. CC-BY needs on-screen
  credit, so the build gets a credits screen.
- **Feed drift:** Unreal and the browser must agree on placement. M1 tests against the same replay,
  and the class lengths come from `sim/demand.py`, which test/viewer-geometry.test.ts already pins
  for the browser.
