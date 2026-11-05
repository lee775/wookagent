import bpy,pathlib
bpy.ops.wm.open_mainfile(filepath='src/renderer/assets3d/person_1.blend')
a=bpy.data.objects['Rig'];a.animation_data.action=bpy.data.actions['sit_lean_back'];bpy.context.scene.frame_set(17)
for s in ('L','R'):
 for x in ('upper_arm','forearm','hand'):
  q=a.pose.bones[x+'.'+s];print(s,x,tuple(round(v,3) for v in q.head),tuple(round(v,3) for v in q.tail))
for x in (-.4,-.6,-.8,-1.0):
 for z in (-.6,-.3,0,.3):
  a.pose.bones['forearm.R'].rotation_euler.x=x
  a.pose.bones['forearm.R'].rotation_euler.z=z
  bpy.context.view_layer.update()
  q=a.pose.bones['hand.R'];print('CANDIDATE',x,z,tuple(round(v,3) for v in q.tail))
results=[]
for ux in (-.35,-.55,-.75,-.95,-1.15):
 for uz in (-.4,-.2,0,.2,.4):
  for fx in (-.3,-.6,-.9,-1.2,-1.5):
   for fz in (-.8,-.4,0,.4,.8):
    a.pose.bones['upper_arm.R'].rotation_euler.x=ux
    a.pose.bones['upper_arm.R'].rotation_euler.z=uz
    a.pose.bones['forearm.R'].rotation_euler.x=fx
    a.pose.bones['forearm.R'].rotation_euler.z=fz
    bpy.context.view_layer.update()
    h=a.pose.bones['hand.R'].head;e=a.pose.bones['forearm.R'].head
    distance=(h.x+.08)**2+(h.y+.16)**2+(h.z-.96)**2
    distance+=.2*((e.z-.78)**2+(e.y+.15)**2)
    results.append((distance,ux,uz,fx,fz,tuple(round(v,3) for v in h),tuple(round(v,3) for v in e)))
for item in sorted(results)[:12]:print('BEST',item)
