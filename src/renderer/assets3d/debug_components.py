"""Render the disconnected authored mesh islands in distinct diagnostic colours."""
import pathlib
import bpy
from mathutils import Vector
bpy.ops.wm.open_mainfile(filepath=str(pathlib.Path(__file__).parent/'person_3.blend'))
atlas=bpy.data.objects['BODY_ATLAS'];rig=bpy.data.objects['Rig']
adj=[[] for _ in atlas.data.vertices]
for edge in atlas.data.edges:
    a,b=edge.vertices;adj[a].append(b);adj[b].append(a)
component=[-1]*len(adj);parts=[]
for vertex in range(len(adj)):
    if component[vertex]>=0:continue
    label=len(parts);stack=[vertex];component[vertex]=label;group=[]
    while stack:
        current=stack.pop();group.append(current)
        for other in adj[current]:
            if component[other]<0:component[other]=label;stack.append(other)
    parts.append(group)
colors=[]
for label,group in enumerate(parts):
    coords=[atlas.data.vertices[i].co for i in group]
    lo=[min(v[k] for v in coords) for k in range(3)]
    hi=[max(v[k] for v in coords) for k in range(3)]
    if len(group)>500:color=(.65,.65,.65,1)
    elif lo[0]>.1 and lo[2]>.7 and hi[2]<1.5:color=(1,.12,.1,1)
    elif hi[0]<-.1 and lo[2]>.7 and hi[2]<1.5:color=(.1,.9,.15,1)
    elif lo[2]>.9 and hi[2]<1.5:color=(.15,.3,1,1)
    else:color=(.8,.8,.2,1)
    colors.append(color)
    if color[0]==1:print('RED',label,len(group),lo,hi)
layer=atlas.data.color_attributes['Palette']
for loop in atlas.data.loops:layer.data[loop.index].color=colors[component[loop.vertex_index]]
rig.animation_data.action=bpy.data.actions['head_in_hands'];bpy.context.scene.frame_set(17)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=16
scene.render.resolution_x=720;scene.render.resolution_y=720;scene.render.resolution_percentage=100
world=bpy.data.worlds.new('Debug world');scene.world=world;world.use_nodes=True
world.node_tree.nodes.get('Background').inputs['Color'].default_value=(.65,.72,.72,1)
world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.8
light_data=bpy.data.lights.new('softbox','AREA');light=bpy.data.objects.new('softbox',light_data)
scene.collection.objects.link(light);light.location=(-2,-3,5);light_data.energy=480;light_data.size=4
camera_data=bpy.data.cameras.new('camera');camera=bpy.data.objects.new('camera',camera_data)
scene.collection.objects.link(camera);scene.camera=camera;camera_data.type='ORTHO';camera_data.ortho_scale=1.3
camera.location=(1.2,-3,1.75);camera.rotation_euler=(Vector((0,0,1.05))-camera.location).to_track_quat('-Z','Y').to_euler()
scene.render.filepath=str(pathlib.Path(__file__).parents[3]/'docs/design/v4/polish/debug-components.png')
bpy.ops.render.render(write_still=True)
