import bpy
bpy.ops.wm.open_mainfile(filepath='src/renderer/assets3d/person_1.blend')
a=bpy.data.objects['Rig'];a.animation_data.action=bpy.data.actions['hand_raise'];bpy.context.scene.frame_set(10)
for ux in (-2.3,-2.5,-2.7,-2.9,-3.1):
 for uz in (.4,.6,.8,1.0):
  for fx in (-.6,-.3,0,.3,.6):
   a.pose.bones['upper_arm.R'].rotation_euler.x=ux
   a.pose.bones['upper_arm.R'].rotation_euler.z=uz
   a.pose.bones['forearm.R'].rotation_euler.x=fx
   bpy.context.view_layer.update()
   hand=a.pose.bones['hand.R'].tail
   if hand.z>1.6 and .2<hand.x<.6:
    print('RAISE',ux,uz,fx,tuple(round(x,3) for x in hand))
