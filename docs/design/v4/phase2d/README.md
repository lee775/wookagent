# Studio 3D phase 2d

## Goal

Create each member workstation and character when that member joins, with no pre-placed member desks.

## Working notes

- Follow-up review (2026-10-29): the pointed headphone band and broad rigid sweater hem are corrected. The complete seated kit matrix and final checks are recorded below.

- Baseline: phase 2c has 12 fixed member stations and one producer station. The snapshot truncates non-producers at 12.
- The supplied RevvyIDE folder contained `develop-web-game` and `game-feel`, which were read. The named rigging, modeling, facial, animation, optimization, and asset-QA skills were absent.
- Asset exports must be atomic while the owner preview remains running.

## Character kit follow-up

The headphone strap now follows the crown with 24 curved sections, a 32 mm width, and an 8 mm thickness. Its height follows the hairstyle and the same face-width/face-height transform as the hair. Styles 1 (curls), 3 (quiff), 5 (bun), 10 (top knot), and 11 (braid) use ear cups only. This also removes the short exposed band fragment seen between the braid's hair lobes in the sofa close-up. The previous `headphones` asset name remains a safe cup-only fallback while exports and runtime updates are loaded.

The sweater's capped circular hip cylinder caused the tutu shape. It is replaced by an open elliptical cloth ribbon that follows the torso section. The ribbon receives the same transferred pelvis/spine weights as the torso panels. All nine garments, including the coat, are checked through `sit_type`, `sofa_talk`, `sit_lean_back`, and the runtime meeting pose, `sit_think`. Sleeve weights, the common rig, face morphs, and the single skinned draw remain intact. Member seeds and appearance choices are unchanged.

### New images, all at 2x

- [New 24-member lineup](kit-followup/lineup-24-2x.png).
- [New sofa conversation close-up](kit-followup/sofa-talk-2x.png).
- [Actual meeting-table close-up](kit-followup/meeting-table-2x.png).
- [Full-resolution seated contact sheets](kit-followup/README.md): **864 cases across 24 pages**, covering the complete product of 9 garments x 12 hairstyles x headphone on/off x 4 seated contexts. Each character is rendered at 384 x 440 pixels for a 192 x 220 logical cell. The [overview](kit-followup/seated-matrix-index.png) is reduced for navigation; open the individual pages for 1:1 review.

The isolated matrix exposes each hem without furniture hiding it. The studio close-ups show the real sofa and meeting table. [Coverage](kit-followup/coverage.json) records every case, and [validation](kit-followup/validation.json) records image dimensions and hashes. All 864 renders contain a character. Every paired headphone-on/off render has identical pixels below the head, confirming that accessory selection does not change the seated cloth. The twelve headphone-on pages, lineup, and both furniture close-ups were inspected at native resolution.

### Follow-up checks

All four required commands pass: [TypeScript](kit-followup-typecheck.log), [web build](kit-followup-web-build.log), [Electron build](kit-followup-electron-build.log), and [renderer tests](kit-followup-vitest.log), **167 tests in 24 files**. The ten new cases check twelve actual headphone/hair module bounds and all nine garments over **1,188 seated animation samples**. Hem measurements select cloth influenced by pelvis/spine, excluding bent sleeves. They reject broad horizontal shelves and excessive front-to-back hem extent. Regression mutations restore the old 1.91 m apex and the old circular hem dimensions; both violate their respective acceptance bounds. These fixtures are separate from the original thirteen isolated code mutations, which were rerun and all remain killed: [log](kit-followup-mutations.log).

The twelve runtime GLBs now total **8,060,592 bytes (8.06 MB)**, below 15 MB. [Asset audit](asset-audit.json) records the current hashes. Exports were atomic. The layout, hiring videos, and performance records below are the original phase 2d acceptance run; the images in this section are the acceptance evidence for this kit revision.

To reproduce the matrix, start the own dev server on port 5198 (`npx vite --config vite.web.config.ts --host 127.0.0.1 --port 5198 --strictPort`) and the isolated temp-profile Chrome from the reproduction section, then run:

```powershell
python -B docs/design/v4/phase2d/capture_kit_followup.py
python -B docs/design/v4/phase2d/validate_kit_followup.py
```

`src/renderer/src/studio3d/kitReview.ts` is an explicit review entry point imported by the local capture script. It renders the same assembler as the office and portraits; it is not included in the app flow. Blender's `kit` mode exports all rigs and accessories, and `appearance` exports only the fitted hair/accessory modules.

