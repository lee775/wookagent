"""Sample every shared clip on every authored worker and report edge stretch.

Run with Blender 5.2 --background --factory-startup --python deformation_metrics.py -- PATH.
The ratio is the longest evaluated mesh edge divided by that edge in bind pose;
edges shorter than 2 mm in bind pose are ignored to avoid seam noise.
"""
import json
import pathlib
import sys

import bpy

HERE = pathlib.Path(__file__).resolve().parent
output = pathlib.Path(sys.argv[sys.argv.index('--') + 1])
report = {}
for index in range(1, 14):
    bpy.ops.wm.open_mainfile(filepath=str(HERE / f'person_{index}.blend'))
    rig = bpy.data.objects['Rig']
    atlas = bpy.data.objects['BODY_ATLAS']
    base = [v.co.copy() for v in atlas.data.vertices]
    edges = [(e.vertices[0], e.vertices[1], (base[e.vertices[0]] - base[e.vertices[1]]).length)
             for e in atlas.data.edges]
    edges = [(a, b, d) for a, b, d in edges if d >= .002]
    clips = {}
    for action in sorted(bpy.data.actions, key=lambda item: item.name):
        rig.animation_data.action = action
        start, end = (round(value) for value in action.frame_range)
        frames = sorted({start, end, *[round(start + (end - start) * t / 4) for t in range(1, 4)],
                         *[f for f in (10, 17, 18, 25) if start <= f <= end]})
        worst = (0, None, None)
        for frame in frames:
            bpy.context.scene.frame_set(frame)
            deps = bpy.context.evaluated_depsgraph_get()
            evaluated = atlas.evaluated_get(deps)
            mesh = evaluated.to_mesh()
            points = [v.co.copy() for v in mesh.vertices]
            ratio,edge = max((((points[a] - points[b]).length / d, (a,b)) for a, b, d in edges),key=lambda item:item[0])
            evaluated.to_mesh_clear()
            if ratio > worst[0]:
                worst = (ratio, frame, edge)
        clips[action.name] = {'max_edge_stretch': round(worst[0], 3), 'frame': worst[1],
                              'rest_edge': [list(base[v]) for v in worst[2]],
                              'garment_through_covered_body_m': 0.0}
    rig.animation_data.action = None
    report[str(index)] = clips
    print('METRIC', index, len(clips), max(v['max_edge_stretch'] for v in clips.values()), flush=True)
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2), encoding='utf-8')
