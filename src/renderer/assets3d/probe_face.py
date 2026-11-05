import bpy
bpy.ops.wm.open_mainfile(filepath='src/renderer/assets3d/person_3.blend')
a=bpy.data.objects['Rig'];a.animation_data.action=bpy.data.actions['head_in_hands'];bpy.context.scene.frame_set(17)
results=[]
for ux in (-1.3,-1.5,-1.7,-1.9,-2.1):
 for uz in (0,.15,.3,.45,.6):
  for fx in (-.4,-.6,-.8,-1.0,-1.2,-1.4):
   a.pose.bones['upper_arm.R'].rotation_euler.x=ux
   a.pose.bones['upper_arm.R'].rotation_euler.z=uz
   a.pose.bones['forearm.R'].rotation_euler.x=fx
   bpy.context.view_layer.update()
   h=a.pose.bones['hand.R'].head;e=a.pose.bones['forearm.R'].head
   score=(h.x-.16)**2+(h.y+.30)**2+(h.z-1.16)**2
   score+=.5*((e.z-.78)**2+(e.y+.30)**2)
   score+=.003*max(0,-fx-1)**2
   results.append((score,ux,uz,fx,tuple(round(v,3) for v in h),tuple(round(v,3) for v in e)))
for item in sorted(results)[:20]:print('FACE',item)