## Kit and layout

- `room.glb` now contains shared furniture only. `workstation_kit.glb` supplies three desk shapes, a moving chair, monitor, laptop, and eight role/personal prop modules. The runtime batches a desktop and its chair into two draws, including their props.
- Every live member reserves a persistent slot by id. The producer uses the same workstation path. Removing a colleague keeps the other reservations intact; the old slot is released after the colleague reaches the door.
- Pods grow west from the producer and the existing asymmetric groups. Further groups alternate paired desks with perpendicular nooks. The floor, window wall and rugs extend with occupied bands. The original pod circulation lanes are reserved in navigation before hiring fills them; these reservations do not create any meshes.
- First-load stations are settled. Later stations fade and settle over 0.85 seconds, followed by a door arrival, normal navigation/yielding and sitting. New name tags wait until the person sits. Removed people stand and walk out before their station clears.
- The character kit has eight everyday garments and a producer coat, twelve hair modules, glasses, beard, headphones and lanyard. Id selects warm muted colours and proportions. Small role cues choose accessories. Collision resolution avoids repeated hair/garment/palette combinations in the tested teams. The finite palette can repeat after 1,152 combinations; it never limits membership.
- Existing look reservations take priority over newcomers. Collision seed bumps persist in local storage so a reload keeps the resolved appearance. With storage disabled, reservations last for the session. A fresh-module test verifies repeatability, and a forced collision verifies that the newcomer gets the changed seed.
- Each assembled character is one skinned mesh and one material, including hair and accessories. The 17-bone rig, transferred sleeve weights, face morphs and the original 24 actions remain. Two small turning actions were added. Portraits use the same assembler and look registry; the numeric portrait function and component props remain compatible.
- Rendering, walking, and transitions run each frame. Seated actions update at 25 Hz, tags at 15 Hz, camera-transition tags at 30 Hz, and shadows at 15 Hz. Tag projection reads viewport dimensions once before writing styles. Live rendering omits the extra matrix traversal used solely for deterministic foot measurements.
- Blender bakes object transforms before height adjustment. Rig metadata supplies height and face proportions for the hair modules. Relative morph mode and zero morph deltas on attachments prevent body collapse during a blink. Sofa conversation keeps hands near each person's own lap. Four small finger tips separate the mitten silhouette.
- The sit/stand frame has telescoping legs, a crossbar, and a control. Its initial working height matches the seated animation. Runtime height adjustment is not implemented.
- Membership changes interpolate the camera over 0.75 seconds. Teams above 24 people allow twelve simultaneous walkers; queued people retain their destinations. The benchmark can bypass this limit. This limits movement concurrency, not membership or clickability.
- Neighbouring chairs reserve their exit space before rising. One person waits seated until the other clears the aisle. All nine rest guests must finish their routes in the progress regression test. Removed actors, furniture, and old floor extensions release their owned GPU resources.
- The coffee alcove has a real entrance opening. Its wall is included in navigation. The board, calendar, and clock sit on the remaining wall, and an actual GLB ray test checks the arrival head at three heights. The entrance origin is shared by arrival, departure, and QA.
- Tags protect every face and the waiting or error hands. Their travel speed is independent of tag update frequency. The read-only hover card does not capture pointer input. Probes move the real pointer before clicking a tag or the face centre.
- Arrivals cross a visible entrance apron before heading to their own desk, including idle members. The whole narrow entrance is reserved for one newcomer at a time. Moving the counter plant cleared a grid-width pinch point; empty same-cell replans retain the final approach instead of stranding the person.
- Snapshot changes are reconciled before paint, and asset loading reads the latest committed snapshot. Changing projects remounts the scene. A delayed-asset probe starts with eight settled desks and eight actors, with no stale initial roster.
- Small-team framing returns to the occupied desks after an arrival finishes. Departures temporarily include the exit. Camera interpolation and desk settling pause during emergency freeze. Persistent distant reservations also contribute to framing after removals.
- Picking refreshes the skinned mesh bounds for the current pose. The project-switch probe reproduced a missed rising head with the cached seated bounds; the same click passes after the refresh. The refresh runs only on pointer selection.

## Size measurements

Measurements use a 1440 by 900 viewport at device scale 1. Raw samples are in [size-measurements.json](size-measurements.json).

