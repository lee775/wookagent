"""Render the first and maximum-motion keyframe of every clip for every worker."""
import pathlib
import sys
import bpy
from mathutils import Vector

here=pathlib.Path(__file__).resolve().parent
out=here.parents[2]/'docs'/'design'/'v4'/'polish'/'contact_parts'
out.mkdir(parents=True,exist_ok=True)
last_only='--last' in sys.argv

for index in range(1,14):
    bpy.ops.wm.open_mainfile(filepath=str(here/f'person_{index}.blend'))
    scene=bpy.context.scene
    rig=bpy.data.objects['Rig']
    keys=bpy.data.objects['BODY_ATLAS'].data.shape_keys
    scene.render.engine='CYCLES';scene.cycles.samples=4
    scene.render.resolution_x=320;scene.render.resolution_y=420
    scene.render.resolution_percentage=100
    scene.render.film_transparent=True
    scene.render.image_settings.file_format='PNG'
    world=bpy.data.worlds.new('Contact world');scene.world=world;world.use_nodes=True
    world.node_tree.nodes.get('Background').inputs['Color'].default_value=(.65,.72,.72,1)
    world.node_tree.nodes.get('Background').inputs['Strength'].default_value=.8
    light_data=bpy.data.lights.new('Contact softbox','AREA')
    light=bpy.data.objects.new('Contact softbox',light_data);scene.collection.objects.link(light)
    light.location=(-2,-3,5);light_data.energy=480;light_data.shape='DISK';light_data.size=4
    camera_data=bpy.data.cameras.new('Contact camera')
    camera=bpy.data.objects.new('Contact camera',camera_data)
    scene.collection.objects.link(camera);scene.camera=camera
    camera_data.type='ORTHO'
    for action in sorted(bpy.data.actions,key=lambda item:item.name):
        start,end=(round(x) for x in action.frame_range)
        rig.animation_data.action=action
        keys.animation_data.action=action
        def motion(frame):
            scene.frame_set(frame)
            return sum(sum(abs(x) for x in bone.rotation_euler) for bone in rig.pose.bones)
        candidates=sorted({start,end,*range(start,end+1,3)})
        extreme=max(candidates,key=motion)
        if extreme==start and len(candidates)>1:
            extreme=max(candidates[1:],key=motion)
        seated=action.name.startswith(('sit_','sofa_')) or action.name in ('head_in_hands','hand_raise')
        camera_data.ortho_scale=1.62 if seated else 2.15
        camera.location=(1.5,-3.4,1.15 if seated else 1.58)
        target=Vector((0,0,.80 if seated else .88))
        camera.rotation_euler=(target-camera.location).to_track_quat('-Z','Y').to_euler()
        targets=(('last',end),) if last_only else (('first',start),('extreme',extreme))
        for label,frame in targets:
            scene.frame_set(frame)
            scene.render.filepath=str(out/f'person_{index:02d}_{action.name}_{label}_{frame:03d}.png')
            bpy.ops.render.render(write_still=True)
        print('CONTACT',index,action.name,start,extreme,flush=True)
