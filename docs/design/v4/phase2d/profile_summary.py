"""Resolve Chrome CPU samples through the web build's source maps."""
import bisect
import json
from pathlib import Path

alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
def values(segment):
    value=shift=0
    for char in segment:
        digit=alphabet.index(char);value+=(digit&31)<<shift
        if digit&32:shift+=5
        else:
            yield -(value>>1) if value&1 else value>>1
            value=shift=0

def mappings(path):
    data=json.loads(path.read_text(encoding='utf-8'));source=line=column=name=0;result=[]
    for generated_line in data['mappings'].split(';'):
        generated_column=0;entries=[]
        for segment in generated_line.split(','):
            delta=list(values(segment));
            if not delta:continue
            generated_column+=delta[0]
            if len(delta)<4:continue
            source+=delta[1];line+=delta[2];column+=delta[3]
            if len(delta)>4:name+=delta[4]
            entries.append((generated_column,data['sources'][source],line+1,column+1))
        result.append(entries)
    return result

profile=json.loads(Path('docs/design/v4/phase2d/walking.cpuprofile').read_text())
cache={};nodes={node['id']:node['callFrame'] for node in profile['nodes']};counts={}
for sample,delta in zip(profile['samples'],profile['timeDeltas']):
    node=nodes[sample];url=node['url'];location=''
    if '/assets/' in url:
        path=Path('out/web/assets')/(url.split('/')[-1]+'.map')
        if path.exists():
            if path.name not in cache:cache[path.name]=mappings(path)
            entries=cache[path.name][node['lineNumber']]
            index=bisect.bisect_right([entry[0] for entry in entries],node['columnNumber'])-1
            if index>=0:location=':'.join(map(str,entries[index][1:]))
    key=(node['functionName'],location)
    counts[key]=counts.get(key,0)+delta
print('\n'.join(str((round(value/1000,1),*key)) for key,value in sorted(counts.items(),key=lambda item:-item[1])[:40]))
