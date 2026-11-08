#!/usr/bin/env python3
"""Apply restrained native material and appearance annotations to the .icon."""
import json
import shutil
from pathlib import Path

root = Path(__file__).resolve().parent.parent
package = root / 'AmpleFile.icon'
(package / 'Assets').mkdir(exist_ok=True)


def color(hex_value):
    values = [int(hex_value[i:i+2],16)/255 for i in (1,3,5)]
    return 'srgb:'+','.join(f'{v:.7f}' for v in values)+',1.0000000'


light, ink = color('#F4F5F6'), color('#16202B')
groups = []
# Icon Composer serializes its visual layer list from front to back.
for name in ['Dot','Folder Front','Folder Back','Background']:
    shutil.copy2(root / 'source' / 'icon-layers' / f'{name}.svg', package / 'Assets' / f'{name}.svg')
    layer = {'image-name':f'{name}.svg','name':name,'glass':name.startswith('Folder')}
    if name == 'Background':
        layer['fill-specializations'] = [
            {'value':{'solid':light}},
            {'appearance':'dark','value':{'solid':ink}},
        ]
    group = {
        'name':name,
        'layers':[layer],
        'lighting':'individual',
        'specular':False,
        'blur-material':0,
        'translucency':{'enabled':False,'value':0},
        'shadow':{'kind':'neutral' if name.startswith('Folder') else 'none',
                  'opacity':0.12 if name == 'Folder Front' else 0.08 if name == 'Folder Back' else 0},
    }
    groups.append(group)

doc = {
    'fill-specializations':[
        {'value':{'solid':light}},
        {'appearance':'dark','value':{'solid':ink}},
    ],
    'groups':groups,
    'supported-platforms':{'squares':['macOS']},
}
(package / 'icon.json').write_text(json.dumps(doc,indent=2)+'\n',encoding='utf-8')
print('Configured four independent layers, light Default and Ink Dark backgrounds, and restrained native material for macOS export.')
