"""Continuous skinned workers with garment shells; called by build_studio.py."""
import math
import os
import time
import pathlib

import bpy
from mathutils import Vector
import build_studio as studio

HEIGHT = [.96,1.10,1.04,.91,1.12,.94,1.07,.88,1.05,.93,1.08,.90,1.02]
FACE_WIDTH = [1,1.07,.91,1.05,.90,1.12,.89,1.01,.95,1.10,.97,.88,1.05]
FACE_HEIGHT = [1,.96,1.05,.94,1.06,.93,1.09,.99,1.04,.95,1.07,1.02,.98]
SHOULDER = [.94,1.17,.91,1.04,.88,1.18,.95,1.05,.87,1.15,1.02,.92,1.13]
HIP = [1.03,1.12,.88,.96,.94,1.13,.91,1.06,.89,1.10,.97,.92,1.08]
STYLE = ['cardigan','hoodie','shirt','vest','blazer','fleece','rolled','cardigan',
         'vest','hoodie','shirt','rolled','producer']
BODY_SOURCE = None

def mesh(name, vertices, faces, material):
    data=bpy.data.meshes.new(name)
    data.from_pydata(vertices,[],faces);data.update()
    obj=bpy.data.objects.new(name,data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    for polygon in data.polygons:polygon.use_smooth=True
    return obj


def cloth_lapel(name,points,material):
    front=[tuple(point) for point in points]
    back=[(x,y+.065,z) for x,y,z in front]
    faces=[(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)]
    if points[1][0]>0:faces=[tuple(reversed(face)) for face in faces]
    return mesh(name,front+back,faces,material)

def soft_bind(obj,arm,weight):
    groups={name:obj.vertex_groups.new(name=name) for name in arm.data.bones.keys()}
    for v in obj.data.vertices:
        for name,value in weight(v.co).items():
            if value>.0001:groups[name].add([v.index],value,'REPLACE')
    modifier=obj.modifiers.new('deform','ARMATURE');modifier.object=arm
    return obj


def garment_bind(obj,arm,expected_weight):
    """Project the connected body's weights onto each cloth shell before skinning."""
    if BODY_SOURCE is None:raise RuntimeError('body must be built before garment shells')
    for group in BODY_SOURCE.vertex_groups:
        obj.vertex_groups.new(name=group.name)
    transfer=obj.modifiers.new('body nearest-face weights','DATA_TRANSFER')
    transfer.object=BODY_SOURCE
    transfer.use_vert_data=True
    transfer.data_types_verts={'VGROUP_WEIGHTS'}
    transfer.vert_mapping='POLYINTERP_NEAREST'
    transfer.layers_vgroup_select_src='ALL'
    transfer.layers_vgroup_select_dst='NAME'
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True);bpy.context.view_layer.objects.active=obj
    bpy.ops.object.modifier_apply(modifier=transfer.name)
    # The nearest body face can be a thigh when a sleeve rests beside the hip.
    # Reject anatomically impossible influences and retain a small transferred
    # contribution to the analytic joint falloff for a continuous cloth bend.
    for vertex in obj.data.vertices:
        expected=expected_weight(vertex.co)
        transferred={obj.vertex_groups[g.group].name:g.weight for g in vertex.groups
                     if obj.vertex_groups[g.group].name in expected}
        total=sum(transferred.values())
        result={name:.80*value+.20*(transferred.get(name,0)/total if total else value)
                for name,value in expected.items()}
        for group in obj.vertex_groups:group.remove([vertex.index])
        for name,value in result.items():
            if value>.0001:obj.vertex_groups[name].add([vertex.index],value,'REPLACE')
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    modifier=obj.modifiers.new('deform','ARMATURE');modifier.object=arm
    return obj

def mix(a,b,t):
    t=max(0,min(1,t));return {a:1-t,b:t}

def smoothstep(a,b,value):
    t=max(0,min(1,(value-a)/(b-a)))
    return t*t*(3-2*t)

def blend_weights(first,second,t):
    result={}
    for name,value in first.items():result[name]=result.get(name,0)+value*(1-t)
    for name,value in second.items():result[name]=result.get(name,0)+value*t
    return {name:value for name,value in result.items() if value>.0001}