| Total people, including producer | Minimum standing height | Minimum seated head and torso |
| --- | ---: | ---: |
| 2 | 190.8 px | 92.8 px |
| 13, default | 109.4 px | 48.5 px |
| 20 | 85.3 px | 39.3 px |
| 24 | 78.5 px | 36.3 px |
| 30 | 62.8 px | 28.8 px |
| 50 | 51.8 px | 24.3 px |

At 30 and 50 people, the floor and window wall extend west. The default view shows everybody at a smaller size. Shared rest capacities remain coffee 2, sofa 2, window 2, and meeting 3. A removed person's actor and furniture remain visible until departure, then their slot is released.

The outermost station centre is x=-16.85 m with 30 people and x=-24.83 m with 50. Both teams remain visible and clickable at all three tested widths. Camera distance and its far plane also grow with depth, so very long procedural floors do not retain a fixed 100 m clipping limit.

## Performance method

The production web build runs in Chrome on the NVIDIA GeForce RTX 5060 Ti through ANGLE D3D11. FPS comes from requestAnimationFrame counts. Busy is the renderer main-thread `Performance.TaskDuration` delta divided by elapsed time. It is not total machine CPU usage. The display limits these runs to about 60 fps, so the results do not establish uncapped GPU throughput.

The seated test alternates 20 and 30 people five times after warm-up. The moving test exercises twelve short-reversal walkers three times. Each timed window lasts five seconds. Raw repeats include counts, GPU identity, render counters, and browser errors. Other teams' processes remain running. The separate capture browser and video encoder were stopped before these runs. Render counters describe the last frame and can include its shadow pass.

| Workload | Repeats | Median fps | Minimum fps | Median busy | Busy range |
| --- | ---: | ---: | ---: | ---: | ---: |
| 20 people, working | 5 | 60.11 | 60.01 | 0.111 | 0.104–0.116 |
| 30 people, working | 5 | 60.01 | 59.96 | 0.138 | 0.129–0.149 |
| 20 people, twelve reversal walkers | 3 | 59.98 | 59.98 | 0.115 | 0.113–0.117 |
| 30 people, twelve reversal walkers | 3 | 60.01 | 60.00 | 0.144 | 0.131–0.160 |
| 50 people, 49 requested walkers | 1 | 60.03 | 60.03 | 0.233 | one stress sample |

All eight 20-person runs meet 55 fps and busy <=0.15. One 30-person moving repeat exceeds 0.15. In the uncapped 50-person stress run, 49 actors had walking routes and 31 were actively playing walk or turn clips at the end; busy exceeded 0.15. Normal teams above 24 therefore retain the twelve-locomotion limit. Queued actors are still rendered and selectable.

Raw data: [working repeats](performance-final.json), [twelve-walker repeats](performance-12-walkers-final.json), and [uncapped stress](performance-49-walkers.json). [verification-summary.json](verification-summary.json) combines the final records; `python -B docs/design/v4/phase2d/final_evidence.py` validates their counts and budgets.

## Foot contact

[foot-slide.json](foot-slide.json) records planar planted-foot bone travel inside each authored contact window. Totals are divided by contact count, as in phase 2c. The support windows centre at t=0 for L and t=0.5 for R. Source walking now uses a linear backwards support-foot trajectory at 1.1 metres per second. Sharp direction changes use turn steps before translation.

| Route | Contacts | Mean travel per contact | Maximum contact |
| --- | ---: | ---: | ---: |
| Full 88-second cycle | 240 | 0.00285 m | 0.13067 m |
| Twelve-walker short reversal | 398 | 0.00101 m | 0.06695 m |

The cycle mean is below 0.041 m, and the reversal maximum is below 0.08 m. The cycle maximum remains higher near visit or yield transitions and is reported separately.

## Tests and recorded mutations

Renderer tests cover station counts 0, 1, 2, 12, 13, 20, 24, 30, and 50; exact actor addition and departure; stable slots; settling; repeatable looks; furniture clearance; capacities; yielding; freeze; tags; and exported rig and morph contracts.

Tests contain explicit mutated values alongside acceptance assertions. These are regression mutation checks, not a whole-program mutation score.

