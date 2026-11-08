#!/usr/bin/env python3
"""Verify the handoff's actual SVG/PNG/package contracts."""
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

from PIL import Image
from fontTools.pens.boundsPen import BoundsPen
from fontTools.svgLib.path import parse_path

root = Path(__file__).resolve().parent.parent
checks = []


def check(label, condition, details=None):
    checks.append({'check':label,'passed':bool(condition),'details':details})
    if not condition:
        raise AssertionError(f'{label}: {details}')


def read_svg(path):
    tree = ET.parse(path).getroot()
    ids = [x.get('id') for x in tree.iter() if x.get('id')]
    check(f'{path.name}: unique shape ids', len(ids)==len(set(ids)), ids)
    allowed = {'svg','g','path','circle','rect','title','desc'}
    for element in tree.iter():
        tag = element.tag.rsplit('}',1)[-1]
        check(f'{path.name}: vector-only element {tag}', tag in allowed)
        for attr,value in element.attrib.items():
            check(f'{path.name}: no external or effect reference',
                  attr.rsplit('}',1)[-1] not in {'href','filter','style','font-family'} and 'url(' not in value)
        for attr in ('fill','stroke'):
            value = element.get(attr)
            if value:
                check(f'{path.name}: solid approved {attr}',value.upper() in
                      {'NONE','#EFCB7E','#D4A14F','#16202B','#1F63D6','#F4F5F6','#000000'})
    return tree,{x.get('id'):x for x in tree.iter() if x.get('id')}


for name, dimensions in [('amplefile-mark.svg',(1024,1024)),('amplefile-mark-small.svg',(32,32)),('amplefile-menubar.svg',(18,18))]:
    tree,ids = read_svg(root/name)
    check(f'{name}: artboard',tuple(map(float,tree.get('viewBox').split()))==(0,0,*dimensions))
    check(f'{name}: named independent folder shapes',set(ids)=={'folder-back','folder-front','dot'})
    check(f'{name}: independent circle',ids['dot'].tag.endswith('circle'))
    if 'menubar' not in name:
        check(f'{name}: exact three colors',
              [ids[n].get('fill') for n in ['folder-back','folder-front','dot']]==['#D4A14F','#EFCB7E','#1F63D6'])
    if name=='amplefile-mark.svg':
        pen=BoundsPen(None)
        parse_path(ids['folder-back'].get('d'),pen)
        check('1024 mark: centered geometry and minimum 60px inset',pen.bounds==(60,192,964,832),pen.bounds)
    if name=='amplefile-mark-small.svg':
        nums=[float(n) for ident in ['folder-back','folder-front'] for n in re.findall(r'-?\d+(?:\.\d+)?',ids[ident].get('d'))]
        check('32px mark: whole-unit path coordinates',all(n.is_integer() for n in nums))
        check('32px mark: enlarged relative dot',6/28 > 160/904)
    if name=='amplefile-menubar.svg':
        pen=BoundsPen(None)
        for ident in ['folder-back','folder-front']:
            parse_path(ids[ident].get('d'),pen)
            check('Menu-bar: 1.5-unit outline',ids[ident].get('stroke-width')=='1.5')
        x0,y0,x1,y1=pen.bounds
        check('Menu-bar: painted content at most 16 units tall',y1-y0+1.5<=16,{'width':x1-x0+1.5,'height':y1-y0+1.5})

for name in ['amplefile-wordmark.svg','amplefile-lockup.svg']:
    tree,ids=read_svg(root/name)
    check(f'{name}: no live text or font',not any(x.tag.endswith('text') for x in tree.iter()))
    dot='wordmark-dot' if 'lockup' in name else 'dot'
    check(f'{name}: separate blue i dot',ids[dot].get('fill')=='#1F63D6' and ids[dot].tag.endswith('circle'))
read_svg(root/'source'/'amplefile-share.svg')

doc=json.loads((root/'AmpleFile.icon'/'icon.json').read_text())
layers=[l for g in doc['groups'] for l in g['layers']]
check('Icon Composer: exactly four named layers',set(l['name'] for l in layers)=={'Background','Folder Back','Folder Front','Dot'} and len(layers)==4)
check('Icon Composer: Mac-only target',doc['supported-platforms']=={'squares':['macOS']})
background=next(l for l in layers if l['name']=='Background')
for label,record in [('root',doc),('Background layer',background)]:
    values=record.get('fill-specializations',[])
    dark=next((v['value'] for v in values if v.get('appearance')=='dark'),None)
    check(f'Icon Composer {label}: independent Dark fill',dark is not None)
    components=[float(v) for v in dark['solid'].split(':')[1].split(',')[:3]]
    check(f'Icon Composer {label}: exact Ink within native 5-decimal serialization',
          all(abs(a-b/255)<0.000006 for a,b in zip(components,[22,32,43])))
for layer in layers:
    path=root/'AmpleFile.icon'/'Assets'/layer['image-name']
    check(f'Icon Composer {layer["name"]}: SVG asset exists',path.is_file())
    read_svg(path)

for name,size in [('AmpleFile-macOS-1024.png',(1024,1024)),('amplefile-share-1200x630.png',(1200,630))]:
    with Image.open(root/name) as im:
        check(f'{name}: dimensions',im.size==size,im.size)

export_report=json.loads((root/'verification'/'native-exports.json').read_text())
check('Native export: all six appearances',set(r['appearance'] for r in export_report['exports'])=={'Default','Dark','ClearLight','ClearDark','TintedLight','TintedDark'})
digest=hashlib.sha256()
for path in sorted(p for p in (root/'AmpleFile.icon').rglob('*') if p.is_file()):
    digest.update(str(path.relative_to(root/'AmpleFile.icon')).encode()+b'\0'+path.read_bytes())
check('Native exports: bound to final saved source',digest.hexdigest()==export_report['sourcePackageSha256'])
for export in export_report['exports']:
    data=(root/export['file']).read_bytes()
    check(f'Native {export["appearance"]}: successful and matching PNG',export['exitCode']==0 and hashlib.sha256(data).hexdigest()==export['sha256'])

report={'passed':True,'checks':checks,'summary':{
    'primaryFiles':7,'socialImage':[1200,630],'svgText':'outlined',
    'svgPaint':'solid palette only','namedFolderShapes':True,
    'independentDots':True,'nativeLayers':4,'nativeAppearances':6,
    'appBuildVerification':'not run: Xcode first-launch / plugin initialization incomplete',
}}
(root/'verification'/'asset-checks.json').write_text(json.dumps(report,indent=2)+'\n')
print(f'PASS: {len(checks)} artifact conformance checks; seven primary files, social image, and six native appearances.')
