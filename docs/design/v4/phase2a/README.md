# Studio 3D — phase 2a

## What changed since the first 2a pass

The first pass had segmented mannequin limbs, repeated chest discs, small people and a bare office. The rebuilt workers use one connected Skin/Subdivision body, continuous sleeves and trousers, and a shared 17-bone rig. Heights, shoulder and hip widths vary. All 13 have eyes with whites and pupils, brows, ears, noses and mouths; hair includes bobs, curls, ponytails, side parts, long hair, buns and cropped cuts. Some wear glasses or beards. The clothes now include open cardigans, hoodies with hoods and cords, collared shirts, knit vests, a blazer, zip fleece, rolled sleeves and a longer producer coat. Hoodie pouches and oversized collar blocks were removed because they looked like bibs. The phase 1 palette and seated alignment remain.

The room gained wall art, a clock, calendar, corkboard, printer, water cooler, bags, jacket, coat rack, rugs, varied plants, door, phone booth, varied desks and monitors, laptops, warmer pendant lighting and a sky/building silhouette outside the windows. The camera crops unused floor corners to enlarge people. The directive board uses a 2048 × 512 canvas, larger type and anisotropic filtering. The 3D/WebGL2 default, 2D fallback, `?studio3d=0`, zoom, pan, reset and selection controls remain.

The coffee mug follows the exported `handR` bone. Blender's `hand.R` is renamed during GLB export, which caused the earlier missing mug. Wrist vertices had also been weighted to the thigh, stretching some faces to 1.06 m when the arm rose. Separate sleeve and leg weights reduced the longest deformed face in that pose to 0.26 m. The final coffee close-up shows the cup in hand. The sofa partners face each other; the window visitor clears the left wall.

## Visual deliverables

- Nine full screenshots: `busy-*.png`, `idle-*.png`, `events-*.png` at 1100, 1440 and 1920 px widths.
- `lineup-2x.png`: all 13 people, front and three-quarter. The individual 480 × 640 portrait tiles are in `lineup_parts/`.
- Seven `desk-*-2x.png` role close-ups; six status close-ups (`hand_raise`, waiting, `head_in_hands`, `sit_lean_back`, `sit_think`, `sit_celebrate`); four rest close-ups (coffee, sofa talk, window gaze, meeting table).
- `busy-20s-25fps.webm`: 1440 × 900 VP8, exactly 20.000 s, 25 fps, 500 frames, 2,229,277 bytes. The capture script trims the browser loading segment before encoding the final 500 frames.

The full room remains deliberately stylized. The close-ups show the actor and relevant chair, desk or rest prop. For the coffee portrait only, unrelated foreground meshes and the other coffee guest are hidden by the capture hook so the mug and arm are inspectable; the normal office scene is unaffected.

## Asset sizes and QA

The 15 GLBs total **14,834,372 bytes** (14.83 MB decimal), within the 15 MB limit. The room GLB is 3,879,424 bytes and the moving chair is 107,500 bytes. All 15 files are also present in `out/renderer/studio3d/`. The room source has **1,060 mesh objects**, **71,480 triangles** and **20 materials**. Every person has **one vertex color material and 0 MB of textures**.

| Person | Garment | Triangles | Materials | Texture MB | GLB bytes |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | Cardigan | 7,264 | 1 | 0 | 994,944 |
| 2 | Hoodie | 8,640 | 1 | 0 | 981,728 |
| 3 | Shirt | 7,044 | 1 | 0 | 780,108 |
| 4 | Vest | 7,316 | 1 | 0 | 794,488 |
| 5 | Blazer | 7,288 | 1 | 0 | 793,652 |
| 6 | Fleece | 7,096 | 1 | 0 | 786,804 |
| 7 | Rolled sleeves | 6,764 | 1 | 0 | 738,956 |
| 8 | Cardigan | 7,296 | 1 | 0 | 795,564 |
| 9 | Vest | 8,448 | 1 | 0 | 941,928 |
| 10 | Hoodie | 7,464 | 1 | 0 | 833,820 |
| 11 | Shirt | 6,900 | 1 | 0 | 762,280 |
| 12 | Rolled sleeves | 7,236 | 1 | 0 | 798,636 |
| 13 | Producer coat | 7,876 | 1 | 0 | 844,540 |