[run_mutations.mjs](run_mutations.mjs) also compiles isolated copies of the real modules and runs thirteen actual code mutations. All eleven original oracles pass, and all thirteen mutations are rejected. The temporary modules are outside concurrent test discovery and are removed after the run. [mutation-results.json](mutation-results.json) records each error. Restoring parallel chair exits reproduces seven completed rest guests instead of nine. Moving the entrance behind the wall fails the real-room visibility oracle. Blocking the counter aisle prevents the fourteen-person hiring stream from finishing.

| Mutation | Detecting assertion |
| --- | --- |
| Restore the twelve-member truncation | Counts through 50 must include everybody |
| Reindex seats after deletion | Existing coordinates must remain unchanged |
| Omit the chair module | Each workstation requires its movable chair |
| Skip settling | The half-time station must be between start and settled state |
| Repeat a hair, garment, and family tuple | All 50 generated tuples must differ |
| Process a colliding newcomer before the reserved look | The existing person's appearance must remain unchanged |
| Place a new station on the sofa | Shared furniture intersection must be false |
| Spawn the newcomer at the desk | The actor must start at the door |
| Lose relative morph mode during merging | A blink must leave leg vertices unchanged |
| Select the opposite contact foot | The exported support foot must move backwards |
| Put sofa wrists at the same point | Partner hand clearance must exceed 0.30 m throughout the clip |
| Bypass the walker limit | Normal large-team moving count must be at most twelve |
| Overfill the sofa or merge actor positions | Capacity and pair-distance checks must reject the frame |
| Turn a visitor away | Visit-facing checks must reject the frame |
| Start opposing chair exits together | All nine rest guests must arrive, rather than seven |
| Accept overlapping or face-covering tags | Tag packing and protected areas must reject the rectangle |
| Replace a waiting gesture with typing | Status and pose must agree |
| Skip the entrance apron or the newcomer's first desk | The idle newcomer must cross the apron and sit at their own desk first |
| Drop a final same-cell route approach | Navigation updates must not strand an arrival |
| Animate the settling desk during emergency freeze | Its height must remain unchanged during the pause |
| Move the counter plant into the narrow aisle | The full hiring stream must finish with fourteen seated people |

## Reproduction

Use an isolated Chrome profile in the OS temp folder with CDP port 9232 and the app on port 5198. Probes never connect to the owner's port 5199. Run Python with `-B`.

After building, start the preview in its own terminal with `npx vite preview --config vite.web.config.ts --host 127.0.0.1 --port 5198 --strictPort`. Start Chrome with `--headless=new --no-sandbox --disable-gpu-sandbox --remote-debugging-port=9232 --remote-allow-origins=*` and `--user-data-dir="$env:TEMP/wook-phase2d-gpu"`. Stop only these owned processes afterward. Both owned Chrome instances and port 5198 were stopped after the final measurements; the owner's 5199 endpoint still returned HTTP 200.

```powershell
npx tsc --noEmit -p tsconfig.web.json
npx vite build --config vite.web.config.ts
npx electron-vite build
npx vitest run --config src/renderer/tools/vitest.config.ts
python -B docs/design/v4/phase2d/verify_scene.py
python -B docs/design/v4/phase2d/capture_evidence.py --part all
python -B docs/design/v4/phase2d/measure_perf.py
python -B docs/design/v4/phase2d/measure_motion.py
python -B docs/design/v4/phase2d/asset_audit.py
node docs/design/v4/phase2d/run_mutations.mjs
```

Blender export modes are `room`, `workstations`, and `kit`. Set `PYTHONDONTWRITEBYTECODE=1` for its embedded Python. GLBs export to a temporary filename, then replace their destination atomically.

## Paths to inspect

- `src/renderer/src/studio3d/Studio3D.tsx`: membership reconciliation, scene objects, arrivals, removal, framing, and picking.
- `workstations.ts`, `placement.ts`, and `navigation.ts` in the same directory: deterministic desk dressing, persistent slots, floor growth, and clearance.
- `behaviour.ts` and `footContact.ts`: yielding, capacities, visits, departure, turn steps, and contact windows.
- `characterKit.ts`, `portrait.ts`, and `Member3DPortrait.tsx`: one-mesh assembly and consistent generated portraits.
- `src/renderer/assets3d/build_studio.py` and `character_detail.py`: room, modules, rig, transferred garment weights, and animations.
- `src/renderer/src/api/fake/officeDemo.ts`: preserved 88-second cycle, hiring, and team-size demos.

## Remaining limits

