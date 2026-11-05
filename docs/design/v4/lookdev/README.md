# Studio 3D — phase 1 look development

Open the dev server with `?officeDemo=busy&studio3d=1`. The existing SVG office remains the default without `studio3d=1`.

## Art direction

- A warm late-morning studio corner, viewed as a fixed architectural cutaway from a three-quarter angle.
- Honey oak planks, muted blue rug, sage felt partitions, dark monitor hardware and cognac leather give the zones a specific working character.
- Four desks form two facing pairs; their short dividers and varied journals, mugs and lamps keep the pod from reading as numbered seating.
- The coffee counter and lounge are separated by a clear walking lane. A three-bay window, small skyline, books, board and plants make the corner feel occupied.
- People are 1.7 m class, grounded stylized workers with distinct skin, hair volume, clothing layers and ID cards on one 17-bone rig.
- All art is hand-authored procedural Blender geometry and PBR color materials. No generated room image, character image or texture was used.

## Review first

| View | File |
| --- | --- |
| 1440 × 900 still | [studio-1440.png](studio-1440.png) |
| 1100 × 900 still | [studio-1100.png](studio-1100.png) |
| Seated typist, 2× native capture | [typist-2x.png](typist-2x.png) |
| Chair return and sit-down, 2× native capture | [sit-down-2x.png](sit-down-2x.png) |
| Rise | [stand-up-1440.png](stand-up-1440.png) |
| Walk | [walking-1440.png](walking-1440.png) |
| Drink | [drinking-1440.png](drinking-1440.png) |
| Seated again | [seated-again-1440.png](seated-again-1440.png) |
| Whole sequence | [studio-demo-25fps.webm](studio-demo-25fps.webm) |
| Default SVG proof | [old-default-1440.png](old-default-1440.png) |

The 26.88 s WebM is 1440 × 900 at 25 fps. Its sequence shows typing, a chair push-back and rise, a lane walk, a drink at the counter, a return walk, a chair pull-in and sit-down. The sofa worker remains seated. `window.advanceTime(ms)` freezes real-time progression after first use, advances the mixers in fixed 1/60 s steps and renders once, so the stills are repeatable.

## Assets and sources

| Web GLB | Bytes | Contents |
| --- | ---: | --- |
| `room.glb` | 1,234,504 | Office shell, four equipped desks, three static chairs, coffee and lounge |
| `chair_moving.glb` | 105,220 | The fourth, animated office chair |
| `person_1.glb` | 651,460 | Cardigan, bob, warm olive skin |
| `person_2.glb` | 839,948 | Navy hoodie, textured curls, broader build |
| `person_3.glb` | 627,356 | Pale blue shirt, auburn hair, narrower build |
| **Total** | **3,458,488** | **3.46 MB decimal; under the 15 MB limit** |

Web assets live in [`src/renderer/public/studio3d/`](../../../../src/renderer/public/studio3d/). Vite copies this public directory into both `out/web/studio3d/` and `out/renderer/studio3d/`; the loader uses a document-relative path so the Electron file build resolves the same assets. Blender sources are [`build_studio.py`](../../../../src/renderer/assets3d/build_studio.py) and four `.blend` output files in `src/renderer/assets3d/`. The generated GLBs have eight named clips each: `sit_type`, `sit_idle`, `stand_up`, `sit_down`, `walk`, `stand_drink`, `sofa_sit`, `sofa_talk`.

Regenerate from the repository root in PowerShell:

```powershell
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python src/renderer/assets3d/build_studio.py -- room
& 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background --factory-startup --python src/renderer/assets3d/build_studio.py -- people
```

Capture again with `node docs/design/v4/lookdev/capture-final.mjs` and `node docs/design/v4/lookdev/capture-closeups.mjs`, while the lead's server is running on port 5199. These use headed Chromium with D3D11 WebGL. No texture files are needed; all material colors are PBR constants, so the texture resolution and compression budgets do not apply.

## Measurements and checks

| Measure | Result |
| --- | ---: |
| Headed Chromium, 1440 × 900, RTX 5060 Ti D3D11 | 60 fps over 10 s |
| Main-thread busy fraction | 0.079 |
| Script busy fraction | 0.065 |
| Main JS bundle (SVG default) | 547.65 kB minified, 171.79 kB gzip |
| Flag-only Studio3D JS chunk | 632.58 kB minified, 160.38 kB gzip |
| All GLBs | 3.46 MB |
| `tsc --noEmit -p tsconfig.web.json` | 0 errors |
| `vite build --config vite.web.config.ts` | succeeded |
| `electron-vite build` | succeeded; all five GLBs copied to `out/renderer/studio3d/` |
| Renderer Vitest suite | 102/103 passed; the known `motion.v33.test.ts` idle overlap fails |

RevvyIDE `mesh_stats` measured 23,036 triangles in the room source and 5,148 / 6,612 / 4,872 triangles in the three people. The web asset has 20 room meshes, 18 chair meshes and nine skinned meshes per person; the people use 17 bones. [`pose_check.py`](../../../../src/renderer/assets3d/pose_check.py) measured seated hip height 0.54 m, seated foot bone tip 0.099 m above floor, and stand/sit transition foot tip at least 0.059 m (the shoe sole extends down to the floor). The typist's hand is 0.03 m from the keyboard in depth and 0.025 m in height at the first pose key. The old default was also opened and captured after the flag change.

## Known problems

- Fingers and shoulder deformation remain simple at close range. The hands reach the keyboard, though monitor backs hide parts of the typing gesture in the wide shot.
- Walk contact is authored as a rigged cycle matched to roughly 1 m/s route speed, with no foot IK. The present video shows one foot grounded while the other swings, but foot locking should be strengthened before the full cast is added.
- The skyline and whiteboard details are deliberately geometric. Material variation and soft contact occlusion can gain more nuance in phase 2.
- RevvyIDE `asset-qa` flags tiny detached mouth, hair and ID stripe meshes and UV overlap from procedural primitives. These are intentional separate details, but the nine materials per person exceed its two-material web guidance. A character atlas is needed before scaling to thirteen people.

## Phase 2 plan — estimate 9–12 working days

1. Extend the corner into a roughly 14 × 9 m floor with three staggered four-person pods, a producer desk and a small meeting table. Preserve the right-hand social area and a 1.1 m or wider circulation loop; adjust the orthographic framing for 1100 px screens. **2 days.**
2. Build ten more distinct people from the shared rig, with silhouette, face, skin, hair and clothing changes. Atlas their materials and reuse mesh instances where safe. **2–3 days.**
3. Bind 3D state to member status, `officeDemo.ts` and `studio/motion.ts`; add path reservations, yielding, facing on visits, varied rest trips, review hand-off and report trips, and event reactions including composed emergency stop/release. **3–4 days.**
4. Add small stable name tags and hover/selection detail, then run visible-pose, route, overlap, tag-truth and frame-rate probes at both target viewports. **2–3 days.**

Phase 2 should preserve the absence of numbered desk plates and the current three-quarter, non-pixel staging. The full 13-person shot will need careful silhouette separation and selective detail because each worker will occupy fewer pixels.