def body_weights(co):
    x,z=co.x,co.z
    if z>1.43 and abs(x)<.2:return {'neck':1}
    torso=blend_weights(leg_weights(co),{'spine':1},smoothstep(.94,1.07,z))
    lower=.25-.03*smoothstep(.72,.90,z)-.07*smoothstep(.95,1.20,z)
    upper=.34-.04*smoothstep(.72,.90,z)-.06*smoothstep(.95,1.20,z)
    return blend_weights(torso,arm_weights(co),smoothstep(lower,upper,abs(x)))


def arm_weights(co):
    x,z=co.x,co.z
    side='L' if x<0 else 'R'
    if z>1.17:
        upper=max(smoothstep(.23,.34,abs(x)),1-smoothstep(1.27,1.43,z))
        return mix('spine','upper_arm.'+side,upper)
    if z>1.02:return mix('upper_arm.'+side,'forearm.'+side,1-smoothstep(1.02,1.17,z))
    return mix('forearm.'+side,'hand.'+side,1-smoothstep(.78,.90,z))


def sleeve_weights(co):
    side='L' if co.x<0 else 'R'
    if co.z>1.30:
        return mix('upper_arm.'+side,'spine',.70*smoothstep(1.30,1.42,co.z))
    if co.z>1.17:return {'upper_arm.'+side:1}
    if co.z>1.04:
        return mix('upper_arm.'+side,'forearm.'+side,1-smoothstep(1.04,1.17,co.z))
    return mix('forearm.'+side,'hand.'+side,1-smoothstep(.78,.87,co.z))


def leg_weights(co):
    x,z=co.x,co.z
    side='L' if x<0 else 'R'
    if z>.81:return mix('hips','thigh.'+side,(.99-z)/.18)
    if z>.43:return mix('thigh.'+side,'shin.'+side,(.57-z)/.14)
    return mix('shin.'+side,'foot.'+side,(.17-z)/.10)

def skinned_body(arm,M,shoulder,hip,style):
    global BODY_SOURCE
    # Skin turns this connected edge graph into a single closed body surface.
    points=[(0,0,.96),(0,0,1.12),(0,0,1.32),(0,0,1.45),(0,0,1.54)]
    radii=[(.195*hip,.145),(.215*hip,.145),(.235*shoulder,.145),(.084,.081),(.057,.057)]
    edges=[(0,1),(1,2),(2,3),(3,4)]
    for sign in (-1,1):
        first=len(points)
        points += [(sign*.245*shoulder,0,1.37),(sign*.34*shoulder,0,1.10),
                   (sign*.40*shoulder,-.08,.86),(sign*.41*shoulder,-.12,.78),
                   (sign*.43*shoulder,-.15,.73),
                   (sign*.13*hip,0,.90),(sign*.14*hip,-.025,.72),
                   (sign*.14*hip,-.045,.50),(sign*.14*hip,-.02,.30),
                   (sign*.14*hip,-.01,.12),(sign*.14*hip,-.15,.085)]
        radii += [(.092,.09),(.078,.079),(.059,.062),(.064,.055),(.024,.031),
                  (.112,.108),(.103,.101),(.087,.087),(.082,.082),(.061,.06),(.075,.075)]
        edges += [(2,first),(first,first+1),(first+1,first+2),(first+2,first+3),(first+3,first+4),
                  (0,first+5),(first+5,first+6),(first+6,first+7),(first+7,first+8),
                  (first+8,first+9),(first+9,first+10)]
    obj=mesh('continuous body',points,[],M['skin'])
    obj.data.from_pydata([],edges,[]);obj.data.update()
    skin=obj.modifiers.new('organic body','SKIN')
    bpy.context.view_layer.update()
    for i,datum in enumerate(obj.data.skin_vertices[0].data):
        datum.radius=(radii[i][0]*.38,radii[i][1]*.38)
    obj.data.skin_vertices[0].data[0].use_root=True
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
    bpy.ops.object.modifier_apply(modifier=skin.name)
    subdiv=obj.modifiers.new('soft joints','SUBSURF');subdiv.levels=1
    bpy.ops.object.modifier_apply(modifier=subdiv.name)
    for polygon in obj.data.polygons:polygon.use_smooth=True
    palette=obj.data.color_attributes.new(name='Palette',type='BYTE_COLOR',domain='CORNER')
    for polygon in obj.data.polygons:
        for loop_id in polygon.loop_indices:
            co=obj.data.vertices[obj.data.loops[loop_id].vertex_index].co
            if co.z>1.43 and abs(co.x)<.22:color=M['skin'].diffuse_color
            elif co.z<.99:color=M['pants'].diffuse_color
            elif abs(co.x)>.31 and co.z<.87:color=M['skin'].diffuse_color
            elif abs(co.x)>.22:color=M['top'].diffuse_color
            else:color=M['inner' if style in ('cardigan','vest','blazer','producer') else 'top'].diffuse_color
            palette.data[loop_id].color=color
    soft_bind(obj,arm,body_weights)
    BODY_SOURCE=obj
    return obj