- The finite hair, garment, and colour signature space has 1,152 combinations. Very large teams can repeat a signature. Membership has no corresponding cap.
- The 30- and 50-person default views fall below the 24-person pixel-size bar. They retain member picking.
- Above 24 people, the twelve-walker limit can lengthen arrivals and rest transitions.
- The full-cycle worst contact is 0.13067 m, despite its low mean.
- One 30-person moving repeat had busy 0.1596. The 20-person budget passes in every measured repeat.
- Sit/stand desks start at seated height. Runtime desk height adjustment is outside this change.

## Evidence status

The original phase 2d run passed TypeScript, the web build, the Electron build, and **157 renderer tests in 23 files**. Its command logs are [typecheck.log](typecheck.log), [web-build.log](web-build.log), [electron-build.log](electron-build.log), and [vitest-final.log](vitest-final.log). The kit follow-up above passes the expanded 167-test suite.

The full probe covers cycle, hiring, team2, team20, and team30 at **1100, 1440, and 1920 by 900**, advancing each cycle for 88 seconds and hiring for 75 seconds at 25 samples per second. Its **13,125 samples and 237 actual pointer clicks pass with zero violations or browser exceptions**. The extra team24/team50 probe adds 600 samples and 222 successful clicks, also with zero violations. Raw results are [probe-results.json](probe-results.json) and [probe-extra.json](probe-extra.json). Counts match the committed roster at every sample; every hire finishes at their own desk.

Additional lifecycle evidence:

- [Live newcomer picking](live-picking.json): seven real face clicks before and after the first newcomer's name tag appears.
- [Delayed asset loading](loading-membership.json): twelve GLBs were held while the roster grew; the first ready scene had eight settled stations and eight actors.
- [Small office and project switching](small-project-lifecycle.json): four seated people after a live hire, minimum standing height 163.2 px, and all clicks after switching projects in both directions.
- [Removal](removal-lifecycle.json): the hired person rises and walks out, reaching within 0.0061 m of the door. After 338 samples, exactly one actor and one station have cleared. Departing furniture intentionally remains until its actor leaves.

The twelve runtime GLBs total 8,060,592 bytes, or 8.06 MB after the kit follow-up. [asset-audit.json](asset-audit.json) lists sizes, hashes, animation counts, and skinned-node counts. Each assembled person uses one skinned draw. Each workstation uses two draws, including its contents and independent chair.

## Videos and visual review

- [Hiring, 75 seconds at 25 fps](hiring-25fps.webm): 1,875 decoded frames, eleven animated setups, eleven standing door arrivals, zero frame-check violations, and fourteen seated people at the end. [Per-frame review](hiring-frame-review.json).
- [Default cycle, 88 seconds at 25 fps](cycle-88s-25fps.webm): 2,200 decoded frames, zero frame-check violations, including the idle segment. [Per-frame review](cycle-frame-review.json).
- 1440 stills: [team2](team2-1440.png), [default](default-1440.png), [team20](team20-1440.png), [team24](team24-1440.png), [team30](team30-1440.png), [team50](team50-1440.png).
- [24 generated members at 2x](lineup-24-2x.png), [sofa conversation](sofa-talk-2x.png), and [hands](hands-2x.png).
- Consecutive native-pixel frames: [first setup](hiring-first-settle-25-frames.png), [door entry](hiring-first-entry-25-frames.png), [entrance walk](hiring-first-walk-25-frames.png), and [last setup](hiring-last-settle-25-frames.png).
- Whole-video contact sheets: [hiring 0–23 s](hiring-contact-00.png), [24–47 s](hiring-contact-01.png), [48–71 s](hiring-contact-02.png), [72–74 s](hiring-contact-03.png); [cycle 0–23 s](cycle-contact-00.png), [24–47 s](cycle-contact-01.png), [48–71 s](cycle-contact-02.png), [72–87 s](cycle-contact-03.png).

Automated checks inspect scene state at every captured frame and decode every encoded frame. Hiring checks reject a desk that appears settled, a discontinuous settle, a seated entry pose, or an entry away from the door. Visual review used the native stills, lineup, close-ups, consecutive setup/entry/walk frames, and whole-video contact sheets. These checks cannot certify every possible mesh intersection from every camera angle.

The final evidence links above are the acceptance records. Files named initial, before, tuning, quick, or capture-run retain intermediate diagnostics from development.
