"""Deterministic Blender 5.2 source for the complete studio floor.

Usage: blender --background --factory-startup --python build_studio.py -- room|people|workstations|kit
All dimensions are metres; source faces -Y and exports as glTF +Z forward.
"""
from __future__ import annotations

import math
import os
import pathlib
import sys

sys.dont_write_bytecode = True

import bpy
import bmesh
from mathutils import Matrix, Vector

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
PUBLIC = HERE.parent / "public" / "studio3d"
PUBLIC.mkdir(parents=True, exist_ok=True)
bpy.context.preferences.filepaths.save_version = 0


def material(name, color, roughness=0.78, metallic=0.0, emission=None):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1)
        bsdf.inputs["Emission Strength"].default_value = 0.65
    return m


def mat_palette():
    return {key: material(key, color, rough, metal, emit) for key, color, rough, metal, emit in [
        ("plaster_warm", (.67,.65,.59), .98, 0, None),
        ("oak_honey", (.48,.28,.14), .74, 0, None),
        ("oak_light", (.66,.43,.23), .72, 0, None),
        ("oak_dark", (.32,.18,.10), .8, 0, None),
        ("charcoal", (.075,.085,.09), .61, .14, None),
        ("black_rubber", (.036,.042,.044), .95, 0, None),
        ("metal_satin", (.32,.35,.35), .36, .55, None),
        ("linen_blue", (.25,.37,.38), .96, 0, None),
        ("felt_sage", (.32,.43,.35), .98, 0, None),
        ("leather_cognac", (.48,.22,.105), .84, 0, None),
        ("paper_cream", (.85,.79,.65), .99, 0, None),
        ("ceramic_cream", (.79,.74,.64), .24, 0, None),
        ("screen_blue", (.095,.22,.25), .35, 0, (.10,.25,.28)),
        ("screen_warm", (.38,.24,.15), .35, 0, (.44,.27,.16)),
        ("leaf", (.16,.33,.23), .96, 0, None),
        ("leaf_light", (.27,.43,.28), .96, 0, None),
        ("terracotta", (.48,.23,.17), .91, 0, None),
        ("window_sky", (.44,.59,.64), .46, 0, (.36,.52,.60)),
        ("city", (.31,.39,.40), .97, 0, None),
        ("city_light", (.43,.48,.44), .97, 0, None),
    ]}


def finish(obj, name, mat, bevel=0):
    obj.name = name
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new("edge glints", "BEVEL")
        mod.width = min(bevel, min(obj.dimensions) / 3)
        mod.segments = 2
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        for poly in obj.data.polygons:
            poly.use_smooth = True
    return obj


def cube(name, loc, scale, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, name, mat, bevel)


def cyl(name, loc, radius, depth, mat, vertices=12, rotation=None):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    o = bpy.context.object
    if rotation:
        o.rotation_euler = rotation
    return finish(o, name, mat)


def orb(name, loc, scale, mat, segments=12):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=20 if segments>=32 else 12 if segments>=16 else 8, location=loc)
    o = bpy.context.object
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    finish(o, name, mat)
    for polygon in o.data.polygons:polygon.use_smooth=True
    return o


def beam(name, a, b, radius, mat, vertices=10):
    a, b = Vector(a), Vector(b)
    o = cyl(name, (a+b)/2, radius, (b-a).length, mat, vertices)
    o.rotation_euler = (b-a).to_track_quat('Z','Y').to_euler()
    return o


def join_by_material():
    groups = {}
    for o in list(bpy.context.scene.objects):
        if o.type == 'MESH' and o.find_armature() is None and not o.get('separate_chair'):
            key = o.data.materials[0].name if o.data.materials else 'none'
            groups.setdefault(key, []).append(o)
    for name, objects in groups.items():
        if len(objects) < 2:
            continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        objects[0].name = f"ROOM_{name}"
    bpy.ops.object.select_all(action='DESELECT')


def group_chairs(names=None):
    """Keep chair pivots addressable while merging each chair's material parts."""
    names = names or [f'chair {i}' for i in range(1, 13)] + [
        'producer chair', 'meeting south left', 'meeting south right', 'meeting north']
    for name in names:
        parts = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.name.startswith(name+' ')]
        if not parts:
            raise RuntimeError(f'Missing chair parts: {name}')
        centre = next(o.location.copy() for o in parts if o.name == name+' cushion')
        groups = {}
        for part in parts:
            groups.setdefault(part.data.materials[0].name, []).append(part)
        merged = []
        for material_name, objects in groups.items():
            bpy.ops.object.select_all(action='DESELECT')
            for obj in objects: obj.select_set(True)
            bpy.context.view_layer.objects.active = objects[0]
            if len(objects) > 1: bpy.ops.object.join()
            objects[0].name = f'{name} {material_name}'
            objects[0]['separate_chair'] = True
            merged.append(objects[0])
        pivot = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(pivot)
        pivot.location = (centre.x, centre.y, 0)
        bpy.context.view_layer.update()
        for obj in merged:
            world = obj.matrix_world.copy()
            obj.parent = pivot
            obj.matrix_world = world


def chair(x, y, facing, M, name):
    # Seat centre is .49m; the 5-star base actually contacts the floor.
    dark, metal, cloth = M['charcoal'], M['metal_satin'], M['linen_blue']
    cyl(name+' gas stem', (x,y,.34), .045,.39,metal)
    cyl(name+' hub',(x,y,.15),.115,.055,dark)
    for i in range(5):
        a = 2*math.pi*i/5
        p = (x+math.cos(a)*.30,y+math.sin(a)*.30,.105)
        beam(name+f' spoke{i}',(x,y,.14),p,.026,metal)
        orb(name+f' caster{i}',(p[0],p[1],.055),(.052,.052,.049),dark)
    cube(name+' cushion',(x,y,.49),(.52,.48,.10),cloth,.055)
    back_y = y+facing*.235
    cube(name+' back',(x,back_y,.85),(.52,.095,.64),cloth,.052)
    for side in (-1,1):
        cube(name+f' arm{side}',(x+side*.29,y-facing*.03,.71),(.065,.33,.045),dark,.02)
        cyl(name+f' arm stem{side}',(x+side*.29,y,.61),.023,.20,metal)


def desk(x, y, facing, M, number):
    oak, dark, metal = M['oak_light'],M['charcoal'],M['metal_satin']
    cube(f'D{number} top',(x,y,.73),(1.30,.69,.055),oak,.015)
    if number == 5:
        cube(f'D{number} L return',(x-.56,y-facing*.51,.728),(.48,.84,.051),oak,.015)
        for sy in (-.84,-.25):
            cube(f'D{number} return leg',(x-.77,y+facing*sy,.36),(.038,.038,.69),metal)
    if number in (4,11):
        cube(f'D{number} adjustable rail',(x,y,.63),(.74,.055,.04),metal,.012)
        cube(f'D{number} height control',(x+.47,y+facing*.29,.68),(.10,.07,.025),dark,.008)
    for sx in (-.57,.57):
        for sy in (-.26,.26):
            cube(f'D{number} leg',(x+sx,y+sy,.36),(.037,.037,.69),metal)
    # Working edge is toward the chair. Screens stand at the far edge.
    screen_y=y-facing*.18
    screens=((-.12,.53),) if number in (4,8,11,13) else ((-.19,.38),(.25,.31))
    for i,(dx,width) in enumerate(screens):
        cx=x+dx
        cube(f'D{number} monitor shell{i}',(cx,screen_y,1.08),(width,.038,.28),dark,.012)
        cube(f'D{number} screen{i}',(cx,screen_y+facing*.024,1.08),(width-.025,.007,.246),M['screen_blue' if i==0 else 'screen_warm'])
        cyl(f'D{number} stand{i}',(cx,screen_y, .87),.018,.21,metal)
        cube(f'D{number} foot{i}',(cx,screen_y,.765),(.17,.12,.015),dark,.01)
    key_y=y+facing*.17
    cube(f'D{number} keyboard',(x-.11,key_y,.768),(.40,.13,.017),dark,.008)
    for j in range(0,10,2):
        cube(f'D{number} keys{j}',(x-.28+j*.038,key_y,.78),(.025,.07,.004),M['metal_satin'])
    orb(f'D{number} mouse',(x+.30,key_y,.765),(.037,.055,.015),dark)
    if number % 4 != 2:
        mug(x+.50,y+facing*.16,.77,M, f'D{number} mug')
    # Lamp, notebook, personal objects vary without turning into a seating chart.
    beam(f'D{number} lamp post',(x-.51,y-facing*.21,.75),(x-.51,y-facing*.21,1.14),.012,metal)
    beam(f'D{number} lamp arm',(x-.51,y-facing*.21,1.14),(x-.36,y-facing*.08,1.18),.012,metal)
    cube(f'D{number} lamp shade',(x-.34,y-facing*.07,1.17),(.13,.10,.04),dark,.015)
    if number%2:
        cube(f'D{number} journal',(x+.43,y-facing*.02,.765),(.15,.19,.018),M['terracotta'],.005)
    else:
        cube(f'D{number} notes',(x+.43,y-facing*.02,.765),(.15,.19,.008),M['paper_cream'])
    if number % 3 == 0:
        cyl(f'D{number} tiny pot',(x+.49,y-facing*.13,.795),.041,.055,M['terracotta'],8)
        orb(f'D{number} succulent',(x+.49,y-facing*.13,.84),(.060,.050,.04),M['leaf'],8)
    elif number % 3 == 1:
        cyl(f'D{number} figurine',(x+.49,y-facing*.13,.79),.029,.055,M['terracotta'],8)
        orb(f'D{number} figurine head',(x+.49,y-facing*.13,.84),(.039,.036,.035),M['paper_cream'],8)
    if number % 4 == 2:
        cube(f'D{number} headphones',(x+.43,y+facing*.19,.79),(.13,.09,.035),M['charcoal'],.018)
    if number in (3,6,10,12):
        cube(f'D{number} laptop base',(x+.30,y+facing*.10,.783),(.29,.21,.018),metal,.008)
        lid=cube(f'D{number} laptop lid',(x+.30,y-facing*.005,.865),(.29,.018,.18),dark,.008)
        lid.rotation_euler.x=facing*.16
    beam(f'D{number} cable',(x-.19,screen_y, .90),(x-.19,screen_y-facing*.08,.75),.006,M['black_rubber'],6)