def catmull(a,b,c,d,t):
    return .5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t)

def ring_tube(name,points,radii,mat,arm,weight,segments=16,closed=True):
    # Curved, closely spaced rings support shoulders, elbows, wrists and knees.
    sampled_points=[points[0]];sampled_radii=[radii[0]]
    for i in range(len(points)-1):
        steps=4 if (Vector(points[i+1])-Vector(points[i])).length>.13 else 3
        a=Vector(points[max(i-1,0)]);b=Vector(points[i])
        c=Vector(points[i+1]);d=Vector(points[min(i+2,len(points)-1)])
        for step in range(1,steps+1):
            t=step/steps
            sampled_points.append(tuple(catmull(a,b,c,d,t)))
            sampled_radii.append(catmull(radii[max(i-1,0)],radii[i],
                                        radii[i+1],radii[min(i+2,len(radii)-1)],t))
    points,radii=sampled_points,sampled_radii
    verts=[];faces=[]
    for i,point in enumerate(points):
        p=Vector(point)
        direction=Vector(points[min(i+1,len(points)-1)])-Vector(points[max(i-1,0)])
        direction.normalize()
        u=Vector((0,1,0))
        if abs(direction.dot(u))>.9:u=Vector((1,0,0))
        u=(u-direction*u.dot(direction)).normalized();v=direction.cross(u).normalized()
        for j in range(segments):
            angle=j*2*math.pi/segments
            q=p+radii[i]*(u*math.cos(angle)+v*math.sin(angle))
            verts.append(tuple(q))
    for i in range(len(points)-1):
        for j in range(segments):
            a=i*segments+j;b=i*segments+(j+1)%segments
            faces.append((a,b,b+segments,a+segments))
    if closed:
        verts += [tuple(points[0]),tuple(points[-1])]
        for j in range(segments):
            faces.append((len(verts)-2,(j+1)%segments,j))
            k=(len(points)-1)*segments
            faces.append((len(verts)-1,k+j,k+(j+1)%segments))
    return garment_bind(mesh(name,verts,faces,mat),arm,weight)

def torso_shell(name,mat,arm,shoulder,hip,front_gap=0,hem=.98,top=1.43,offset=0):
    levels=[(hem,.212*hip,.155),(1.12,.22*hip,.153),(1.29,.245*shoulder,.166),
            (1.38,.22*shoulder,.148),(top,.125 if front_gap==0 else .095,
                                      .115 if front_gap==0 else .09)]
    curved=[levels[0]]
    for i in range(len(levels)-1):
        a,b,c,d=(levels[max(i-1,0)],levels[i],levels[i+1],levels[min(i+2,len(levels)-1)])
        for step in range(1,5):
            t=step/4
            curved.append(tuple(catmull(a[k],b[k],c[k],d[k],t) for k in range(3)))
    levels=curved
    verts=[];faces=[];segments=28
    for z,rx,ry in levels:
        for j in range(segments+1):
            theta=front_gap+(2*math.pi-2*front_gap)*j/segments
            verts.append(((rx+offset)*math.sin(theta),-.013-(ry+offset)*math.cos(theta),z))
    for i in range(len(levels)-1):
        for j in range(segments):
            a=i*(segments+1)+j
            faces.append((a,a+1,a+segments+2,a+segments+1))
    if front_gap==0:
        # A cloth shoulder disk meets the neck cylinder and closes the dark
        # opening that appeared when the covered weight-transfer body was removed.
        centre=len(verts);verts.append((0,-.013,top))
        ring=(len(levels)-1)*(segments+1)
        for j in range(segments):faces.append((centre,ring+j,ring+j+1))
    return garment_bind(mesh(name,verts,faces,mat),arm,
                        lambda co:blend_weights({'hips':1},{'spine':1},smoothstep(.92,1.08,co.z)))

def attach(o,arm,bone):return studio.bind(o,arm,bone)

