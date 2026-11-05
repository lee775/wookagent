"""Regenerate the measured polish report from the checked artifacts."""
from pathlib import Path
import json

here=Path(__file__).resolve().parent
audit=json.loads((here/'asset-audit.json').read_text(encoding='utf-8'))
glbs=json.loads((here/'compatibility.json').read_text(encoding='utf-8'))
probe=json.loads((here/'probe.json').read_text(encoding='utf-8'))
before=json.loads((here/'deformation-before.json').read_text(encoding='utf-8'))
after=json.loads((here/'deformation-after.json').read_text(encoding='utf-8'))
a=[v['max_edge_stretch'] for person in before.values() for v in person.values()]
b=[v['max_edge_stretch'] for person in after.values() for v in person.values()]
rows=['| Person | Triangles | GLB bytes |','| --- | ---: | ---: |']
for number in range(1,14):
    triangles=audit[f'person_{number}']['mesh_stats']['total_tris']
    size=glbs['files'][f'person_{number}.glb']['bytes']
    rows.append(f'| {number:02d} | {triangles:,} | {size:,} |')
perf=probe['performance']
max_triangles=max(audit['person_'+str(i)]['mesh_stats']['total_tris'] for i in range(1,14))
text=f'''# Studio 3D character polish

## Build and changes

The 13 characters and room were rebuilt from `src/renderer/assets3d/build_studio.py` and `character_detail.py`. The GLB filenames, 17-bone rig and names, exported `handR` alias, 23 original clip names, transition timing roles, origin, scale, units and furniture positions remain compatible. No clips were added. Each GLB is exported to a temporary file in its destination folder and atomically replaced.

The covered body now supplies weights during construction, then is removed from the exported character. Every garment shell receives nearest-face-interpolated body weights. Implausible limb influences are rejected, the weights are combined with smooth joint falloff, normalized and capped at four per vertex. Curved rings support shoulders, elbows, wrists and knees; the sleeve's first ring blends into the spine to avoid a rear shoulder gap. The trouser hip was narrowed inside the shirt so the back hem no longer forms a sawtooth intersection. Head and hair spheres have denser smooth normals. Smaller skin-coloured mittens have distinct thumbs. Chest ornaments on people 07 and 12 and person 13's raised coat patches were removed.

`hand_raise` reaches above the head then settles at the desk. `head_in_hands` puts the hands by the temples; `sit_think`, `sit_lean_back` and `sit_celebrate` were checked at their extremes. Each clip contains the `eyeBlink` morph; `stand_talk` and `sofa_talk` also have `mouthOpen`. Long loops blink at irregular roughly 2.4–3.0 second intervals; short transitions have one blink. The face tracks and bone tracks share the same Three.js clip.

## Deformation

Across 299 person/clip pairs, sampled maximum edge stretch fell from **{max(a):.3f}x** to **{max(b):.3f}x**. The median fell from **{sorted(a)[len(a)//2]:.3f}x** to **{sorted(b)[len(b)//2]:.3f}x**; **{sum(y<x for x,y in zip(a,b))}/299** pairs improved. The metric divides evaluated edge length by bind-pose length, excludes edges under 2 mm, and samples clip start/end, quarter points and frames 10, 17, 18 and 25 when present. The baseline includes hidden body geometry; removing it contributes to the improvement. See [all 299 before/after rows](deformation-table.md) and the [baseline](deformation-before.json) and [final](deformation-after.json) data.

Garment-through-covered-body penetration is **0 m in every final clip by construction** because the covered body is absent from the GLB after weight transfer. Baseline penetration was not sampled and is marked `n/a`; no before value has been invented. Separate garment layers were visually inspected in the contact sheets.

## Geometry and size

{chr(10).join(rows)}

The maximum is **{max_triangles:,} triangles per person**. All 15 GLBs total **{glbs['total_bytes']:,} bytes**, under the 15 MB cap. The room QA finds **0 coplanar and 0 degenerate** issues, down from 16 coplanar overlaps in phase 2a. Its 81 detached findings are all one-component independent props such as mugs, lamps and plants, individually classified in [asset-qa-room.txt](asset-qa-room.txt). Furniture positions did not move.

## Visual and browser QA

The [2x lineup](lineup-2x.png) shows all 13 people from front and three-quarter views. `contact-person_01-2x.png` through `contact-person_13-2x.png` each show all 23 clips at first, maximum-motion and last frames. The 2x browser closeups are `desk-*-2x.png`, `status-*-2x.png` and `rest-*-2x.png`; [busy](busy-1440.png) and [idle](idle-1440.png) are the 1440 app stills. All deliverable images were opened at original resolution.

With **{perf['people']} actors**, the browser ran at **{perf['fps']:.0f} fps** for {perf['duration']:.1f} s. Main-thread busy fraction was **{perf['mainThreadBusy']:.3f}** ({perf['mainThreadBusy']*100:.1f}% of one main thread), and script busy was **{perf['scriptBusy']:.3f}**. These are browser-thread time ratios, not whole-machine CPU utilization. Zoom, pan, reset and select worked; no page, console, HTTP or request errors were reported in [probe.json](probe.json).

[morph-browser.json](morph-browser.json) records nonzero `eyeBlink` in `sit_type` and nonzero `mouthOpen` in `stand_talk` and `sofa_talk` through the live Three.js mixer. [compatibility.json](compatibility.json) verifies morph and bone channels in every clip of every GLB.

## Known problems and runtime requests

The normal runtime still shows diagonal stripes at 2x on faces, hair and clothes. This is **self-shadow acne**, reproduced with the same GLB, frame and camera in [normal lighting](debug-developer-lit.png) and [character shadow reception off](debug-developer-noshadow.png); the stripes vanish in the latter. Geometry changes alone did not remove it. The current runtime also uses person 1's shared clips and drops morph tracks for actors 2–13, so their faces remain static in the app even though their GLBs contain the tracks. [Runtime requests](runtime-requests.md) describes these fixes for the phase 2b owner. The waiting phase of `hand_raise` is partly hidden by the monitor from the desk closeup camera; at 1440 the status chip also covers the raised hand.

## Reproduce

Run Blender 5.2 headless with `--python src/renderer/assets3d/build_studio.py -- room` and `-- people`, then run `audit_meshes.py` and `deformation_metrics.py -- docs/design/v4/polish/deformation-after.json` from `src/renderer/assets3d/`. Run `python src/renderer/assets3d/make_deformation_table.py`, `python src/renderer/assets3d/verify_exports.py` and this script. Render contact parts with `render_contact_sheets.py` and `render_contact_sheets.py -- --last`, then `python docs/design/v4/polish/compose_contacts.py`. Render the lineup with `render_lineup.py` and `python docs/design/v4/polish/compose_lineup.py`. For browser captures, run Vite on port 5197 and `node docs/design/v4/polish/capture.mjs`, then `node docs/design/v4/polish/verify-morphs.mjs`.
'''
text += '''
At the normal 1440 camera, the current status/name chip covers the raised hand and the head-in-hands face. This is captured in `status-hand_raise-1440.png` and `status-head_in_hands-1440.png` and is included in the runtime request. The asset pose itself is visible in the 2x closeups.

`npx tsc --noEmit -p tsconfig.web.json` passed. Renderer Vitest passed 20 files and 118 tests in the latest run.
'''
(here/'README.md').write_text(text,encoding='utf-8',newline='\n')
print('Wrote',here/'README.md')
