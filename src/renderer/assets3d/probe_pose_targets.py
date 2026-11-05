"""Print joint locations for authored status extremes and candidate right arm angles."""
import pathlib
import bpy
from mathutils import Vector
bpy.ops.wm.open_mainfile(filepath=str(pathlib.Path(__file__).parent/'person_1.blend'))
arm=bpy.data.objects['Rig']
for name,frame in [('sit_idle',1),('hand_raise',10),('hand_raise',25),('head_in_hands',17),('sit_think',17)]:
    arm.animation_data.action=bpy.data.actions[name]
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    print('POSE',name,frame)
    for bone in ('head','upper_arm.R','forearm.R','hand.R','upper_arm.L','forearm.L','hand.L'):
        b=arm.pose.bones[bone]
        print(bone,'head',tuple(round(x,3) for x in arm.matrix_world@b.head),'tail',tuple(round(x,3) for x in arm.matrix_world@b.tail))
    if name=='hand_raise' and frame==10:
        upper=arm.pose.bones['upper_arm.R'];hand=arm.pose.bones['hand.R']
        for angle in (-.8,-.4,0,.4,.8):
            upper.rotation_euler.z=angle;bpy.context.view_layer.update()
            print('RAISE Z',angle,tuple(round(x,3) for x in hand.tail))