def mug(x,y,z,M,name):
    cyl(name,(x,y,z+.043),.045,.085,M['ceramic_cream'],16)
    orb(name+' handle',(x+.054,y,z+.045),(.024,.014,.024),M['ceramic_cream'])
    cyl(name+' coffee',(x,y,z+.079),.037,.003,M['oak_dark'],16)


def plant(x,y,scale,M,name):
    cyl(name+' planter',(x,y,.16*scale),.17*scale,.31*scale,M['terracotta'],12)
    # Planter rim and trunk are enough at office scale; a coincident soil disc z-fought.
    beam(name+' trunk',(x,y,.30*scale),(x,y,.90*scale),.023*scale,M['oak_dark'])
    for i in range(10):
        a=i*2.399
        z=(.55+(i%4)*.12+(i==9)*.035)*scale
        r=(.14+(i%3)*.045)*scale
        orb(name+f' leaf{i}',(x+math.cos(a)*r,y+math.sin(a)*r,z),(.09*scale,.18*scale,.045*scale),M['leaf' if i%3 else 'leaf_light'])


def build_room():
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    M=mat_palette()
    # Phase-one pod stays at its authored coordinates; the floor grows left and rearward.
    cube('floor slab',(-1.7,.35,-.13),(15,10,.25),M['oak_dark'])
    for i in range(25):
        yy=-4.45+i*.4
        cube(f'plank {i}',(-1.7,yy,0),(14.97,.393,.015),M['oak_honey' if i%3 else 'oak_light'])
    for x,y,w,h in [(-1.55,0,4.5,4.5),(-6.63,1.18,3.7,2.8)]:
        cube('desk rug',(x,y,.018),(w,h,.018),M['linen_blue'],.025)
        for i in range(4):
            cube('rug seam',(x-w/2+.5+i*.85,y,.030),(.006,h-.1,.003),M['felt_sage'])
    cube('back wall',(-1.7,5.27,1.50),(15,.16,3.0),M['plaster_warm'])
    cube('left return',(-9.15,3.9,1.47),(.15,2.65,2.95),M['plaster_warm'])
    cube('right half wall',(5.73,4.42,.95),(.15,1.65,1.9),M['plaster_warm'])
    # The entrance needs a real opening. The former full-width alcove wall
    # hid newcomers and their old navigation route passed through it.
    cube('coffee alcove wall',(2.475,3.38,1.50),(3.35,.13,3.0),M['plaster_warm'])
    # Three large daylight windows, skyline entirely geometric.
    for i in range(6):
        x=-8.1+i*1.72
        cube(f'window {i}',(x,5.16,1.82),(1.55,.018,1.43),M['window_sky'])
        for xx in (-.76,.76):
            cube(f'window jamb{i}',(x+xx,5.08,1.82),(.055,.12,1.57),M['oak_dark'])
        for zz in (1.07,2.59):
            cube(f'window rail{i}',(x,5.08,zz),(1.58,.12,.06),M['oak_dark'])
        cube(f'window mullion{i}',(x,5.06,1.82),(.035,.08,1.48),M['oak_dark'])
        cube(f'window cross{i}',(x,5.06,1.82),(1.45,.08,.027),M['oak_dark'])
    for i in range(18):
        x=-8.67+i*.58
        h=.35+(i*7%5)*.12
        cube(f'city block{i}',(x,5.13,1.08+h/2),(.40,.012,h),M['city' if i%2 else 'city_light'])
    cube('window ledge',(-3.8,5.02,1.03),(10.5,.27,.09),M['oak_light'],.018)
    # One pod, four complete workstations, offset from the coffee/lounge social zone.
    for n,(x,y,facing) in enumerate(((-2.45,.49,1),(-.95,.49,1),(-2.45,-.49,-1),(-.95,-.49,-1)),1):
        desk(x,y,facing,M,n)
        chair(x,y+facing*.60,facing,M,f'chair {n}')
    cube('pod divider',(-1.70,0,.90),(2.85,.055,.25),M['felt_sage'],.02)
    cube('left desk screen',(-3.14,0,.90),(.05,1.55,.24),M['felt_sage'],.018)
    cube('desk mid screen',(-1.70,0,.90),(.04,1.54,.24),M['felt_sage'],.018)
    # A four-desk pod and a two-desk line with a perpendicular two-desk nook.
    for pod, positions in enumerate((
        [(-7.4,1.70,1),(-5.9,1.70,1),(-7.4,.70,-1),(-5.9,.70,-1)],
        [(-7.2,-1.80,1),(-5.7,-1.80,1),(-7.6,-3.15,1),(-7.6,-4.45,1)],
    ),1):
        for offset,(x,y,facing) in enumerate(positions):
            n=4*pod+offset+1
            before = set(bpy.context.scene.objects)
            desk(x,y,facing,M,n)
            chair(x,y+facing*.60,facing,M,f'chair {n}')
            if n in (11,12):
                # Turn the two front desks toward the aisle, making an L cluster.
                pivot=Vector((x,y,0))
                from mathutils import Matrix
                rotation=Matrix.Rotation(-math.pi/2,4,'Z')
                for obj in set(bpy.context.scene.objects)-before:
                    obj.location=pivot+rotation.to_3x3()@(obj.location-pivot)
                    obj.rotation_euler.z-=math.pi/2
        mx=sum(p[0] for p in positions)/4
        my=sum(p[1] for p in positions)/4
        if pod == 1:
            cube(f'pod {pod} divider',(mx,my,.90),(2.85,.055,.25),M['felt_sage'],.02)
            cube(f'pod {pod} end screen',(mx-1.44,my,.90),(.05,1.55,.24),M['felt_sage'],.018)
    # Producer has a separate position; the long outer layer makes the silhouette clear.
    desk(.05,2.75,1,M,13)
    chair(.05,3.35,1,M,'producer chair')
    cube('producer cabinet',(-.95,3.76,.43),(.70,.46,.82),M['oak_dark'],.02)
    cube('producer papers',(-.95,3.76,.86),(.36,.27,.025),M['paper_cream'],.01)
    # Compact meeting table, three chairs and a legible working surface.
    cube('meeting top',(-.35,-3.31,.73),(1.50,.76,.065),M['oak_light'],.045)
    for sx in (-.58,.58):
        for sy in (-.26,.26):
            cube('meeting leg',(-.35+sx,-3.31+sy,.36),(.045,.045,.69),M['metal_satin'])
    cube('meeting agenda',(-.30,-3.31,.775),(.40,.30,.016),M['paper_cream'],.005)
    chair(-.89,-4.05,-1,M,'meeting south left')
    chair(.19,-4.05,-1,M,'meeting south right')
    chair(-.35,-2.56,1,M,'meeting north')
    cube('storage shelves',(-3.10,4.82,.91),(1.13,.38,1.82),M['oak_dark'],.025)
    for shelf in (.43,.91,1.39):
        cube('shelf board',(-3.10,4.58,shelf),(1.03,.32,.035),M['oak_light'],.01)
    for i in range(9):
        cube(f'shelf book{i}',(-3.54+i*.10,4.55,.50+(i%3)*.48),(.065,.16,.23),M['terracotta' if i%3==0 else 'paper_cream'])
    # Coffee counter occupies the rear right corner, leaving a clear circulation lane.
    cube('coffee cabinet',(2.78,2.72,.43),(2.27,.62,.84),M['felt_sage'],.02)
    cube('coffee counter',(2.78,2.72,.89),(2.37,.72,.065),M['oak_light'],.025)
    for x in (2.16,2.83,3.50):
        cube('cabinet door',(x,2.39,.40),(.58,.018,.65),M['felt_sage'])
        cyl('handle',(x,2.35,.48),.014,.032,M['metal_satin'])
    cube('espresso machine',(2.20,2.65,1.12),(.46,.34,.40),M['charcoal'],.04)
    cube('espresso face',(2.20,2.46,1.14),(.35,.014,.25),M['metal_satin'],.012)
    cyl('espresso dial',(2.1,2.44,1.21),.028,.012,M['black_rubber'],16,rotation=(math.pi/2,0,0))
    cyl('espresso portafilter',(2.2,2.45,.99),.075,.024,M['black_rubber'])
    for i in range(3):
        mug(2.70+i*.17,2.60,.925,M,f'coffee cup{i}')
    cube('coffee shelf',(2.80,3.12,1.82),(1.85,.22,.055),M['oak_light'],.015)
    for i in range(7):
        cube(f'coffee book{i}',(2.13+i*.15,3.05,1.97),(.07,.12,.25+(i%3)*.04),M['terracotta' if i%3==0 else 'paper_cream'])
    # Lounge grouping: back, arms and cushion layers, low table, folded throw.
    cube('sofa plinth',(2.58,-1.63,.22),(2.0,.74,.31),M['oak_dark'],.04)
    cube('sofa seat',(2.58,-1.60,.46),(1.96,.72,.18),M['leather_cognac'],.075)
    cube('sofa back',(2.58,-1.21,.78),(1.98,.20,.72),M['leather_cognac'],.065)
    for s in (-1,1):
        cube('sofa arm',(2.58+s*1.0,-1.60,.60),(.19,.85,.40),M['leather_cognac'],.05)
    for dx in (-.45,.45):
        cube('sofa cushion',(2.58+dx,-1.64,.55),(.83,.58,.10),M['linen_blue'],.045)
    cube('sofa throw',(3.20,-1.72,.63),(.28,.54,.045),M['paper_cream'],.015)
    cube('coffee table',(2.57,-2.67,.42),(1.32,.65,.07),M['oak_light'],.045)
    for dx in (-.51,.51):
        for dy in (-.24,.24):
            cube('table leg',(2.57+dx,-2.67+dy,.22),(.035,.035,.41),M['charcoal'])
    cube('table magazine',(2.35,-2.66,.47),(.26,.20,.018),M['paper_cream'],.006)
    mug(2.89,-2.65,.46,M,'lounge mug')
    # Whiteboard and pin board, sparse enough to read as real work surfaces.
    board_frame=cube('whiteboard',(2.2,2.93,2.08),(3.20,.06,.95),M['metal_satin'],.02)
    board_face=cube('whiteboard face',(2.2,2.89,2.08),(3.06,.008,.85),M['paper_cream'])
    board_frame.rotation_euler.z=-.27;board_face.rotation_euler.z=-.27
    for x in (.90,3.50):
        beam('board wall bracket',(x,3.30,2.07),(x,2.88,2.07),.012,M['metal_satin'],8)
    plant(-3.73,-2.63,1.35,M,'front ficus')
    plant(3.76,-2.84,.88,M,'lounge plant')
    plant(3.92,1.20,.75,M,'counter plant')
    plant(-8.65,4.26,1.1,M,'window fig')
    plant(-1.79,-4.18,.81,M,'meeting fern')
    plant(4.84,4.47,1.22,M,'entry tree')
    # Personal clutter and useful shared equipment make the floor feel occupied.
    for n,(x,y) in enumerate(((-8.65,1.05),(-5.05,.86),(-8.52,-2.05),
                              (-5.03,-2.95),(-3.1,.86),(-.34,-.82))):
        cube(f'backpack {n}',(x,y,.20),(.25,.16,.38),M['charcoal' if n%2 else 'leather_cognac'],.06)
        for dx in (-.075,.075):
            beam(f'pack strap {n}',(x+dx,y+.09,.26),(x+dx,y+.09,.39),.012,M['black_rubber'],6)
    cube('canvas tote',(1.44,-.25,.22),(.31,.09,.40),M['paper_cream'],.025)
    for dx in (-.09,.09):
        beam('tote handle',(1.44+dx,-.25,.35),(1.44+dx,-.25,.52),.011,M['oak_dark'],6)
    # The jacket hangs over the spare meeting chair rather than intersecting a worker.
    cube('chair jacket back',(.19,-4.29,.90),(.47,.045,.55),M['felt_sage'],.035)
    for s in (-1,1):
        cube('chair jacket sleeve',(.19+s*.31,-4.28,.78),(.18,.05,.42),M['felt_sage'],.025)
    cyl('waste bin',(-8.55,-.62,.22),.18,.40,M['metal_satin'],12)
    cyl('bin liner',(-8.55,-.62,.424),.16,.008,M['charcoal'],12)
    # Soft rugs anchor the lounge and the path to the coffee corner.
    cube('lounge rug',(2.65,-2.12,.019),(3.35,2.32,.018),M['paper_cream'],.05)
    for i in range(7):
        cube('rug woven stripe',(1.15+i*.46,-2.12,.031),(.016,2.1,.004),M['linen_blue'])
    cube('entry runner',(4.79,2.98,.019),(.72,2.3,.018),M['linen_blue'],.025)
    # Wall art, pinned work and a working clock.
    cube('art frame',(-2.15,5.12,2.24),(.82,.055,.53),M['oak_dark'],.015)
    cube('art print',(-2.15,5.08,2.24),(.75,.006,.46),M['paper_cream'])
    for i in range(4):
        cube('art color block',(-2.40+i*.15,5.07,2.13+i%2*.12),(.10,.004,.14),
             M['felt_sage' if i%2 else 'terracotta'])
    cube('team calendar',(3.9,3.16,2.55),(.36,.018,.61),M['paper_cream'],.008)
    for row in range(4):
        for col in range(4):
            cube('calendar mark',(3.78+col*.078,3.147,2.38+row*.10),(.044,.004,.038),
                 M['terracotta' if (row+col)%5==0 else 'felt_sage'])
    cyl('clock face',(1.0,3.16,2.74),.20,.025,M['paper_cream'],24,rotation=(math.pi/2,0,0))
    beam('clock hour',(1.0,3.138,2.74),(1.0,3.13,2.86),.009,M['charcoal'],6)
    beam('clock minute',(1.0,3.128,2.74),(1.09,3.12,2.69),.006,M['charcoal'],6)
    cube('corkboard',(-4.31,5.10,2.18),(.88,.055,.65),M['oak_dark'],.012)
    for i in range(9):
        x=-4.66+(i%3)*.23;z=2.00+(i//3)*.15
        cube('pinned note',(x,5.065,z),(.15,.006,.10),M['paper_cream' if i%3 else 'terracotta'])
    # Printer, water cooler and coat rack each have a clear functional silhouette.
    cube('printer body',(3.58,2.61,1.12),(.52,.44,.35),M['charcoal'],.035)
    cube('printer tray',(3.58,2.29,1.04),(.44,.23,.03),M['metal_satin'],.008)
    cube('printer paper',(3.58,2.23,1.07),(.33,.19,.016),M['paper_cream'])
    cyl('water cooler base',(4.89,2.20,.46),.17,.87,M['paper_cream'],16)
    orb('water bottle',(4.89,2.20,1.10),(.135,.135,.29),M['window_sky'],16)
    cyl('water cap',(4.89,2.20,1.39),.075,.045,M['screen_blue'],12)
    beam('coat rack stem',(5.13,-3.64,.08),(5.13,-3.64,1.76),.028,M['oak_dark'])
    for i in range(4):
        a=i*math.pi/2
        beam('coat hook',(5.13,-3.64,1.54),(5.13+math.cos(a)*.22,-3.64+math.sin(a)*.22,1.58),
             .019,M['oak_dark'])
    cube('hanging coat',(5.31,-3.64,1.21),(.23,.18,.54),M['linen_blue'],.045)
    # A door and airy phone booth occupy the formerly blank right edge.
    cube('door panel',(5.66,4.43,1.08),(.06,1.10,2.12),M['oak_light'],.018)
    cube('door inset',(5.615,4.43,1.42),(.008,.69,.68),M['window_sky'],.007)
    cyl('door handle',(5.58,4.11,1.01),.032,.09,M['metal_satin'],12,rotation=(0,math.pi/2,0))
    for x in (4.05,5.48):
        for y in (-.55,.92):
            cube('booth post',(x,y,1.05),(.045,.045,2.05),M['metal_satin'])
    for z in (.07,2.07):
        cube('booth front rail',(4.76,-.55,z),(1.46,.045,.045),M['metal_satin'])
        cube('booth side rail',(4.05,.19,z),(.045,1.50,.045),M['metal_satin'])
    cube('booth frosted side',(4.05,.19,1.18),(.014,1.33,1.30),M['window_sky'])
    cube('booth shelf',(4.85,.48,.98),(.73,.28,.055),M['oak_light'],.014)
    cube('booth stool',(4.84,.13,.46),(.40,.35,.09),M['leather_cognac'],.035)
    cyl('booth stool stem',(4.84,.13,.26),.035,.36,M['metal_satin'])
    # Different plant forms: upright leaves, a loose hanging vine and a cactus.
    cyl('snake pot',(4.92,-2.80,.15),.16,.28,M['terracotta'],12)
    for i in range(7):
        x=4.92+(i%3-1)*.065+i*.004;y=-2.80+(i//3-1)*.06+i*.007
        beam('snake leaf',(x,y,.27),(x+.02*(i%2),y,.61+(i%4)*.07),.034,M['leaf'],8)
    cyl('vine pot',(-3.17,4.55,1.51),.13,.18,M['ceramic_cream'],12)
    for i in range(6):
        x=-3.17+(i%3-1)*.10+(i//3)*.027
        y=4.50-(i//3)*.028
        beam('hanging vine',(x,y,1.53),(x+.03,y-.08,1.25-i%2*.11),.012,M['leaf'],6)
        orb('vine leaf',(x+.04,y-.08,1.29-i%2*.11),(.065,.032,.022),M['leaf_light'],8)
    cyl('cactus pot',(1.40,2.63,.99),.10,.14,M['terracotta'],12)
    cyl('cactus body',(1.40,2.63,1.17),.065,.29,M['leaf'],10)
    for dx in (-.09,.09):
        beam('cactus arm',(1.40,2.63,1.12),(1.40+dx,2.63,1.20),.031,M['leaf'],8)
    for x,y in ((-6.55,1.20),(-6.45,-2.30),(-1.7,0)):
        beam('pendant cord',(x,y,3.04),(x,y,2.75),.007,M['black_rubber'],6)
        cyl('pendant shade',(x,y,2.74),.19,.08,M['paper_cream'],16)
        orb('warm bulb',(x,y,2.68),(.09,.09,.045),M['ceramic_cream'],12)
    # Unite the two L returns with their neighbouring tabletops. Their original
    # transforms stay fixed, while interior coincident faces are removed.
    for number,neighbor in ((5,7),):
        base=bpy.data.objects[f'D{number} top']
        for other_name in (f'D{number} L return',f'D{neighbor} top'):
            other=bpy.data.objects[other_name]
            bpy.ops.object.select_all(action='DESELECT')
            base.select_set(True);bpy.context.view_layer.objects.active=base
            union=base.modifiers.new('remove interior overlap','BOOLEAN')
            union.operation='UNION';union.solver='EXACT';union.object=other
            bpy.ops.object.modifier_apply(modifier=union.name)
            bpy.data.objects.remove(other,do_unlink=True)
        working=bmesh.new();working.from_mesh(base.data)
        bmesh.ops.remove_doubles(working,verts=working.verts,dist=.0001)
        bmesh.ops.dissolve_degenerate(working,edges=working.edges,dist=.0001)
        bmesh.ops.recalc_face_normals(working,faces=working.faces)
        working.to_mesh(base.data);working.free();base.data.update()
    # Phase 2d keeps only shared furniture in the room export. Workstations are
    # authored as modules and instantiated by member id in the renderer.
    for obj in list(bpy.context.scene.objects):
        name=obj.name
        if (name.startswith('D') and len(name)>1 and name[1].isdigit()) or \
           name.startswith(('chair ','producer chair','producer cabinet','producer papers',
                            'pod divider','pod 1 divider','pod 1 end screen',
                            'left desk screen','desk mid screen','desk rug','rug seam','backpack','pack strap',
                            'left return')):
            bpy.data.objects.remove(obj,do_unlink=True)
    # Frame geometry only; real-time lighting in the renderer is the source of shadows.
    bpy.context.preferences.filepaths.save_version=0
    group_chairs(['meeting south left', 'meeting south right', 'meeting north'])
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE/'studio_room.blend'))
    bpy.ops.object.select_all(action='DESELECT')
    join_by_material()
    room_target=PUBLIC/'room.glb';room_temp=PUBLIC/'room.tmp.glb'
    bpy.ops.export_scene.gltf(filepath=str(room_temp),export_format='GLB',export_yup=True,
        export_materials='EXPORT',export_cameras=False,export_lights=False,export_animations=False)
    if room_temp.stat().st_size<100_000:raise RuntimeError('incomplete room GLB')
    os.replace(room_temp,room_target)
    print('ROOM',len([o for o in bpy.context.scene.objects if o.type=='MESH']))


def build_workstation_kit():
    reset_scene()
    M=mat_palette()
    def module(name,build):
        before=set(bpy.context.scene.objects)
        build()
        pivot=bpy.data.objects.new(name,None)
        bpy.context.collection.objects.link(pivot)
        bpy.context.view_layer.update()
        for obj in set(bpy.context.scene.objects)-before-{pivot}:
            world=obj.matrix_world.copy()
            obj.parent=pivot
            obj.matrix_world=world
    def legs(height):
        for x in (-.57,.57):
            for y in (-.86,-.34):
                cube('desk leg',(x,y,height/2),(.038,.038,height),M['metal_satin'])
    def desk_top(height=.73):
        cube('desk top',(0,-.6,height),(1.30,.69,.055),M['oak_light'],.015)
        legs(height)
    module('desk_straight',lambda:desk_top())
    def desk_l():
        desk_top()
        cube('L return',(-.56,-.09,.728),(.48,.84,.051),M['oak_light'],.015)
        for y in (-.42,.18):
            cube('return leg',(-.77,y,.36),(.038,.038,.69),M['metal_satin'])
    module('desk_l',desk_l)
    def desk_standing():
        # A sit/stand frame arrives in its lowered position, with the chair.
        cube('adjustable top',(0,-.6,.73),(1.30,.69,.055),M['oak_light'],.015)
        for x in (-.5,.5):
            cube('lower telescope',(x,-.6,.27),(.085,.085,.48),M['metal_satin'],.008)
            cube('upper telescope',(x,-.6,.58),(.055,.055,.25),M['charcoal'],.006)
            cube('T foot',(x,-.6,.055),(.12,.56,.045),M['metal_satin'],.012)
        cube('adjustable rail',(0,-.6,.63),(.98,.055,.04),M['metal_satin'],.012)
        cube('height control',(.47,-.31,.68),(.10,.07,.025),M['charcoal'],.008)
    module('desk_standing',desk_standing)
    module('chair',lambda:chair(0,0,1,M,'kit chair'))
    def monitor():
        cube('monitor shell',(0,-.78,1.08),(.53,.038,.28),M['charcoal'],.012)
        cube('monitor screen',(0,-.756,1.08),(.505,.007,.246),M['screen_blue'])
        cyl('monitor stem',(0,-.78,.87),.018,.21,M['metal_satin'])
        cube('monitor foot',(0,-.78,.765),(.17,.12,.015),M['charcoal'],.01)
        cube('keyboard',(-.11,-.43,.768),(.40,.13,.017),M['charcoal'],.008)
        orb('mouse',(.30,-.43,.765),(.037,.055,.015),M['charcoal'])
    module('monitor',monitor)
    def laptop():
        cube('laptop base',(0,-.57,.76),(.40,.28,.02),M['metal_satin'],.008)
        cube('laptop lid',(0,-.70,.88),(.40,.025,.25),M['charcoal'],.008)
        cube('laptop screen',(0,-.681,.88),(.36,.004,.21),M['screen_blue'])
    module('laptop',laptop)
    module('pen_tablet',lambda:cube('pen tablet',(.38,-.42,.775),(.30,.20,.018),M['charcoal'],.012))
    def tray():
        cube('document tray',(.40,-.72,.78),(.30,.22,.035),M['metal_satin'],.012)
        for j in range(3):cube('paper',(.40,-.72,.805+j*.004),(.26,.18,.004),M['paper_cream'])
    module('document_tray',tray)
    module('notebook',lambda:cube('notebook',(.40,-.48,.775),(.22,.27,.018),M['terracotta'],.007))
    def sticky_board():
        cube('sticky board',(-.55,-.79,1.03),(.16,.035,.20),M['felt_sage'],.008)
        cube('sticky note',(-.55,-.766,1.04),(.10,.004,.075),M['paper_cream'])
    module('sticky_board',sticky_board)
    module('headphones',lambda:cube('headphones',(.47,-.36,.79),(.13,.10,.04),M['charcoal'],.018))
    module('mug',lambda:mug(.48,-.47,.77,M,'mug'))
    def desk_plant():
        cyl('pot',(.49,-.78,.79),.045,.055,M['terracotta'],8)
        orb('succulent',(.49,-.78,.845),(.06,.05,.04),M['leaf'],8)
    module('plant',desk_plant)
    def photo():
        cube('photo frame',(.49,-.77,.85),(.15,.025,.16),M['oak_dark'],.008)
        cube('photo print',(.49,-.75,.85),(.12,.004,.12),M['paper_cream'])
    module('photo',photo)
    target=PUBLIC/'workstation_kit.glb';temporary=PUBLIC/'workstation_kit.tmp.glb'
    bpy.ops.export_scene.gltf(filepath=str(temporary),export_format='GLB',export_yup=True,
        export_materials='EXPORT',export_cameras=False,export_lights=False,export_animations=False)
    if temporary.stat().st_size<20000:raise RuntimeError('incomplete workstation kit')
    os.replace(temporary,target)
    print('WORKSTATION KIT',temporary.stat().st_size if temporary.exists() else target.stat().st_size)


def reset_scene():
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)


def body_materials(index):
    looks = [
        # amber cardigan, black bob, warm olive skin
        dict(skin=(.58,.34,.22), hair=(.055,.048,.043), top=(.25,.36,.29), inner=(.79,.69,.54), pants=(.16,.22,.25), shoe=(.09,.085,.077), accent=(.45,.57,.39)),
        # navy hoodie, short textured curls, deeper skin
        dict(skin=(.37,.20,.13), hair=(.042,.036,.033), top=(.15,.27,.35), inner=(.18,.32,.37), pants=(.37,.35,.31), shoe=(.12,.10,.09), accent=(.80,.65,.41)),
        # pale blue shirt, long swept auburn hair, lighter skin
        dict(skin=(.76,.52,.40), hair=(.22,.10,.07), top=(.40,.56,.58), inner=(.86,.77,.62), pants=(.19,.22,.26), shoe=(.28,.16,.12), accent=(.54,.28,.22)),
        dict(skin=(.69,.46,.33), hair=(.08,.06,.05), top=(.23,.40,.34), inner=(.85,.77,.60), pants=(.31,.28,.25), shoe=(.13,.11,.10), accent=(.68,.36,.24)),
        dict(skin=(.87,.62,.47), hair=(.36,.20,.10), top=(.48,.33,.30), inner=(.77,.68,.53), pants=(.20,.27,.29), shoe=(.20,.14,.10), accent=(.78,.55,.25)),
        dict(skin=(.49,.29,.20), hair=(.11,.07,.05), top=(.50,.51,.37), inner=(.83,.75,.62), pants=(.18,.20,.22), shoe=(.09,.10,.10), accent=(.42,.60,.54)),
        dict(skin=(.78,.55,.42), hair=(.04,.045,.055), top=(.23,.30,.44), inner=(.77,.80,.76), pants=(.34,.31,.25), shoe=(.18,.16,.13), accent=(.62,.42,.31)),
        dict(skin=(.58,.38,.27), hair=(.30,.24,.15), top=(.57,.43,.27), inner=(.80,.68,.52), pants=(.21,.26,.28), shoe=(.15,.10,.08), accent=(.40,.59,.49)),
        dict(skin=(.82,.59,.47), hair=(.15,.07,.05), top=(.32,.45,.48), inner=(.87,.80,.68), pants=(.29,.32,.34), shoe=(.22,.15,.12), accent=(.74,.42,.23)),
        dict(skin=(.42,.25,.18), hair=(.055,.05,.055), top=(.57,.32,.21), inner=(.81,.73,.59), pants=(.16,.20,.24), shoe=(.13,.12,.11), accent=(.56,.63,.44)),
        dict(skin=(.73,.47,.34), hair=(.12,.08,.05), top=(.33,.39,.27), inner=(.82,.74,.64), pants=(.25,.22,.20), shoe=(.16,.12,.10), accent=(.64,.48,.32)),
        dict(skin=(.90,.68,.56), hair=(.08,.07,.05), top=(.37,.44,.55), inner=(.86,.78,.65), pants=(.25,.26,.28), shoe=(.14,.13,.13), accent=(.72,.41,.33)),
        dict(skin=(.64,.43,.32), hair=(.08,.07,.06), top=(.52,.27,.18), inner=(.83,.76,.65), pants=(.23,.25,.26), shoe=(.12,.11,.10), accent=(.29,.38,.40)),
    ]
    spec=looks[index]
    mats={k:material(k,v,.87 if k not in ('hair','shoe') else .65) for k,v in spec.items()}
    mats['eye']=material('eye',(.045,.047,.045),.35)
    mats['white']=material('eye white',(.89,.80,.69),.6)
    mats['metal']=material('badge metal',(.40,.44,.41),.36,.35)
    return mats


def make_armature():
    data=bpy.data.armatures.new('CommonHumanoid')
    arm=bpy.data.objects.new('Rig',data)
    bpy.context.collection.objects.link(arm)
    bpy.context.view_layer.objects.active=arm
    arm.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bones={
        'root':((0,0,0),(0,0,.12),None),
        'hips':((0,0,.91),(0,0,1.05),'root'),
        'spine':((0,0,1.05),(0,0,1.43),'hips'),
        'neck':((0,0,1.43),(0,0,1.53),'spine'),
        'head':((0,0,1.53),(0,0,1.76),'neck'),
    }
    for side,sign in (('L',-1),('R',1)):
        bones.update({
            'upper_arm.'+side:((sign*.24,0,1.39),(sign*.35,0,1.10),'spine'),
            'forearm.'+side:((sign*.35,0,1.10),(sign*.41,-.09,.86),'upper_arm.'+side),
            'hand.'+side:((sign*.41,-.09,.86),(sign*.42,-.13,.76),'forearm.'+side),
            'thigh.'+side:((sign*.13,0,.92),(sign*.14,-.045,.50),'hips'),
            'shin.'+side:((sign*.14,-.045,.50),(sign*.14,-.01,.11),'thigh.'+side),
            'foot.'+side:((sign*.14,-.01,.11),(sign*.14,-.20,.08),'shin.'+side),
        })
    for name,(head,tail,parent) in bones.items():
        b=data.edit_bones.new(name); b.head=head; b.tail=tail
        if parent:b.parent=data.edit_bones[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.select_set(False)
    for p in arm.pose.bones:p.rotation_mode='XYZ'
    return arm


def bind(o, arm, bone):
    vg=o.vertex_groups.new(name=bone)
    vg.add(list(range(len(o.data.vertices))),1,'REPLACE')
    mod=o.modifiers.new('skin','ARMATURE');mod.object=arm
    return o


def atlas_person(arm, index):
    """Pack the palette into vertex colours: one skinned mesh, one draw material."""
    objects=[o for o in bpy.context.scene.objects if o.type=='MESH']
    colours={o.data.materials[0].name:tuple(o.data.materials[0].diffuse_color[:3]) for o in objects}
    for o in objects:
        colour=colours[o.data.materials[0].name]
        face_tag=o.data.attributes.new(name='_FacePart',type='INT',domain='POINT')
        kind=1 if o.name.startswith(('sclera','pupil')) else 2 if o.name.startswith('mouth') else 0
        for item in face_tag.data:item.value=kind
        layer=o.data.color_attributes.get('Palette') or o.data.color_attributes.new(name='Palette',type='BYTE_COLOR',domain='CORNER')
        if not o.name.startswith('continuous body'):
            for corner in layer.data:corner.color=(*colour,1.0)
        while o.data.uv_layers:
            o.data.uv_layers.remove(o.data.uv_layers[0])
        o.data.materials.clear()
    atlas=material('person palette',(1,1,1),.85)
    bsdf=next(n for n in atlas.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    colour_node=atlas.node_tree.nodes.new('ShaderNodeVertexColor')
    colour_node.layer_name='Palette'
    atlas.node_tree.links.new(colour_node.outputs['Color'],bsdf.inputs['Base Color'])
    for o in objects:o.data.materials.append(atlas)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objects:o.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]
    bpy.ops.object.join()
    objects[0].name='BODY_ATLAS'
    objects[0].parent=arm
    bpy.ops.object.select_all(action='DESELECT')


def build_person(index):
    reset_scene(); M=body_materials(index); arm=make_armature()
    # Slightly varied proportions preserve one common deformation skeleton.
    width=[1,1.11,.94,.97,1.04,1.13,.91,1.02,.96,1.09,.98,.93,1.06][index]
    def piece(o,b):return bind(o,arm,b)
    piece(orb('pelvis',(0,0,.97),(.21*width,.13,.15),M['pants']),'hips')
    piece(orb('torso',(0,0,1.24),(.265*width,.15,.30),M['top']),'spine')
    piece(orb('shirt inset',(0,-.139,1.33),(.16,.018,.17),M['inner']),'spine')
    if index in (0,3,7):
        for s in (-1,1):
            piece(cube('cardigan lapel',(s*.115,-.16,1.30),(.072,.025,.30),M['top'],.01),'spine')
        piece(cube('cardigan hem',(0,0,1.06),(.44,.29,.055),M['top'],.012),'spine')
    elif index in (1,5,9):
        piece(orb('hood',(0,.105,1.43),(.22,.14,.16),M['top']),'spine')
        piece(cube('hood pocket',(0,-.157,1.13),(.25,.02,.13),M['accent'],.02),'spine')
    else:
        for s in (-1,1):
            piece(cube('shirt collar',(s*.095,-.15,1.43),(.115,.03,.08),M['inner'],.015),'spine')
    if index in (4,8,10):
        piece(cube('jacket yoke',(0,.055,1.41),(.44,.14,.10),M['accent'],.018),'spine')
        for s in (-1,1):
            piece(cube('jacket lapel',(s*.12,-.165,1.32),(.065,.025,.25),M['accent'],.01),'spine')
    if index == 12:
        piece(cube('producer long overshirt',(0,.055,1.12),(.53,.31,.31),M['top'],.045),'spine')
        for s in (-1,1):
            piece(cube('producer open front',(s*.19,-.14,1.29),(.11,.045,.40),M['top'],.025),'spine')
    face_width=[1,1.08,.92,1.04,.90,1.13,.89,1.02,.94,1.10,.97,.88,1.05][index]
    face_height=[1,.96,1.05,.94,1.06,.93,1.09,.99,1.04,.95,1.07,1.02,.98][index]
    eye_gap=[.054,.059,.051,.056,.050,.060,.052,.054,.051,.061,.056,.050,.057][index]
    piece(cyl('neck',(0,0,1.49),.062*face_width,.12,M['skin']),'neck')
    piece(orb('head',(0,-.005,1.65),(.135*face_width,.123,.182*face_height),M['skin'],16),'head')
    piece(orb('nose',(0,-.127,1.635),(.022+index%3*.003,.029,.034+index%4*.003),M['skin']),'head')
    for s in (-1,1):
        piece(orb('ear',(s*.133*face_width,-.002,1.65),(.024,.025,.039),M['skin']),'head')
        piece(orb('eye white',(s*eye_gap,-.123,1.684),(.020,.010,.014),M['white']),'head')
        piece(orb('iris',(s*eye_gap,-.133,1.683),(.010,.008,.011),M['eye']),'head')
        piece(cube('brow',(s*eye_gap,-.111,1.718),(.050,.012,.008),M['hair'],.003),'head')
    piece(cube('mouth',(0,-.108,1.582),(.042+index%3*.004,.007,.006),M['hair'],.003),'head')
    piece(orb('hair cap',(0,.018,1.755),(.145*face_width,.135,.090+index%3*.008),M['hair'],16),'head')
    if index in (0,7,11):
        for s in (-1,1):piece(orb('bob',(s*.119,.016,1.675),(.038,.10,.15),M['hair']),'head')
        piece(orb('fringe',(-.035,-.103,1.75),(.11,.04,.052),M['hair']),'head')
    elif index in (1,5,9):
        for i in range(12):
            a=i*2.4
            piece(orb('curl',(math.cos(a)*.105,math.sin(a)*.090,1.78+(i%3)*.029),(.047,.05,.044),M['hair']),'head')
    elif index in (2,4,8,10):
        piece(orb('swept hair',(.065,.035,1.75),(.11,.13,.11),M['hair']),'head')
        piece(orb('long hair',(.12,.055,1.59),(.06,.09,.19),M['hair']),'head')
    elif index in (3,6):
        piece(orb('short side part',(-.060,-.032,1.76),(.105,.10,.095),M['hair']),'head')
        piece(orb('raised quiff',(.05,-.075,1.81),(.082,.07,.09),M['hair']),'head')
    else:
        piece(orb('tied hair',(0,.11,1.63),(.08,.09,.15),M['hair']),'head')
        piece(orb('top knot',(0,.09,1.84),(.065,.06,.07),M['hair']),'head')
    # Individual profiles break the repeated cap silhouettes at office distance.
    if index in (0,8):
        piece(orb('side fringe',(-.085,-.093,1.74),(.075,.045,.075),M['hair']),'head')
    if index in (1,5,9):
        for j in range(index%4+2):
            piece(orb('curl crest',(j*.057-.08,-.02,1.84+(j%2)*.027),(.045,.050,.045),M['hair'],8),'head')
    if index in (2,4,10):
        piece(orb('long back',(0,.106,1.60),(.12,.055,.20+index%3*.025),M['hair']),'head')
    if index in (3,6):
        piece(orb('temple sweep',(.08,-.082,1.75),(.090,.046,.049),M['hair']),'head')
    if index in (7,11):
        piece(orb('bob part',(0,-.10,1.76),(.10,.04,.04),M['hair']),'head')
    if index == 12:
        piece(orb('producer silver lock',(-.055,-.096,1.78),(.032,.028,.053),M['white']),'head')
    if index in (3,6,11,12):
        for s in (-1,1):
            x=s*eye_gap
            for a,b in [((x-.031,-.146,1.709),(x+.031,-.146,1.709)),
                        ((x-.031,-.146,1.659),(x+.031,-.146,1.659)),
                        ((x-.031,-.146,1.659),(x-.031,-.146,1.709)),
                        ((x+.031,-.146,1.659),(x+.031,-.146,1.709))]:
                piece(beam('glasses frame',a,b,.003,M['metal'],6),'head')
        piece(cube('glasses bridge',(0,-.15,1.687),(.050,.009,.006),M['metal']),'head')
    if index in (5,9,12):
        piece(orb('chin beard',(0,-.093,1.544),(.087,.050,.045),M['hair']),'head')
    if index in (4,8):
        for s in (-1,1):
            piece(orb('freckle',(s*.062,-.118,1.645),(.012,.004,.007),M['accent'],8),'head')
    for side,s in (('L',-1),('R',1)):
        piece(beam('upper sleeve',(s*.25,0,1.37),(s*.35,0,1.105),.085*width,M['top']),'upper_arm.'+side)
        piece(orb('elbow',(s*.35,0,1.10),(.072,.075,.075),M['top']),'forearm.'+side)
        piece(beam('forearm sleeve',(s*.35,0,1.10),(s*.41,-.09,.85),.073*width,M['top']),'forearm.'+side)
        piece(orb('hand',(s*.42,-.11,.80),(.051,.06,.072),M['skin']),'hand.'+side)
        piece(beam('trouser thigh',(s*.13,0,.91),(s*.14,-.045,.50),.104*width,M['pants']),'thigh.'+side)
        piece(orb('knee',(s*.14,-.045,.50),(.091,.09,.082),M['pants']),'shin.'+side)
        piece(beam('trouser calf',(s*.14,-.045,.49),(s*.14,-.01,.13),.083*width,M['pants']),'shin.'+side)
        piece(orb('shoe',(s*.14,-.105,.09),(.10,.18,.07),M['shoe']),'foot.'+side)
    # Card and lanyard are part of the chest, thus stable in all clips.
    for s in (-1,1):
        piece(beam('lanyard',(s*.10,-.15,1.44),(0,-.175,1.16),.006,M['accent']),'spine')
    piece(cube('ID',(0,-.184,1.15),(.075,.012,.10),M['white'],.008),'spine')
    piece(cube('ID stripe',(0,-.189,1.12),(.055,.004,.010),M['accent']),'spine')
    # Keep a separate mesh per material; joins preserve vertex groups and skinned parts.
    for mat in M.values():
        objects=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.data.materials[0]==mat]
        if len(objects)<2:continue
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:o.select_set(True)
        bpy.context.view_layer.objects.active=objects[0];bpy.ops.object.join()
        objects[0].name='BODY_'+mat.name
    for o in bpy.context.scene.objects:
        if o.type == 'MESH':
            o.parent=arm
    atlas_person(arm,index)
    animate(arm)
    bpy.ops.object.select_all(action='DESELECT')
    for o in bpy.context.scene.objects:o.select_set(True)
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE/f'person_{index+1}.blend'))
    target=PUBLIC/f'person_{index+1}.glb'
    temporary=PUBLIC/f'person_{index+1}.tmp.glb'
    bpy.ops.export_scene.gltf(filepath=str(temporary),export_format='GLB',export_yup=True,
        export_animation_mode='ACTIONS',export_force_sampling=True,export_frame_step=3,
        export_materials='EXPORT',export_cameras=False,export_lights=False)
    if temporary.stat().st_size<100_000:raise RuntimeError(f'incomplete character GLB: {index+1}')
    os.replace(temporary,target)
    print('PERSON',index+1,len(bpy.data.actions),len([o for o in bpy.context.scene.objects if o.type=='MESH']))