def ribbed_hem(arm,material,hip):
    # Follow the shirt's elliptical section with a vertical cloth ribbon.
    # A capped circular cylinder here made a broad horizontal shelf at the hip.
    rings=[(.979,.212*hip+.003,.158),(1.004,.214*hip+.003,.158),
           (1.029,.216*hip+.003,.157)]
    vertices=[];faces=[];segments=28
    for z,rx,ry in rings:
        for j in range(segments):
            angle=2*math.pi*j/segments
            vertices.append((rx*math.sin(angle),-.013-ry*math.cos(angle),z))
    for row in range(len(rings)-1):
        for j in range(segments):
            a=row*segments+j;b=row*segments+(j+1)%segments
            faces.append((a,b,b+segments,a+segments))
    return garment_bind(mesh('fitted ribbed hem',vertices,faces,material),arm,
        lambda co:blend_weights({'hips':1},{'spine':1},smoothstep(.92,1.08,co.z)))

def head_details(index,arm,M,shoulder,kit=False):
    # Eyes, pupil, brows and mouth are separate palette islands on one rigid head bone.
    fw=FACE_WIDTH[index]
    fh=FACE_HEIGHT[index]
    def part(obj):return attach(obj,arm,'head')
    part(studio.orb('head',(0,-.005,1.65),(.135*fw,.124,.181*fh),M['skin'],32))
    part(studio.orb('nose',(0,-.128,1.63),(.023,.03,.033),M['skin'],12))
    for sign in (-1,1):
        part(studio.orb('ear',(sign*.133*fw,0,1.64),(.024,.027,.039),M['skin']))
        x=sign*(.055+(index%3)*.002)
        part(studio.orb('sclera',(x,-.123,1.683),(.021,.011,.015),M['white'],12))
        part(studio.orb('pupil',(x,-.135,1.681),(.010,.007,.011),M['eye'],12))
        brow=studio.cube('eyebrow',(x,-.110,1.718),(.05,.009,.009),M['hair'],.002)
        brow.rotation_euler.y=sign*((index%4)-1.5)*.07;part(brow)
    part(studio.cube('mouth',(0,-.113,1.575),(.045,.006,.006),M['hair'],.002))
    if kit:return
    part(studio.orb('hair crown',(0,.018,1.77),(.145*fw,.133,.084),M['hair'],32))
    style=index%7
    if style==0:  # bob
        for sign in (-1,1):part(studio.orb('bob wing',(sign*.12,.01,1.625),(.041,.091,.14),M['hair']))
        part(studio.orb('long fringe',(-.04,-.095,1.75),(.102,.045,.05),M['hair']))
    elif style==1:  # curls
        for j in range(14 if index==8 else 15):
            angle=j*2.4
            part(studio.orb('curl',(math.cos(angle)*.113,math.sin(angle)*.09,1.80+(j%4)*.024),
                            (.042,.046,.043),M['hair'],8))
    elif style==2:  # ponytail
        part(studio.orb('pony base',(0,.13,1.69),(.065,.065,.075),M['hair']))
        part(studio.orb('pony length',(0,.17,1.54),(.052,.067,.16),M['hair']))
        part(studio.orb('swept bang',(.06,-.09,1.75),(.095,.05,.054),M['hair'],24))
    elif style==3:  # side part
        part(studio.orb('side sweep',(-.05,-.05,1.78),(.11,.095,.08),M['hair']))
        part(studio.orb('raised front',(.07,-.08,1.81),(.078,.05,.08),M['hair']))
    elif style==4:  # long straight
        for sign in (-1,1):part(studio.orb('long hair',(sign*.115,.05,1.59),(.055,.08,.22),M['hair']))
        part(studio.orb('side fringe',(-.07,-.09,1.75),(.075,.048,.052),M['hair']))
    elif style==5:  # bun
        part(studio.orb('bun',(0,.13,1.81),(.092,.072,.085),M['hair']))
        part(studio.orb('low fringe',(0,-.10,1.745),(.125,.04,.035),M['hair']))
    else:  # close cropped crown, without a second coplanar cap
        pass
    if index in (3,6,11,12):
        for sign in (-1,1):
            x=sign*.056
            for a,b in [((x-.032,-.145,1.711),(x+.032,-.145,1.711)),
                        ((x-.032,-.145,1.657),(x+.032,-.145,1.657)),
                        ((x-.032,-.145,1.657),(x-.032,-.145,1.711)),
                        ((x+.032,-.145,1.657),(x+.032,-.145,1.711))]:
                part(studio.beam('glasses',a,b,.003,M['metal'],6))
        part(studio.beam('bridge',(-.024,-.148,1.69),(.024,-.148,1.69),.003,M['metal'],6))
    if index in (1,5,9,12):part(studio.orb('beard',(0,-.105,1.546),(.086,.046,.043),M['hair']))
    if index==12:part(studio.orb('silver streak',(-.055,-.102,1.79),(.028,.028,.052),M['white']))

