import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Exercise the installed electron-builder helper's actual .icon compilation
// path without building, signing, installing, or publishing an application.
const require = createRequire(import.meta.url);
const { generateAssetCatalogForIcon } = require('app-builder-lib/out/util/macosIconComposer.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = join(root, 'verification', 'compiled');
const packageRoot = join(root, 'AmpleFile.icon');
async function packageHash() {
  const digest = createHash('sha256');
  const names = (await readdir(packageRoot, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(packageRoot.length + 1))
    .sort();
  for (const name of names) {
    digest.update(name);
    digest.update(Buffer.from([0]));
    digest.update(await readFile(join(packageRoot, name)));
  }
  return digest.digest('hex');
}
const sourceBefore = await packageHash();
await mkdir(compiled, { recursive: true });
const { assetCatalog, icnsFile } = await generateAssetCatalogForIcon(join(root, 'AmpleFile.icon'));
const sourceAfter = await packageHash();
if (sourceBefore !== sourceAfter) throw new Error('Icon source changed during compilation');
await writeFile(join(compiled, 'Assets.car'), assetCatalog);
await writeFile(join(compiled, 'Icon.icns'), icnsFile);
const hash = data => createHash('sha256').update(data).digest('hex');
const report = {
  passed: true,
  method: 'Installed electron-builder generateAssetCatalogForIcon helper',
  electronBuilderVersion: require('app-builder-lib/package.json').version,
  xcodeVersion: execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).trim(),
  sourceIconJsonSha256: hash(await readFile(join(root, 'AmpleFile.icon', 'icon.json'))),
  sourcePackageSha256: sourceAfter,
  outputs: [
    { file: 'verification/compiled/Assets.car', bytes: assetCatalog.length, sha256: hash(assetCatalog) },
    { file: 'verification/compiled/Icon.icns', bytes: icnsFile.length, sha256: hash(icnsFile) },
  ],
};
await writeFile(join(root, 'verification', 'compiler-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
