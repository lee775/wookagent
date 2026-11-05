import bpy
for name in ('export_animation_mode','export_merge_animation'):
 p=bpy.ops.export_scene.gltf.get_rna_type().properties[name]
 print(name,[(x.identifier,x.name) for x in p.enum_items])