def garment(index,arm,M,shoulder,hip):
    style=STYLE[index]
    attach(studio.orb('tailored trouser hip',(0,0,.96),(.190*hip,.135,.145),M['pants'],16),arm,'hips')
    waist=studio.cyl('trouser waistband',(0,0,1.005),.195,.09,M['pants'],24)
    waist.scale=(hip,.72,1)
    attach(waist,arm,'hips')
    torso_shell('shirt body',M['inner'] if style in ('cardigan','vest','blazer','producer') else M['top'],arm,shoulder,hip)
    for side,sign in (('L',-1),('R',1)):
        x=sign*shoulder
        points=[(x*.16,0,1.375),(x*.255,0,1.34),(x*.31,0,1.24),(x*.35,0,1.10),
                (x*.38,-.045,.98),(x*.40,-.09,.86)]
        sleeve_mat=M['inner'] if style=='vest' else M['top']
        if style in ('cardigan','blazer','producer'):sleeve_mat=M['top'] if style!='blazer' else M['accent']
        if style=='rolled':points=points[:4]
        radii=[.090*shoulder,.078*shoulder,.075*shoulder,.070*shoulder,
               .068*shoulder,.060*shoulder][:len(points)]
        ring_tube('continuous sleeve '+side,points,radii,sleeve_mat,arm,sleeve_weights)
        if style=='rolled':
            attach(studio.cyl('rolled cuff',(x*.35,0,1.07),.088*shoulder,.055,M['accent'],12,
                              rotation=(0,math.pi*.12*sign,0)),arm,'forearm.'+side)
            ring_tube('bare forearm '+side,[(x*.35,0,1.09),(x*.38,-.045,.98),(x*.40,-.09,.86)],
                      [.069,.065,.051],M['skin'],arm,arm_weights)
        else:
            attach(studio.cyl('knit cuff',(x*.40,-.09,.87),.067*shoulder,.035,sleeve_mat,12,
                              rotation=(math.pi*.12,sign*math.pi*.08,0)),arm,'forearm.'+side)
        ring_tube('soft wrist '+side,[(x*.40,-.09,.87),(x*.41,-.12,.80)],
                  [.027,.027],M['skin'],arm,arm_weights)
        # A thumb emerging from the continuous mitten palm.
        attach(studio.orb('mitten palm',(x*.41,-.12,.78),(.032,.040,.054),M['skin'],16),arm,'hand.'+side)
        attach(studio.orb('mitten thumb',(x*.441,-.151,.795),(.015,.021,.029),M['skin'],12),arm,'hand.'+side)
        for finger in range(4):
            attach(studio.orb('finger tip',(x*.41+(finger-1.5)*.014,-.151,.742+(finger%2)*.003),
                             (.009,.017,.025),M['skin'],8),arm,'hand.'+side)
        leg=[(sign*.13*hip,0,.93),(sign*.135*hip,-.015,.77),(sign*.14*hip,-.04,.57),
             (sign*.14*hip,-.045,.49),(sign*.14*hip,-.02,.31),(sign*.14*hip,-.01,.13)]
        radii=[.125*hip,.117*hip,.104*hip,.095*hip,.091*hip,.076*hip]
        ring_tube('continuous trousers '+side,leg,radii,M['pants'],arm,leg_weights)
        attach(studio.orb('shaped shoe',(sign*.14*hip,-.115,.09),(.101*hip,.175,.070),M['shoe'],14),arm,'foot.'+side)
    if style in ('cardigan','blazer','producer'):
        outer=M['accent'] if style=='blazer' else M['top']
        torso_shell('open outer layer',outer,arm,shoulder,hip,front_gap=.43,
                    hem=.75 if style=='producer' else 1.055,top=1.435,offset=.024)
        for sign in (-1,1):
            attach(studio.beam('open front seam',(sign*.102,-.165,1.41),
                               (sign*.096,-.172,1.07 if style!='producer' else .76),.012,
                               M['accent'] if style=='cardigan' else M['top']),arm,'spine')
            if style in ('blazer','producer'):
                attach(cloth_lapel('tailored lapel',[(sign*.06,-.19,1.44),
                       (sign*.16,-.19,1.40),(sign*.11,-.19,1.32)],M['inner']),arm,'spine')
        # The coat's former raised pocket patches read as stickers at 2x.
    elif style=='hoodie':
        attach(studio.orb('hood volume',(0,.10,1.43),(.235*shoulder,.16,.185),M['top'],16),arm,'spine')
        # The hood and twin drawstrings carry the silhouette. A raised pouch read as a bib at office scale.
        for sign in (-1,1):
            attach(studio.beam('hood cord',(sign*.078,-.147,1.43),(sign*.078,-.157,1.22),.005,
                               M['accent'],6),arm,'spine')
    elif style=='vest':
        torso_shell('knit vest',M['top'],arm,shoulder*.97,hip*.99,front_gap=.05,hem=1.07,top=1.35,offset=.013)
        for sign in (-1,1):
            attach(studio.beam('vest V',(sign*.105,-.155,1.39),(0,-.168,1.26),.012,M['accent']),arm,'spine')
    elif style=='fleece':
        attach(studio.beam('zipper',(0,-.179,1.07),(0,-.159,1.43),.006,M['accent'],6),arm,'spine')
        attach(studio.cyl('high collar',(0,0,1.45),.10,.085,M['top']),arm,'neck')
    elif style=='shirt':
        for sign in (-1,1):
            attach(cloth_lapel('shirt collar',[(sign*.04,-.18,1.47),
                   (sign*.15,-.18,1.42),(sign*.08,-.18,1.37)],M['top']),arm,'spine')
        attach(studio.beam('button placket',(0,-.166,1.13),(0,-.150,1.40),.006,M['accent'],6),arm,'spine')
    elif style=='sweater':
        attach(studio.cyl('ribbed collar',(0,0,1.45),.105,.065,M['accent'],16),arm,'neck')
        ribbed_hem(arm,M['accent'],hip)
    elif style in ('rolled','tee_long'):
        pass


