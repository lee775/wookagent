import bpy
import pathlib
bpy.ops.wm.open_mainfile(filepath=str(pathlib.Path(__file__).parent/'person_1.blend'))
rig=bpy.data.objects['Rig'];keys=bpy.data.objects['BODY_ATLAS'].data.shape_keys
for name in ('stand_talk','sit_type'):
    action=bpy.data.actions[name]
    print('ACTION',name,'slots',[(s.identifier,s.target_id_type) for s in action.slots],
          'layers',len(action.layers))
    for slot in action.slots:
        bag=action.layers[0].strips[0].channelbag(slot)
        print('SLOT',slot.identifier,[(f.data_path,len(f.keyframe_points)) for f in bag.fcurves][:10])
print('KEYS',keys.animation_data.action,keys.animation_data.action_slot)
