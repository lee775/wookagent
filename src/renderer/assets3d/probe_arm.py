"""Print hand-to-face distances for the seated error-pose arm angles."""
import math
import bpy
from mathutils import Vector

arm=bpy.data.objects['Rig']
action=bpy.data.actions['head_in_hands']
arm.animation_data.action=action
arm.animation_data.action_slot=action.slots[0]
bpy.context.scene.frame_set(1)
for upper in (-1.3,-1.6,-1.9,-2.2,-2.5):
    for fore in (-1.1,-1.4,-1.7,-2.0):
        for side in ('L','R'):
            arm.pose.bones['upper_arm.'+side].rotation_euler.x=upper
            arm.pose.bones['forearm.'+side].rotation_euler.x=fore
        bpy.context.view_layer.update()
        p=arm.pose.bones
        h=p['hand.L'].head
        face=p['head'].head+Vector((0,-.13,.10))
        print('ARM_PROBE',upper,fore,tuple(round(v,3) for v in h),round((h-face).length,3))
action=bpy.data.actions['sit_lean_back']
arm.animation_data.action=action
arm.animation_data.action_slot=action.slots[0]
bpy.context.scene.frame_set(1)
for angle in (.95,1.2,1.5,1.8,2.0):
    arm.pose.bones['upper_arm.L'].rotation_euler.z=angle
    arm.pose.bones['upper_arm.R'].rotation_euler.z=-angle
    bpy.context.view_layer.update()
    print('CROSS_PROBE',angle,round(arm.pose.bones['hand.L'].head.x,3),
          round(arm.pose.bones['hand.R'].head.x,3))
for angle in (0,.5,1.0,1.5,2.0):
    arm.pose.bones['forearm.L'].rotation_euler.z=angle
    arm.pose.bones['forearm.R'].rotation_euler.z=-angle
    bpy.context.view_layer.update()
    print('FOREARM_CROSS',angle,round(arm.pose.bones['hand.L'].head.x,3),
          round(arm.pose.bones['hand.R'].head.x,3))