def remove_covered_body():
    """Discard the hidden transfer source after every shell has received its weights."""
    bpy.data.objects.remove(BODY_SOURCE,do_unlink=True)


def face_shape_keys(index):
    atlas=bpy.data.objects['BODY_ATLAS']
    tag=atlas.data.attributes['_FacePart']
    factor=HEIGHT[index]
    eye_z=.92+(1.683-.92)*factor
    mouth_z=.92+(1.575-.92)*factor
    atlas.shape_key_add(name='Basis')
    blink=atlas.shape_key_add(name='eyeBlink')
    speech=atlas.shape_key_add(name='mouthOpen')
    for i,vertex in enumerate(atlas.data.vertices):
        kind=tag.data[i].value
        if kind==1:
            blink.data[i].co.y+=.042
            blink.data[i].co.z=eye_z+(vertex.co.z-eye_z)*.16
        elif kind==2:
            speech.data[i].co.y-=.004
            speech.data[i].co.z=mouth_z+(vertex.co.z-mouth_z)*3.0
    atlas.data.attributes.remove(tag)


def build_detailed_person(index,kit=False):
    studio.reset_scene();M=studio.body_materials(0 if kit else index);arm=studio.make_armature()
    arm['kit_height']=HEIGHT[index]
    arm['kit_face_width']=FACE_WIDTH[index]
    arm['kit_face_height']=FACE_HEIGHT[index]
    shoulder=SHOULDER[index];hip=HIP[index]
    skinned_body(arm,M,shoulder,hip,STYLE[index])
    garment(index,arm,M,shoulder,hip)
    remove_covered_body()
    head_details(index,arm,M,shoulder,kit)
    attach(studio.cyl('neck join',(0,0,1.48),.068,.15,M['skin'],12),arm,'neck')
    # Different torso lengths preserve the shared seat/hip pivot.
    factor=HEIGHT[index]
    bpy.ops.object.select_all(action='DESELECT')
    for obj in bpy.context.scene.objects:
        if obj.type=='MESH':obj.select_set(True)
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    for obj in bpy.context.scene.objects:
        if obj.type=='MESH':
            for vert in obj.data.vertices:
                if vert.co.z>.92:vert.co.z=.92+(vert.co.z-.92)*factor
    bpy.ops.object.select_all(action='DESELECT');arm.select_set(True);bpy.context.view_layer.objects.active=arm
    bpy.ops.object.mode_set(mode='EDIT')
    for bone in arm.data.edit_bones:
        head=bone.head.copy();tail=bone.tail.copy()
        if head.z>.92:head.z=.92+(head.z-.92)*factor
        if tail.z>.92:tail.z=.92+(tail.z-.92)*factor
        bone.head=head;bone.tail=tail
    bpy.ops.object.mode_set(mode='OBJECT')
    studio.atlas_person(arm,index)
    face_shape_keys(index)
    studio.animate(arm)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in bpy.context.scene.objects:obj.select_set(True)
    bpy.context.preferences.filepaths.save_version=0
    destination=studio.PUBLIC/(f'kit_{STYLE[index]}.glb' if kit else f'person_{index+1}.glb')
    temporary=destination.with_name(destination.stem+'.tmp.glb')
    bpy.ops.export_scene.gltf(filepath=str(temporary),export_format='GLB',
        export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',
        export_merge_animation='NLA_TRACK',export_force_sampling=True,
        export_frame_step=3,export_materials='EXPORT',export_cameras=False,export_lights=False,export_extras=True)
    if temporary.stat().st_size<100_000:raise RuntimeError('incomplete GLB export')
    for attempt in range(100):
        try:
            os.replace(temporary,destination)
            break
        except PermissionError:
            if attempt==99:raise
            time.sleep(.1)
    # NLA strips must be live while glTF samples them, then muted in the source
    # file so direct action previews and deformation metrics isolate one clip.
    for animated in (arm.animation_data,bpy.data.objects['BODY_ATLAS'].data.shape_keys.animation_data):
        animated.action=None
        for track in animated.nla_tracks:
            for strip in track.strips:strip.mute=True
    if not kit:bpy.ops.wm.save_as_mainfile(filepath=str(studio.HERE/f'person_{index+1}.blend'))
    print('DETAILED_PERSON',index+1,STYLE[index],len(bpy.data.actions),flush=True)


