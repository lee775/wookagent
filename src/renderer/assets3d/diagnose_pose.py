"""Inspect deformed face spans on one character at the coffee pose."""
import bpy
from mathutils import Vector

rig=bpy.data.objects['Rig']
action=bpy.data.actions['stand_drink']
rig.animation_data.action=action
rig.animation_data.action_slot=action.slots[0]
bpy.context.scene.frame_set(30)
obj=bpy.data.objects['BODY_ATLAS']
evaluated=obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
mesh=evaluated.to_mesh()
spans=[]
for poly in mesh.polygons:
    positions=[mesh.vertices[i].co for i in poly.vertices]
    distance=max((a-b).length for a in positions for b in positions)
    spans.append((distance,poly.index,tuple(tuple(round(c,3) for c in point) for point in positions)))
for span in sorted(spans,reverse=True)[:9]:
    poly=obj.data.polygons[span[1]]
    original=[tuple(round(c,3) for c in obj.data.vertices[i].co) for i in poly.vertices]
    groups=[[(obj.vertex_groups[g.group].name,round(g.weight,2)) for g in obj.data.vertices[i].groups]
            for i in poly.vertices]
    print('POSE_SPAN',span,'REST',original,'GROUPS',groups)
evaluated.to_mesh_clear()
