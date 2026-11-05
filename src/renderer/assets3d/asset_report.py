"""Run RevvyIDE's mesh_stats and asset QA against all meshes in an open .blend."""
import json
import pathlib
import sys
import bpy

ROOT = pathlib.Path('C:/Users/pc_09/AppData/Local/Temp/claude/C--WOOK-wookagent/7f7656cb-51f2-4626-b0fb-713c3230d9b4/scratchpad/revvy-skills')
sys.path.insert(0, str(ROOT/'blender-game-optimization'/'scripts'))
sys.path.insert(0, str(ROOT/'blender-asset-qa'/'scripts'))
import mesh_stats
import qa_check

objects = [o.name for o in bpy.data.objects if o.type == 'MESH']
stats = mesh_stats.run(objects=objects, budget='web')
report = {'file': bpy.data.filepath, 'objects': len(objects),
          'tris': stats['total_tris'], 'vertices': stats['total_verts'],
          'draw_calls_est': stats['draw_calls_est'], 'materials': stats['unique_materials'],
          'bones': stats['bones'], 'textures': stats['textures'], 'budget_over': stats['budget']['over']}
if 'person_' in bpy.data.filepath:
    qa = qa_check.run(objects=objects, profile='render')
    report['qa'] = {'pass': qa['pass'], 'errors': qa['errors'][:8], 'warnings': qa['warnings'][:8]}
print('ASSET_REPORT', json.dumps(report))
