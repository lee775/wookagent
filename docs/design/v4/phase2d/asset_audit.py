"""Audit the actual shipped GLBs, including total bytes and the shared rig contract."""
import hashlib
import json
import struct
from pathlib import Path

root=Path('src/renderer/public/studio3d');assets=[]
for path in sorted(root.glob('*.glb')):
    data=path.read_bytes()
    assert data[:4]==b'glTF' and struct.unpack_from('<I',data,8)[0]==len(data)
    assert not path.name.startswith('person_') and '.tmp.' not in path.name
    document=json.loads(data[20:20+struct.unpack_from('<I',data,12)[0]])
    skins=document.get('skins',[]);animations=document.get('animations',[])
    if path.name.startswith('kit_'):
        assert len(skins)==1 and len(skins[0]['joints'])==17 and len(animations)==26
    assets.append({'file':path.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),
        'skinnedNodes':sum('skin' in node for node in document.get('nodes',[])),
        'animations':len(animations),'jointCounts':[len(skin['joints']) for skin in skins],
        'modules':[node['name'] for node in document.get('nodes',[]) if node.get('children') and node.get('name')]})
result={'totalBytes':sum(asset['bytes'] for asset in assets),'budgetBytes':15_000_000,'assets':assets}
assert len(assets)==12 and result['totalBytes']<=result['budgetBytes']
Path('docs/design/v4/phase2d/asset-audit.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print('GLBs',len(assets),'bytes',result['totalBytes'])
