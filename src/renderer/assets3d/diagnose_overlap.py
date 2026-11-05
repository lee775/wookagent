"""Print centres of coplanar triangles in a saved character for fixing QA findings."""
import pathlib
import sys

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

root=pathlib.Path(__file__).resolve().parent
index=int(sys.argv[sys.argv.index('--')+1])
bpy.ops.wm.open_mainfile(filepath=str(root/f'person_{index}.blend'))
obj=bpy.data.objects['BODY_ATLAS']
obj.data.calc_loop_triangles()
vertices=[obj.matrix_world@vertex.co for vertex in obj.data.vertices]
triangles=[tuple(triangle.vertices) for triangle in obj.data.loop_triangles]
normals=[Vector(t.normal) for t in obj.data.loop_triangles]
sets=[set(triangle) for triangle in triangles]
bvh=BVHTree.FromPolygons(vertices,triangles,epsilon=0)

def within(point,triangle,normal):
    a,b,c=(vertices[i] for i in triangle)
    for start,end in ((a,b),(b,c),(c,a)):
        if (end-start).cross(point-start).dot(normal)<-1e-6:return False
    return True

pairs=set()
for i,triangle in enumerate(triangles):
    a,b,c=(vertices[j] for j in triangle)
    center=(a+b+c)/3
    for point in (center,center.lerp(a,.6),center.lerp(b,.6),center.lerp(c,.6)):
        for _,_,j,_ in bvh.find_nearest_range(point,.001):
            if j is None or j==i or sets[i]&sets[j]:continue
            if normals[i].dot(normals[j])<.999:continue
            q=point-normals[j]*normals[j].dot(point-vertices[triangles[j][0]])
            if within(q,triangles[j],normals[j]):pairs.add((min(i,j),max(i,j)))
for i,j in sorted(pairs):
    a=sum((vertices[k] for k in triangles[i]),Vector())/3
    b=sum((vertices[k] for k in triangles[j]),Vector())/3
    print('OVERLAP',tuple(round(v,4) for v in a),tuple(round(v,4) for v in b))