def animate(arm):
    B=arm.pose.bones
    def walk_legs(t):
        # Author a linear backwards contact trajectory at 1.1 m/s. The old
        # sine-only joint angles made the support foot accelerate through the
        # floor and forced large runtime root corrections near furniture.
        B['hips'].location.y=-.05
        bpy.context.view_layer.update()
        for side,sign,offset in (('L',-1,.25),('R',1,.75)):
            cycle=(t+offset)%1
            if cycle<.5:
                y=-.275+cycle*1.1;z=.11
            else:
                swing=(cycle-.5)*2
                smooth=swing*swing*(3-2*swing)
                y=.275-.55*smooth;z=.11+math.sin(math.pi*swing)*.10
            thigh,shin,foot=(B[f'{name}.{side}'] for name in ('thigh','shin','foot'))
            hip=thigh.head.copy();target=Vector((sign*.14,y,z))
            first=thigh.length;second=shin.length
            delta=target-hip;distance=min(delta.length,first+second-.0001)
            direction=delta.normalized();target=hip+direction*distance
            along=(first*first-second*second+distance*distance)/(2*distance)
            height=math.sqrt(max(0,first*first-along*along))
            bend=Vector((0,-1,0));bend=(bend-direction*bend.dot(direction)).normalized()
            knee=hip+direction*along+bend*height
            for bone,end in ((thigh,knee),(shin,target)):
                start=bone.head.copy()
                rotation=(bone.tail-start).rotation_difference(end-start).to_matrix().to_4x4()
                bone.matrix=Matrix.Translation(start)@rotation@Matrix.Translation(-start)@bone.matrix
                bpy.context.view_layer.update()
            flat=arm.data.bones[foot.name].matrix_local.to_3x3().to_4x4()
            flat.translation=foot.head.copy();foot.matrix=flat
            bpy.context.view_layer.update()
    def pose(frame, seat=0, lean=0, glance=0, left_arm=0, right_arm=0, leg=0, phase=0, gesture='',gait=None):
        bpy.context.scene.frame_set(frame)
        for b in B:
            b.rotation_euler=(0,0,0);b.location=(0,0,0)
        # The bone's local Y points up the spine; local Z would shift in depth.
        B['hips'].location.y=-.37*seat
        B['spine'].rotation_euler.x=lean
        B['neck'].rotation_euler.z=glance*.3
        B['head'].rotation_euler.z=glance*.7
        B['thigh.L'].rotation_euler.x=-1.38*seat+leg
        B['thigh.R'].rotation_euler.x=-1.38*seat-leg
        B['shin.L'].rotation_euler.x=1.35*seat+max(0,-leg)*.6
        B['shin.R'].rotation_euler.x=1.35*seat+max(0,leg)*.6
        for side,extra in (('L',left_arm),('R',right_arm)):
            B['upper_arm.'+side].rotation_euler.x=-.50*seat+extra
            B['forearm.'+side].rotation_euler.x=-.98*seat+(-.15 if extra else 0)
        if seat==0 and right_arm < -.8:
            B['forearm.R'].rotation_euler.x=right_arm*1.5
        if gesture == 'chin':
            B['upper_arm.R'].rotation_euler.x=-1.55
            B['forearm.R'].rotation_euler.x=-1.8
            B['upper_arm.R'].rotation_euler.z=.16
        elif gesture == 'cross':
            for side,sgn in (('L',1),('R',-1)):
                B['upper_arm.'+side].rotation_euler.x=-.95
                B['upper_arm.'+side].rotation_euler.z=-sgn*.40
                B['forearm.'+side].rotation_euler.x=-.30
                B['forearm.'+side].rotation_euler.z=-sgn*.80
        elif gesture == 'face':
            for side,sgn in (('L',1),('R',-1)):
                B['upper_arm.'+side].rotation_euler.x=-1.62
                B['upper_arm.'+side].rotation_euler.z=-sgn*.22
                B['forearm.'+side].rotation_euler.x=-1.58
        elif gesture == 'raise':
            B['upper_arm.R'].rotation_euler.x=-2.90
            B['upper_arm.R'].rotation_euler.z=.60
            B['forearm.R'].rotation_euler.x=0
            B['hand.R'].rotation_euler.x=-.35
        elif gesture.startswith('waiting'):
            B['upper_arm.R'].rotation_euler.x=-2.48 if gesture=='waiting_tap' else -2.58
            B['upper_arm.R'].rotation_euler.z=.60
            B['forearm.R'].rotation_euler.x=-.28
            B['hand.R'].rotation_euler.x=-.12
            B['spine'].rotation_euler.z=.08
        elif gesture == 'cheer':
            for side,sgn in (('L',1),('R',-1)):
                B['upper_arm.'+side].rotation_euler.x=-2.35
                B['upper_arm.'+side].rotation_euler.z=-sgn*.22
                B['forearm.'+side].rotation_euler.x=-.35
        elif gesture == 'sofa':
            for side,sgn in (('L',-1),('R',1)):
                B['upper_arm.'+side].rotation_euler.x=.35+(right_arm*.2 if side=='R' else 0)
                B['upper_arm.'+side].rotation_euler.z=sgn*.12
                B['forearm.'+side].rotation_euler.x=-1.05
        if phase:
            B['upper_arm.L'].rotation_euler.x=phase*.55
            B['upper_arm.R'].rotation_euler.x=-phase*.55
            B['thigh.L'].rotation_euler.x=phase*.58
            B['thigh.R'].rotation_euler.x=-phase*.58
            B['shin.L'].rotation_euler.x=max(0,-phase)*.52
            B['shin.R'].rotation_euler.x=max(0,phase)*.52
            B['spine'].rotation_euler.z=phase*.035
            B['hips'].location.y=abs(phase)*.018
        if gesture == 'carry':
            B['upper_arm.R'].rotation_euler.x=-.86
            B['forearm.R'].rotation_euler.x=-1.30
            B['upper_arm.R'].rotation_euler.z=.20
        if gait is not None:walk_legs(gait)
        bpy.context.view_layer.update()
        grounded=min(B['foot.L'].tail.z,B['foot.R'].tail.z)
        if grounded < .065:
            B['hips'].location.y += .065-grounded
        for b in B:
            b.keyframe_insert('rotation_euler',frame=frame,group=b.name)
            b.keyframe_insert('location',frame=frame,group=b.name)

    clips={
        'sit_type':[(1,dict(seat=1,lean=.12)),(9,dict(seat=1,lean=.14,left_arm=-.03)),(17,dict(seat=1,lean=.11,glance=.12,right_arm=-.04)),(25,dict(seat=1,lean=.12,glance=.25)),(33,dict(seat=1,lean=.12))],
        'sit_idle':[(1,dict(seat=1,lean=-.03)),(17,dict(seat=1,lean=-.06,glance=.18)),(33,dict(seat=1,lean=-.03))],
        'stand_up':[(1,dict(seat=1,lean=-.03)),(9,dict(seat=.92,lean=.35,left_arm=.20,right_arm=.20)),(18,dict(seat=.48,lean=.30,left_arm=.12,right_arm=.12)),(29,dict(seat=0,lean=.03)),(37,dict())],
        'sit_down':[(1,dict()),(8,dict(seat=.08,lean=.08)),(17,dict(seat=.50,lean=.25,left_arm=.18,right_arm=.18)),(26,dict(seat=.92,lean=.15)),(37,dict(seat=1,lean=-.03))],
        'walk':[(1,dict(phase=0)),(7,dict(phase=1)),(13,dict(phase=0)),(19,dict(phase=-1)),(25,dict(phase=0))],
        'turn_left':[(1,dict(phase=0,glance=.12)),(7,dict(phase=.18,glance=.12)),
                     (13,dict(phase=0,glance=.12)),(19,dict(phase=-.18,glance=.12)),(25,dict(phase=0,glance=.12))],
        'turn_right':[(1,dict(phase=0,glance=-.12)),(7,dict(phase=.18,glance=-.12)),
                      (13,dict(phase=0,glance=-.12)),(19,dict(phase=-.18,glance=-.12)),(25,dict(phase=0,glance=-.12))],
        'walk_folder':[(1,dict(phase=0,gesture='carry')),(7,dict(phase=1,gesture='carry')),
                       (13,dict(phase=0,gesture='carry')),(19,dict(phase=-1,gesture='carry')),
                       (25,dict(phase=0,gesture='carry'))],
        'stand_drink':[(1,dict()),(10,dict(right_arm=-1.05)),(22,dict(right_arm=-1.28,lean=-.06)),(39,dict(right_arm=-1.28,lean=-.03)),(52,dict(right_arm=-1.05)),(61,dict())],
        'sofa_sit':[(1,dict(seat=1,lean=.08)),(17,dict(seat=1,lean=.11,glance=-.15)),(33,dict(seat=1,lean=.08))],
        'sofa_talk':[(1,dict(seat=1,lean=.10,glance=.35,gesture='sofa')),(12,dict(seat=1,lean=.13,glance=.42,right_arm=-.20,gesture='sofa')),(23,dict(seat=1,lean=.10,glance=.36,gesture='sofa')),(33,dict(seat=1,lean=.10,glance=.35,gesture='sofa'))],
        'sit_draw':[(1,dict(seat=1,lean=.18,right_arm=-.19)),(9,dict(seat=1,lean=.20,right_arm=-.29)),(17,dict(seat=1,lean=.18,right_arm=-.14)),(25,dict(seat=1,lean=.20,right_arm=-.26)),(33,dict(seat=1,lean=.18,right_arm=-.19))],
        'sit_check':[(1,dict(seat=1,lean=.13,left_arm=-.34,right_arm=-.18)),(14,dict(seat=1,lean=.16,left_arm=-.35,right_arm=-.28)),(26,dict(seat=1,lean=.14,left_arm=-.34,right_arm=-.16)),(33,dict(seat=1,lean=.13,left_arm=-.34,right_arm=-.18))],
        'sit_write':[(1,dict(seat=1,lean=.20,right_arm=-.16)),(12,dict(seat=1,lean=.23,right_arm=-.30)),(23,dict(seat=1,lean=.20,right_arm=-.18)),(33,dict(seat=1,lean=.20,right_arm=-.16))],
        'sit_plan':[(1,dict(seat=1,lean=.07,right_arm=-.35)),(12,dict(seat=1,lean=.15,right_arm=-.75)),(24,dict(seat=1,lean=.10,right_arm=-.48)),(33,dict(seat=1,lean=.07,right_arm=-.35))],
        'sit_think':[(1,dict(seat=1,lean=.07,gesture='chin')),(17,dict(seat=1,lean=.10,glance=.16,gesture='chin')),(33,dict(seat=1,lean=.07,gesture='chin'))],
        'sit_lean_back':[(1,dict(seat=1,lean=-.30,gesture='cross')),(17,dict(seat=1,lean=-.34,glance=-.12,gesture='cross')),(33,dict(seat=1,lean=-.30,gesture='cross'))],
        'head_in_hands':[(1,dict(seat=1,lean=.35,gesture='face')),(17,dict(seat=1,lean=.40,gesture='face')),(33,dict(seat=1,lean=.35,gesture='face'))],
        'hand_raise':[(1,dict(seat=1,lean=.03,right_arm=-.55)),(10,dict(seat=1,lean=.03,gesture='raise')),(18,dict(seat=1,lean=.05,gesture='waiting_tap')),(33,dict(seat=1,lean=.05,gesture='waiting'))],
        'sit_celebrate':[(1,dict(seat=1)),(10,dict(seat=1,lean=-.08,gesture='cheer')),
                         (18,dict(seat=1,lean=-.03,gesture='cheer')),(33,dict(seat=1))],
        'stand_idle':[(1,dict()),(17,dict(lean=.025,leg=.035)),(33,dict())],
        'stand_talk':[(1,dict()),(13,dict(right_arm=-.55,glance=.12)),(25,dict(left_arm=-.38,glance=-.10)),(33,dict())],
        'window_gaze':[(1,dict(lean=.03)),(17,dict(lean=.05,glance=.12)),(33,dict(lean=.03))],
        'hold_folder':[(1,dict(left_arm=-.75,right_arm=-.70)),(17,dict(left_arm=-.78,right_arm=-.72)),(33,dict(left_arm=-.75,right_arm=-.70))],
        'hand_over':[(1,dict(right_arm=-.60)),(12,dict(right_arm=-1.12,lean=.08)),(24,dict(right_arm=-1.10)),(33,dict(right_arm=-.60))],
        'receive':[(1,dict(left_arm=-.30)),(12,dict(left_arm=-.85,lean=.06)),(24,dict(left_arm=-.80)),(33,dict(left_arm=-.30))],
    }
    for name in ('walk','walk_folder'):
        clips[name]=[(1+i*3,dict(phase=math.sin(i*math.pi/4),gait=i/8,
                    gesture='carry' if name=='walk_folder' else '')) for i in range(9)]
    # A 1.3 s loop with one blink repeats unnaturally. Repeat the original body
    # cadence for about five seconds and place two unevenly spaced blinks in it.
    one_shot={'stand_up','sit_down','hand_raise','sit_celebrate'}
    for name,frames in list(clips.items()):
        if name in one_shot:continue
        duration=frames[-1][0]-frames[0][0]
        repeats=math.ceil(120/duration)
        clips[name]=[(frame+cycle*duration,kw)
                     for cycle in range(repeats)
                     for frame,kw in frames[:-1]]+[(1+repeats*duration,frames[0][1])]
    arm.animation_data_create()
    face=bpy.data.objects.get('BODY_ATLAS')
    keys=face.data.shape_keys if face else None
    if keys:keys.animation_data_create()
    for name,frames in clips.items():
        action=bpy.data.actions.new(name)
        action.use_fake_user=True
        arm.animation_data.action=action
        for f,kw in frames:pose(f,**kw)
        if keys:
            keys.animation_data.action=action
            blink=keys.key_blocks['eyeBlink']
            mouth=keys.key_blocks['mouthOpen']
            start,end=frames[0][0],frames[-1][0]
            if name in one_shot:
                center=round(start+(end-start)*(.48+(len(name)%5)*.06))
                blink_keys=((start,0),(center-2,0),(center,1),(center+2,0),(end,0))
            else:
                first=46+(len(name)%4)*3
                second=103+(len(name)%4)*3
                blink_keys=((start,0),(first-2,0),(first,1),(first+2,0),
                            (second-2,0),(second,1),(second+2,0),(end,0))
            for f,value in blink_keys:
                blink.value=value;blink.keyframe_insert('value',frame=f,group='Face')
            if name in ('stand_talk','sofa_talk'):
                period=32
                mouth_keys=[(start,0)]
                for cycle in range(math.ceil((end-start)/period)):
                    mouth_keys += [(f+cycle*period,value) for f,value in
                                   ((8,.72),(13,0),(18,.95),(23,.1),(28,.65),(33,0))
                                   if f+cycle*period<end]
                mouth_keys.append((end,0))
                for f,value in mouth_keys:
                    mouth.value=value;mouth.keyframe_insert('value',frame=f,group='Face')
            else:
                for f in (start,end):
                    mouth.value=0;mouth.keyframe_insert('value',frame=f,group='Face')
        # Stash an NLA strip so glTF sees every clip on this rig.
        track=arm.animation_data.nla_tracks.new();track.name=name
        strip=track.strips.new(name,1,action)
        strip.mute=False
        if keys:
            face_track=keys.animation_data.nla_tracks.new();face_track.name=name
            face_strip=face_track.strips.new(name,1,action)
            face_strip.action_slot=keys.animation_data.action_slot
            face_strip.mute=False
    arm.animation_data.action=None
    if keys:keys.animation_data.action=None


if __name__=='__main__':
    mode=sys.argv[sys.argv.index('--')+1] if '--' in sys.argv else 'room'
    if mode=='room':build_room()
    elif mode=='workstations':build_workstation_kit()
    elif mode=='kit':
        from character_detail import build_character_kit
        build_character_kit()
    elif mode=='appearance':
        from character_detail import build_appearance_kit
        build_appearance_kit()
    elif mode=='people':
        from character_detail import build_detailed_person
        for i in range(13):build_detailed_person(i)
    elif mode=='person':
        from character_detail import build_detailed_person
        build_detailed_person(int(sys.argv[sys.argv.index('--')+2])-1)
    else:raise SystemExit(f'unknown mode {mode}')
