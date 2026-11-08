import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const preview = join(root, 'previews');
await mkdir(preview, { recursive: true });
for (const [name, width] of [
  ['amplefile-mark', 600], ['amplefile-mark-small', 32],
  ['amplefile-menubar', 18], ['amplefile-wordmark', 1100],
  ['amplefile-lockup', 1250],
]) {
  await sharp(join(root, `${name}.svg`)).resize({ width }).png().toFile(join(preview, `${name}.png`));
}
await sharp(join(root, 'source', 'amplefile-share.svg')).png().toFile(join(root, 'amplefile-share-1200x630.png'));
await sharp(join(root, 'amplefile-menubar.svg')).resize(36, 36).png().toFile(join(preview, 'amplefile-menubar-36.png'));

const items = [];
const label = (text, x, y) => ({ input: Buffer.from(`<svg width="1400" height="1100"><text x="${x}" y="${y}" font-family="Arial,sans-serif" font-size="20" fill="#536171">${text}</text></svg>`), left: 0, top: 0 });
const render = async (name, width, left, top) => {
  items.push({ input: await sharp(join(root, name)).resize({ width }).png().toBuffer(), left, top });
};
items.push(label('FLAT VECTOR MASTER', 52, 52));
await render('amplefile-mark.svg', 510, 40, 55);
items.push(label('OUTLINED WORDMARK', 620, 86));
await render('amplefile-wordmark.svg', 700, 615, 115);
items.push(label('HORIZONTAL LOCKUP', 620, 380));
await render('amplefile-lockup.svg', 700, 615, 400);
items.push(label('OPTICAL SMALL MARK — ACTUAL PIXEL SIZES', 52, 635));
let x = 60;
for (const size of [16, 20, 24, 32]) {
  items.push({ input: await sharp(join(root, 'amplefile-mark-small.svg')).resize(size, size).png().toBuffer(), left: x, top: 673 });
  items.push(label(`${size}`, x, 742));
  x += 105;
}
items.push(label('MENU BAR — 18px AND 36px', 620, 635));
for (const [size, left] of [[18, 638], [36, 770]]) {
  items.push({ input: await sharp(join(root, 'amplefile-menubar.svg')).resize(size, size).png().toBuffer(), left, top: 673 });
}
items.push(label('SOCIAL SHARE IMAGE', 52, 827));
await render('amplefile-share-1200x630.png', 450, 60, 845);
await sharp({create:{width:1400,height:1100,channels:4,background:'#F4F5F6'}}).composite(items).png().toFile(join(preview, 'flat-assets-contact-sheet.png'));
console.log('Rendered flat artwork, small-size QA, and 1200 x 630 social image.');