def build_character_kit():
    """Nine garment rigs plus twelve one-draw-call hair modules on one 17-bone contract."""
    STYLE[6]='tee_long'
    STYLE[7]='sweater'
    for index in list(range(8))+[12]:
        build_detailed_person(index,kit=True)
    build_appearance_kit()

def build_appearance_kit():
    studio.reset_scene()
    M=studio.body_materials(0)
    hair=M['hair'];metal=M['metal'];accent=M['accent']
    def module(name,build):
        before=set(bpy.context.scene.objects)
        build()
        parts=list(set(bpy.context.scene.objects)-before)
        bpy.ops.object.select_all(action='DESELECT')
        for obj in parts:obj.select_set(True)
        bpy.context.view_layer.objects.active=parts[0]
        if len(parts)>1:bpy.ops.object.join()
        parts[0].name=name+'_mesh'
        pivot=bpy.data.objects.new(name,None)
        bpy.context.collection.objects.link(pivot)
        world=parts[0].matrix_world.copy()
        parts[0].parent=pivot;parts[0].matrix_world=world
        return pivot
    def orb(name,loc,size):studio.orb(name,loc,size,hair,16)
    def crown(height=.085,part=0):
        orb('crown',(part,.018,1.77),(.145,.133,height))
    def hair_style(style):
        crown(.075 if style in (6,8) else .085)
        if style==0:
            for s in (-1,1):orb('bob',(s*.12,.01,1.625),(.041,.091,.14))
            orb('fringe',(-.04,-.095,1.75),(.102,.045,.05))
        elif style==1:
            for j in range(16):
                a=j*2.4;orb('curl',(math.cos(a)*.113,math.sin(a)*.09,1.80+(j%4)*.024),(.043,.046,.043))
        elif style==2:
            orb('pony base',(0,.13,1.69),(.065,.065,.075))
            orb('pony length',(0,.17,1.53),(.052,.067,.16))
            orb('bang',(.06,-.09,1.75),(.095,.05,.054))
        elif style==3:
            orb('side part',(-.05,-.05,1.78),(.11,.095,.08))
            orb('quiff',(.07,-.08,1.82),(.078,.05,.08))
        elif style==4:
            for s in (-1,1):orb('long',(s*.115,.05,1.57),(.055,.08,.23))
            orb('fringe',(-.07,-.09,1.75),(.075,.048,.052))
        elif style==5:
            orb('bun',(0,.13,1.83),(.092,.072,.085))
            orb('low fringe',(0,-.10,1.745),(.125,.04,.035))
        elif style==6:
            for s in (-1,1):orb('short',(s*.10,-.01,1.78),(.048,.08,.045))
        elif style==7:
            for s in (-1,1):
                for j in range(3):orb('waves',(s*.13,.04,1.72-j*.09),(.052,.08,.064))
            orb('side fringe',(.06,-.10,1.76),(.09,.04,.052))
        elif style==8:
            orb('slicked',(0,.055,1.79),(.14,.115,.055))
            orb('comb line',(-.075,-.075,1.77),(.05,.06,.045))
        elif style==9:
            for s in (-1,1):orb('pixie',(s*.10,-.04,1.78),(.06,.07,.055))
            orb('pixie fringe',(-.04,-.10,1.76),(.08,.035,.04))
        elif style==10:
            orb('top knot',(0,.07,1.88),(.075,.07,.075))
            for s in (-1,1):orb('temple',(s*.12,0,1.69),(.035,.07,.10))
        else:
            orb('braid root',(.10,.07,1.76),(.08,.10,.06))
            for j in range(5):orb('braid',(.135,.12+j*.012,1.68-j*.085),(.047,.052,.055))
    for i in range(12):module(f'hair_{i}',lambda i=i:hair_style(i))
    def glasses():
        for s in (-1,1):
            x=s*.056
            for a,b in [((x-.032,-.145,1.711),(x+.032,-.145,1.711)),
                        ((x-.032,-.145,1.657),(x+.032,-.145,1.657)),
                        ((x-.032,-.145,1.657),(x-.032,-.145,1.711)),
                        ((x+.032,-.145,1.657),(x+.032,-.145,1.711))]:
                studio.beam('frame',a,b,.003,metal,6)
        studio.beam('bridge',(-.024,-.148,1.69),(.024,-.148,1.69),.003,metal,6)
    module('glasses',glasses)
    module('beard',lambda:studio.orb('beard',(0,-.105,1.546),(.086,.046,.043),hair,16))
    def headphones(style=None):
        radius=.177 if style in (0,4,7,11) else .157
        for s in (-1,1):studio.orb('earcup',(s*radius,.005,1.66),(.035,.055,.064),accent,12)
        # Tall curls, asymmetric quiffs and knots use cup-only headphones.
        # The other bands are smooth straps nested into the crown, never a peak.
        if style is None or style in (1,3,5,10,11):return
        rise=.071 if style in (6,8) else .081
        edge_height=1.77+rise*math.sqrt(1-(.145/.148)**2)
        vertices=[];faces=[];segments=24
        for j in range(segments+1):
            angle=math.pi*j/segments
            x=-radius*math.cos(angle)
            if abs(x)<=.145:z=1.77+rise*math.sqrt(max(0,1-(x/.148)**2))
            else:z=edge_height+(1.695-edge_height)*(abs(x)-.145)/(radius-.145)
            # A rounded rectangular strap, 32 mm wide and 8 mm thick.
            nx=-math.cos(angle);nz=math.sin(angle)
            for depth,thickness in [(-.016,-.004),(.016,-.004),(.016,.004),(-.016,.004)]:
                vertices.append((x+nx*thickness,.005+depth,z+nz*thickness))
        for j in range(segments):
            for k in range(4):
                a=j*4+k;b=j*4+(k+1)%4;faces.append((a,b,b+4,a+4))
        faces.extend([(3,2,1,0),(segments*4,segments*4+1,segments*4+2,segments*4+3)])
        mesh('curved padded band',vertices,faces,accent)
    module('headphones',headphones)  # Existing runtime path remains a safe cup-only fallback.
    for style in range(12):
        fitted=module(f'headphones_{style}',lambda style=style:headphones(style))
        fitted['headphone_mode']='cups' if style in (1,3,5,10,11) else 'band'
        fitted['hair_style']=style
    def lanyard():
        for s in (-1,1):studio.beam('strap',(s*.10,-.15,1.44),(0,-.175,1.16),.006,accent,6)
        studio.cube('ID',(0,-.184,1.15),(.075,.012,.10),M['white'],.008)
    module('lanyard',lanyard)
    target=studio.PUBLIC/'appearance_kit.glb';temp=studio.PUBLIC/'appearance_kit.tmp.glb'
    bpy.ops.export_scene.gltf(filepath=str(temp),export_format='GLB',export_yup=True,
        export_materials='EXPORT',export_cameras=False,export_lights=False,export_animations=False,export_extras=True)
    if temp.stat().st_size<10000:raise RuntimeError('incomplete appearance kit')
    os.replace(temp,target)
    print('APPEARANCE_KIT',target.stat().st_size,flush=True)
