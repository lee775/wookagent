"""Render 2x front/three-quarter character tiles from the authored Blender files.

blender --background --factory-startup --python render_lineup.py
Then run docs/design/v4/phase2a/compose_lineup.py with system Python.
"""
import pathlib
import sys
import bpy
from mathutils import Vector

here=pathlib.Path(__file__).resolve().parent
out=here.parents[2]/'docs'/'design'/'v4'/'polish'/'lineup_parts'
out.mkdir(parents=True,exist_ok=True)

indices=[int(sys.argv[sys.argv.index('--')+1])] if '--' in sys.argv else range(1,14)
for index in indices:
    bpy.ops.wm.open_mainfile(filepath=str(here/f'person_{index}.blend'))
    scene=bpy.context.scene
    rig=bpy.data.objects.get('Rig')
    if rig and rig.animation_data:
        rig.animation_data.action=bpy.data.actions.get('stand_idle')
    scene.frame_set(1)
    scene.render.engine='CYCLES'
    scene.cycles.samples=16
    scene.render.resolution_x=480
    scene.render.resolution_y=640
    scene.render.resolution_percentage=100
    scene.render.film_transparent=True
    scene.render.image_settings.file_format='PNG'
    world=bpy.data.worlds.new('Portrait world')
    scene.world=world
    world.use_nodes=True
    world.node_tree.nodes.get('Background').inputs['Color'].default_value=(.65,.72,.72,1)
    world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.8
    light_data=bpy.data.lights.new('large softbox','AREA')
    light=bpy.data.objects.new('large softbox',light_data)
    scene.collection.objects.link(light)
    light.location=(-2,-3,5);light_data.energy=480;light_data.shape='DISK';light_data.size=4
    camera_data=bpy.data.cameras.new('portrait camera')
    camera=bpy.data.objects.new('portrait camera',camera_data)
    scene.collection.objects.link(camera);scene.camera=camera
    camera_data.type='ORTHO';camera_data.ortho_scale=2.15
    for view,location in [('front',(0,-4,1.55)),('quarter',(2.4,-4,1.7))]:
        camera.location=location
        direction=Vector((0,0,.87))-camera.location
        camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()
        scene.render.filepath=str(out/f'person_{index:02d}_{view}.png')
        bpy.ops.render.render(write_still=True)
        print('LINEUP',index,view,scene.render.filepath)
