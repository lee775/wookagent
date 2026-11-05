"""Re-export saved character blends with their own bone and facial clips."""
from pathlib import Path
import os
import time
import bpy

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parent / 'public' / 'studio3d'
for index in range(1, 14):
    bpy.ops.wm.open_mainfile(filepath=str(HERE / f'person_{index}.blend'))
    for animated in (bpy.data.objects['Rig'].animation_data,
                     bpy.data.objects['BODY_ATLAS'].data.shape_keys.animation_data):
        animated.action = None
        for track in animated.nla_tracks:
            for strip in track.strips:
                strip.mute = False
    bpy.ops.object.select_all(action='DESELECT')
    for obj in bpy.context.scene.objects:
        obj.select_set(True)
    destination = PUBLIC / f'person_{index}.glb'
    temporary = destination.with_name(destination.stem + '.tmp.glb')
    bpy.ops.export_scene.gltf(filepath=str(temporary), export_format='GLB',
        export_yup=True, export_animations=True, export_animation_mode='NLA_TRACKS',
        export_merge_animation='NLA_TRACK', export_force_sampling=True,
        export_frame_step=3, export_materials='EXPORT', export_cameras=False,
        export_lights=False)
    if temporary.stat().st_size < 100_000:
        raise RuntimeError(f'incomplete GLB export: {destination.name}')
    for attempt in range(100):
        try:
            os.replace(temporary, destination)
            break
        except PermissionError:
            if attempt == 99:
                raise
            time.sleep(.1)
    print('EXPORTED_CLIPS', index, destination.stat().st_size, flush=True)
