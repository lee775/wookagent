"""Numeric posture probe for the shared rig; run on person_1.blend."""
import bpy
arm=bpy.data.objects['Rig']
for name,length in [('sit_type',33),('sit_draw',33),('sit_check',33),('sit_write',33),
                    ('sit_plan',33),('sit_think',33),('sit_lean_back',33),
                    ('head_in_hands',33),('hand_raise',33),('sit_celebrate',33),
                    ('stand_up',37),('walk',25),('sit_down',37),('stand_idle',33),
                    ('stand_talk',33),('window_gaze',33),('stand_drink',61),
                    ('hold_folder',33),('hand_over',33),('receive',33),
                    ('sofa_sit',33),('sofa_talk',33)]:
    action=bpy.data.actions[name]
    arm.animation_data.action=action
    arm.animation_data.action_slot=action.slots[0]
    rows=[]
    for frame in range(1,length+1):
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()
        p=arm.pose.bones
        rows.append((frame,p['hips'].head.z,p['foot.L'].tail.z,p['foot.R'].tail.z,
                     p['hand.L'].head.y,p['hand.L'].head.z))
    print('POSE_CHECK',name,
          'hip_z',tuple(round(v,3) for v in (min(x[1] for x in rows),max(x[1] for x in rows))),
          'feet_z',tuple(round(v,3) for v in (min(min(x[2],x[3]) for x in rows),max(max(x[2],x[3]) for x in rows))),
          'hand_start',tuple(round(v,3) for v in rows[0][4:]),
          'hand_end',tuple(round(v,3) for v in rows[-1][4:]))