`asset-audit.json` and `asset-qa-room.txt` record every room and person source object, per-object triangles/materials and all QA findings. **All 13 people pass with zero QA errors**, including the four that previously had detached or overlapping decorations. The room game-profile QA reports 97 errors and 341 warnings: 81 detached-part findings mostly identify intentional independent static props such as keyboards, glass and leaves; 16 findings identify overlapping coplanar pairs. They remain visible in the report rather than being filtered out.

## Probe, size and performance

`render_game_to_text` projects every vertex of the **posed skinned meshes** to screen space and uses the exported hip bone for seated head-to-torso height. The count is compared with the active snapshot, including the producer. The busy, idle and events demo snapshots each contain **12 members**, so all nine probes report **12/12**, zero placement/clip issues and zero browser errors. The placement test adds a synthetic thirteenth member to exercise full capacity.

| Width | Busy seated head + torso min | Idle standing min | Idle seated min | Events standing min | Events seated min |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1100 | 34.4 px | 75.5 px | 34.4 px | 74.8 px | 34.4 px |
| 1440 | 47.8 px | 104.8 px | 47.8 px | 104.0 px | 47.8 px |
| 1920 | 57.4 px | 126.0 px | 57.5 px | 125.0 px | 57.4 px |

At 1440, the minimum standing height is **104.0 px** against a 64 px bar; the minimum seated head plus torso height is **47.8 px** against a 36 px bar. The 10 s Chromium/D3D11 sample measured **60 fps**, **0.023 main-thread busy** and **0.014 script busy**; the limits are at least 55 fps and at most 0.15 busy. Zoom, pan, double-click reset and member selection all passed. The web Studio 3D chunk is **641.15 kB** (163.63 kB gzip); the Electron renderer Studio 3D chunk is **1,520.24 kB**.

The earlier 404 was Chromium's implicit root `/favicon.ico` request, not a GLB. The capture intercepts that request with a 204, and no Studio asset, script, console or page error is logged. The application still lacks a root favicon because its `index.html` and root public directory are outside this phase's edit scope.

## Verification

- `npx tsc --noEmit -p tsconfig.web.json`: pass.
- `npx vite build --config vite.web.config.ts`: pass.
- `npx electron-vite build`: pass; all 15 GLBs copied to the renderer output.
- `npx vitest run --config src/renderer/tools/vitest.config.ts src/renderer/src/studio3d/placement.test.ts`: **5/5 pass**. The tests include mutation assertions for swapping a seat, adding an over-capacity sofa guest, coincident actors, putting a coffee guest inside the counter and replacing waiting with typing.
- Full renderer Vitest: **109/110 pass**. The single failure is the separate 2D `studio/motion.v33.test.ts` 300 s idle-walk overlap at 52.2 s between M-0016 and M-0022. That path is outside the authorized 2a edit scope.
- `pose_check.py`: seated hip 0.54 m and feet 0.099 m; rise/sit progress continuously with minimum foot height 0.059 m. Complete asset QA: 13/13 people pass.
- `capture.mjs`: nine scenarios, 17 close-ups, four controls, 10 s performance capture and 20 s / 25 fps video. `probe.json` has the per-person measurements and checks.

## Known problems and plan for 2b

The wide view still has a repeated desk-pod rhythm, and the stylized cloth and hands can be refined further. Phase 2b should improve spatial asymmetry, desk storytelling, facial expression and fabric shapes while keeping the one-material characters and performance margin. It should fix the 16 coplanar room pairs, then make the room QA distinguish intentional independent props from actual detached geometry. The root favicon and the unrelated 2D walk-overlap failure need changes in paths that this phase could not edit.

To reproduce assets, run Blender 5.2 headless with `build_studio.py -- room` and `build_studio.py -- people`. Run `audit_meshes.py` for both QA reports, `render_lineup.py` followed by `compose_lineup.py` for the lineup, and `capture.mjs` against the office demo server for the browser outputs. The `.blend` files retain all actions; `person_1.glb` carries the shared runtime clips.
