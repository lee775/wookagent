"""Verify the GLB contract shared with the Studio 3D runtime."""
from pathlib import Path
import json
import struct

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
ASSETS = ROOT / 'src/renderer/public/studio3d'
OUT = ROOT / 'docs/design/v4/phase2c/compatibility.json'
BONES = ['root', 'hips', 'spine', 'neck', 'head',
         'upper_arm.L', 'forearm.L', 'hand.L', 'upper_arm.R',
         'forearm.R', 'hand.R', 'thigh.L', 'shin.L', 'foot.L',
         'thigh.R', 'shin.R', 'foot.R']
CLIPS = ['sit_type', 'sit_idle', 'stand_up', 'sit_down', 'walk', 'walk_folder',
         'stand_drink', 'sofa_sit', 'sofa_talk', 'sit_draw', 'sit_check',
         'sit_write', 'sit_plan', 'sit_think', 'sit_lean_back',
         'head_in_hands', 'hand_raise', 'sit_celebrate', 'stand_idle',
         'stand_talk', 'window_gaze', 'hold_folder', 'hand_over', 'receive']


def glb(path):
    with path.open('rb') as handle:
        magic, version, length = struct.unpack('<4sII', handle.read(12))
        assert magic == b'glTF' and version == 2 and length == path.stat().st_size
        json_size, kind = struct.unpack('<II', handle.read(8))
        assert kind == 0x4e4f534a
        return json.loads(handle.read(json_size))


paths = [ASSETS / 'room.glb', ASSETS / 'chair_moving.glb'] + [
    ASSETS / f'person_{number}.glb' for number in range(1, 14)]
assert all(path.exists() for path in paths)
result = {'total_bytes': sum(path.stat().st_size for path in paths), 'files': {}}
assert result['total_bytes'] <= 15_000_000
for path in paths:
    data = glb(path)
    row = {'bytes': path.stat().st_size}
    if path.name.startswith('person_'):
        assert len(data['skins']) == 1
        names = [data['nodes'][index]['name'] for index in data['skins'][0]['joints']]
        assert names == BONES, (path.name, names)
        assert 'animations' in data, path.name
        clips = [animation['name'] for animation in data['animations']]
        assert clips == CLIPS, (path.name, clips)
        mesh = next(mesh for mesh in data['meshes'] if mesh.get('weights') == [0, 0])
        assert mesh['weights'] == [0, 0]
        assert all('JOINTS_1' not in primitive['attributes'] for primitive in mesh['primitives'])
        assert all('JOINTS_0' in primitive['attributes'] for primitive in mesh['primitives'])
        assert all(set(channel['target']['path'] for channel in animation['channels']) >=
                   {'rotation', 'weights'} for animation in data['animations'])
        durations = {}
        for animation in data['animations']:
            input_accessors = {animation['samplers'][channel['sampler']]['input']
                               for channel in animation['channels']}
            durations[animation['name']] = max(data['accessors'][index]['max'][0]
                                               for index in input_accessors)
        assert all(1.4 < durations[name] < 1.7 for name in ('stand_up', 'sit_down'))
        row.update(bones=names, clips=clips, clip_duration_seconds=durations,
                   morph_targets=list(mesh.get('extras', {}).get('targetNames', [])))
    result['files'][path.name] = row
OUT.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(f"Verified {len(paths)} files, {result['total_bytes']:,} bytes, 17 bones and 24 clips per person")
