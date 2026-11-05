import bpy,pathlib
bpy.ops.wm.open_mainfile(filepath=str(pathlib.Path(__file__).parent/'person_1.blend'))
o=bpy.data.objects['BODY_ATLAS'];rig=bpy.data.objects['Rig']
for x,z in ((.230597,1.286288),(.249938,1.294999)):
    v=min(o.data.vertices,key=lambda v:abs(v.co.x-x)+abs(v.co.z-z)+abs(v.co.y+.025))
    print('VERT',v.index,tuple(v.co),[(o.vertex_groups[g.group].name,round(g.weight,3)) for g in v.groups])
rig.animation_data.action=bpy.data.actions['hand_raise'];bpy.context.scene.frame_set(10)
deps=bpy.context.evaluated_depsgraph_get();m=o.evaluated_get(deps).to_mesh()
for x,z in ((.230597,1.286288),(.249938,1.294999)):
    v=min(o.data.vertices,key=lambda v:abs(v.co.x-x)+abs(v.co.z-z)+abs(v.co.y+.025))
    print('POSE',v.index,tuple(m.vertices[v.index].co))
