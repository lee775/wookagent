# Studio 3D phase 2c integration

This pass combines the [polished assets](../polish/README.md) and [phase 2b behaviour](../phase2b/README.md), including their [runtime](../polish/runtime-requests.md) and [asset](../phase2b/asset-requests.md) requests. The three-quarter camera, palette, rest places, 88 s cycle with 24 s idle, emergency freeze, reduced motion, portraits, and 2D fallback remain.

## Changes

- Every actor binds its own GLB animation set, including eyeBlink and mouthOpen tracks. Staggered blink clocks avoid synchronized faces. The cycle measured 13/13 blinking within 10 s, a non-first actor's sit_type mixer blink at 1.000, and a non-first actor's sofa_talk mixer mouth at 0.936.
- Characters cast shadows without receiving their own shadow map; the sun uses tuned bias and normal bias. The new 2x close-ups have no diagonal acne, and chair and foot contact shadows remain in the room stills.
- Labels fit outside projected heads and hands. The waiting gesture holds its final, hand-above-monitor pose. The cycle found no status-chip/pose overlap at 1100, 1440, or 1920.
- The room GLB has independent pivots for 12 desk chairs, the producer chair, and three meeting chairs. Stand/sit progress pushes them by up to 0.22 m; the cycle found no seated chair left out or walking member with a tucked home chair.
- The walk_folder clip holds the folder at the hand, followed by a receiver beat. The cycle contains 251 carried-folder walk frames.
- Two desks in the third group turn into a perpendicular nook, its rug is removed, and its remaining two desks have varied spacing. Seat coordinates, navigation footprints, and behaviour fixtures moved with the room. There are still 12 member seats plus the producer.
- Alternating half-stride contact markers pin the planted foot. Root correction changes at a bounded rate across starts, stops, and turns. Non-visit turns use 3 rad/s; visit-facing turns retain 6 rad/s.

## Visual evidence

- [1440 busy](busy-1440.png), [idle](idle-1440.png), [waiting with chip](status-hand_raise-waiting-1440.png), [error with chip](status-head_in_hands-1440.png), and event stills: [assignment](stills/assignment.jpg), [review](stills/review.jpg), [celebration](stills/celebrate.jpg), [report](stills/report.jpg), [waiting](stills/awaiting.jpg), [error](stills/error.jpg), [emergency](stills/emergency.jpg), [release](stills/release.jpg).
- Re-taken 2x desk clips: [architect](desk-architect-2x.png), [developer](desk-developer-2x.png), [docs](desk-docs-2x.png), [planner](desk-planner-2x.png), [producer](desk-producer-2x.png), [QA](desk-qa-2x.png), and [UI designer](desk-ui_designer-2x.png). The [QA alternate view](desk-qa-side-2x.png) is retained.
- Re-taken 2x status clips: [hand raise](status-hand_raise-2x.png), [settled waiting](status-hand_raise-waiting-2x.png), [head in hands](status-head_in_hands-2x.png), [lean back](status-sit_lean_back-2x.png), [think](status-sit_think-2x.png), and [celebrate](status-sit_celebrate-2x.png).
- Re-taken 2x rest clips: [coffee](rest-coffee-2x.png), [sofa talk](rest-sofa_talk-2x.png), [window gaze](rest-window_gaze-2x.png), and [meeting](rest-meeting-2x.png). These close-ups and the 1440 status stills were inspected at native resolution.
- [Full 88 s, 25 fps video](cycle-88s-25fps.webm) and one-second contact sheets [0–23](contact-00-23.png), [24–47](contact-24-47.png), [48–71](contact-48-71.png), [72–87](contact-72-87.png). The [frame scan](frame-review.json) decoded all 2,200 frames. Its only scene-wide changes were the intentional emergency overlay at 53 s and release at 57 s; every other frame-pair averaged at most 1.764/255 grayscale difference over the room crop.

## Measurements and probes

| Measure | Result |
| --- | ---: |
| 12 walkers at 1440×900, production preview, two 10 s runs | 60 fps in both; main-thread busy 0.131 and 0.128 |
| 3D assets in the Electron output | 15 GLBs, 11,529,308 bytes (11.53 MB) |
| Minimum actor separation in the 88 s cycle, path and rendered roots | 0.480 m each |
| Maximum visual root travel per 40 ms | 0.096 m |
| Full-cycle foot slide per contact step, before → after | 0.0965 → 0.0412 m, 595 steps |
| 12-walker short-reversal stress slide per step, before → after | 0.464 → 0.147 m, 181 steps |

[Foot-slide method and values](foot-slide.json), [full-cycle probe](probe-results.json), [production performance](performance-production.json), and [repeat](performance-production-repeat.json) hold the measurements. The probe advanced all 2,200 cycle frames at each of 1100, 1440, and 1920. All widths passed with no footprint, capacity, facing, emergency-freeze, chair, label, or status-pose violation. It observed seven idle movers, three visit arrivals, all 13 blink clocks, face morphs on non-first actors, and the folder walk. [UI probe](ui-results.json) passed reduced motion, tag selection, portrait, and layout stability checks.

[Asset compatibility](compatibility.json) confirms 17 bones and 24 clips per person and 16 named chair pivots. The [mesh audit](asset-audit.json) passes all 13 characters; the room's 81 detached findings are intentional separate props, with no other errors or coplanar findings. The Blender scripts export the room and each person atomically, preserving reproducibility without transient partial GLBs.

## Tests and mutations

`npx tsc --noEmit -p tsconfig.web.json`, `npx vite build --config vite.web.config.ts`, and `npx electron-vite build` passed. Focused Studio 3D tests passed **18/18**. Five phase 2c contract tests include mutations that remove a chair pivot, remove a face morph channel, straighten the perpendicular nook, drop tag protection, and reuse one contact foot for both half strides. Each mutated case violates its contract.

The full renderer suite passed **131/131 tests across 22 files** after the concurrent fake API copy edit settled. One intermediate run had failed the copy test while that separate file was being edited; the final run and all builds are green.

## Known problems

- The artificial 0.43 m back-and-forth, 12-walker stress route still has 0.147 m of planted-foot travel per contact step after correction. Natural full-cycle travel is 0.041 m per step. The stress result is retained rather than presented as fully locked.
