#!/usr/bin/env python3
"""Compose a review image from actual SVG renders and native icon exports."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root=Path(__file__).resolve().parent.parent
previews=root/'previews'
font_path='/System/Library/Fonts/Helvetica.ttc'
label=ImageFont.truetype(font_path,23)
small=ImageFont.truetype(font_path,18)
canvas=Image.new('RGB',(1600,1120),'#F4F5F6')
draw=ImageDraw.Draw(canvas)


def paste(name,box):
    im=Image.open(root/name).convert('RGBA')
    im.thumbnail((box[2],box[3]),Image.Resampling.LANCZOS)
    canvas.paste(im,(box[0],box[1]),im)


draw.text((60,40),'AMPLEFILE  /  BRAND SOURCE PACK',fill='#16202B',font=label)
draw.text((60,112),'FLAT VECTOR MASTER',fill='#536171',font=small)
draw.text((610,112),'NATIVE DEFAULT',fill='#536171',font=small)
draw.text((1090,112),'NATIVE DARK',fill='#536171',font=small)
paste('previews/amplefile-mark.png',(35,150,450,450))
paste('AmpleFile-macOS-1024.png',(590,160,355,355))
paste('previews/AmpleFile-macOS-Dark.png',(1070,160,355,355))

draw.text((60,640),'OUTLINED LOCKUP',fill='#536171',font=small)
paste('previews/amplefile-lockup.png',(44,685,820,200))

for i,name in enumerate(['ClearLight','ClearDark','TintedLight','TintedDark']):
    x=930+(i%2)*290
    y=610+(i//2)*235
    paste(f'previews/AmpleFile-macOS-{name}.png',(x,y,165,165))
    draw.text((x,y+178),name,fill='#536171',font=small)

draw.text((60,939),'SMALL MARK  16 / 20 / 24 / 32px',fill='#536171',font=small)
base=Image.open(previews/'amplefile-mark-small.png').convert('RGBA')
for i,size in enumerate([16,20,24,32]):
    im=base.resize((size,size),Image.Resampling.LANCZOS)
    canvas.paste(im,(70+i*100,990),im)
draw.text((490,939),'MENU BAR  18 / 36px',fill='#536171',font=small)
for i,size in enumerate([18,36]):
    name='amplefile-menubar.png' if size==18 else 'amplefile-menubar-36.png'
    im=Image.open(previews/name).convert('RGBA')
    canvas.paste(im,(500+i*110,990),im)

canvas.save(previews/'brand-overview.png')

sheet=Image.new('RGB',(1500,350),'#E6EAF0')
draw=ImageDraw.Draw(sheet)
for i,name in enumerate(['Default','Dark','ClearLight','ClearDark','TintedLight','TintedDark']):
    path=root/'AmpleFile-macOS-1024.png' if name=='Default' else previews/f'AmpleFile-macOS-{name}.png'
    im=Image.open(path).convert('RGBA')
    im.thumbnail((230,230),Image.Resampling.LANCZOS)
    x=10+i*250
    sheet.paste(im,(x,65),im)
    draw.text((x+8,23),name,fill='#16202B',font=small)
sheet.save(previews/'native-appearances-contact-sheet.png')
print('Created final review sheets from verified assets.')
