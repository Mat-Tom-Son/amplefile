#!/usr/bin/env python3
"""Export all six native macOS appearances with Apple's Icon Composer tool."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parent.parent
tool = Path('/Applications/Icon Composer.app/Contents/Executables/ictool')
if not tool.exists():
    tool = Path('/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool')

exports = []
for appearance in ['Default','Dark','ClearLight','ClearDark','TintedLight','TintedDark']:
    output = root / 'AmpleFile-macOS-1024.png' if appearance == 'Default' else root / 'previews' / f'AmpleFile-macOS-{appearance}.png'
    command = [str(tool),str(root/'AmpleFile.icon'),'--export-image','--output-file',str(output),
               '--platform','macOS','--rendition',appearance,'--width','1024','--height','1024',
               '--scale','1','--design-generation','26']
    if appearance.startswith('Tinted'):
        command += ['--tint-color','0.6','--tint-strength','0.75']
    result = subprocess.run(command,capture_output=True,text=True,check=True)
    exports.append({'appearance':appearance,'file':str(output.relative_to(root)),
                    'command':command,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
                    'exitCode':result.returncode})
    print(f'{appearance}: {output.name}',flush=True)

icon_files = sorted(p for p in (root/'AmpleFile.icon').rglob('*') if p.is_file())
source_digest = hashlib.sha256()
for p in icon_files:
    source_digest.update(str(p.relative_to(root/'AmpleFile.icon')).encode()+b'\0'+p.read_bytes())
report = {'tool':str(tool),'toolVersion':json.loads(subprocess.check_output([str(tool),'--version'],text=True)),
          'platform':'macOS','designGeneration':26,'sourcePackageSha256':source_digest.hexdigest(),'exports':exports}
(root/'verification'/'native-exports.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
