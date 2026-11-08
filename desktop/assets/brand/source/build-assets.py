#!/usr/bin/env python3
"""Rebuild AmpleFile's flat, editable SVG masters. No installed font is used."""
from __future__ import annotations

import json
from pathlib import Path
from html import escape

import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.recordingPen import DecomposingRecordingPen, replayRecording
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen

SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parent
FONT = SOURCE / 'PlusJakartaSans[wght].ttf'
FRONT = '#EFCB7E'
BACK = '#D4A14F'
INK = '#16202B'
BLUE = '#1F63D6'
LIGHT = '#F4F5F6'

# Centered 904 x 640 silhouette. Minimum artboard clearance is exactly 60px.
BACK_D = ('M140 192H366C403 192 416 206 434 232L454 260'
          'C466 276 480 284 502 284H884C928.183 284 964 319.817 964 364'
          'V752C964 796.183 928.183 832 884 832H140'
          'C95.817 832 60 796.183 60 752V272'
          'C60 227.817 95.817 192 140 192Z')
FRONT_D = ('M140 336H884C928.183 336 964 371.817 964 416'
           'V752C964 796.183 928.183 832 884 832H140'
           'C95.817 832 60 796.183 60 752V416'
           'C60 371.817 95.817 336 140 336Z')
DOT = (760, 656, 80)


def number(value):
    return f'{value:.5f}'.rstrip('0').rstrip('.') if isinstance(value, float) else str(value)


def svg(width, height, contents, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{number(width)}" '
            f'height="{number(height)}" viewBox="0 0 {number(width)} {number(height)}" '
            f'role="img" aria-label="{escape(title)}">\n{contents}\n</svg>\n')


def mark_contents(transform=None):
    parts = [f'<path id="folder-back" fill="{BACK}" d="{BACK_D}"/>',
             f'<path id="folder-front" fill="{FRONT}" d="{FRONT_D}"/>',
             f'<circle id="dot" fill="{BLUE}" cx="760" cy="656" r="80"/>']
    content = '\n'.join(parts)
    return f'<g transform="{transform}">\n{content}\n</g>' if transform else content


def contours(recording):
    result, current = [], []
    for operation in recording:
        if operation[0] == 'moveTo' and current:
            result.append(current)
            current = []
        current.append(operation)
        if operation[0] in ('closePath', 'endPath'):
            result.append(current)
            current = []
    if current:
        result.append(current)
    return result


def contour_bounds(recording, glyph_set):
    pen = BoundsPen(glyph_set)
    replayRecording(recording, pen)
    return pen.bounds


def outlined_text(text, weight, cap_height, dot_id=None):
    """Shape with HarfBuzz, draw instantiated font paths, and replace i's dot."""
    font = instantiateVariableFont(TTFont(FONT), {'wght': weight}, inplace=False)
    glyph_set = font.getGlyphSet()
    glyph_names = font.getGlyphOrder()
    hb_font = hb.Font(hb.Face(FONT.read_bytes()))
    hb_font.scale = (font['head'].unitsPerEm, font['head'].unitsPerEm)
    hb_font.set_variations({'wght': weight})
    buffer = hb.Buffer()
    buffer.add_str(text)
    buffer.guess_segment_properties()
    hb.shape(hb_font, buffer, {'kern': True, 'liga': False})
    scale = cap_height / font['OS/2'].sCapHeight
    glyphs, dots, x, y = [], [], 0, 0
    aggregate = BoundsPen(glyph_set)
    for index, (info, pos) in enumerate(zip(buffer.glyph_infos, buffer.glyph_positions)):
        name = glyph_names[info.codepoint]
        recording = DecomposingRecordingPen(glyph_set)
        glyph_set[name].draw(recording)
        parts = contours(recording.value)
        if dot_id and name == font.getBestCmap()[ord('i')]:
            # Jakarta's 150-unit square tittle is replaced by a true circle.
            highest = max(parts, key=lambda p: contour_bounds(p, glyph_set)[3])
            x0, y0, x1, y1 = contour_bounds(highest, glyph_set)
            dots.append(((x + pos.x_offset + (x0+x1)/2)*scale,
                         -(y + pos.y_offset + (y0+y1)/2)*scale,
                         (x1-x0)*scale/2))
            parts.remove(highest)
        pen = SVGPathPen(glyph_set)
        transform = (scale, 0, 0, -scale,
                     (x + pos.x_offset)*scale, -(y + pos.y_offset)*scale)
        for part in parts:
            replayRecording(part, TransformPen(pen, transform))
            replayRecording(part, TransformPen(aggregate, transform))
        glyphs.append((index, name, pen.getCommands()))
        x += pos.x_advance
        y += pos.y_advance
    bounds = list(aggregate.bounds)
    for cx, cy, radius in dots:
        bounds[0] = min(bounds[0], cx-radius)
        bounds[1] = min(bounds[1], cy-radius)
        bounds[2] = max(bounds[2], cx+radius)
        bounds[3] = max(bounds[3], cy+radius)
    return glyphs, dots, bounds


def place_text(data, x, y, fill=INK, dot_id=None, prefix='letter'):
    glyphs, dots, bounds = data
    tx, ty = x-bounds[0], y-bounds[1]
    paths = '\n'.join(f'<path id="{prefix}-{i}-{escape(name)}" d="{d}"/>'
                      for i, name, d in glyphs)
    pieces = [f'<g fill="{fill}" transform="translate({number(tx)} {number(ty)})">\n{paths}\n</g>']
    for cx, cy, radius in dots:
        pieces.append(f'<circle id="{dot_id}" fill="{BLUE}" '
                      f'cx="{number(cx+tx)}" cy="{number(cy+ty)}" r="{number(radius)}"/>')
    return '\n'.join(pieces)


def write(name, contents):
    (ROOT / name).write_text(contents, encoding='utf-8')


write('amplefile-mark.svg', svg(1024, 1024, mark_contents(), 'AmpleFile folder and Signal Blue dot'))

small = ('<path id="folder-back" fill="'+BACK+'" d="M5 6H11Q12 6 13 7L14 8Q15 9 16 9H27Q30 9 30 12V23Q30 26 27 26H5Q2 26 2 23V9Q2 6 5 6Z"/>\n'
         '<path id="folder-front" fill="'+FRONT+'" d="M5 11H27Q30 11 30 14V23Q30 26 27 26H5Q2 26 2 23V14Q2 11 5 11Z"/>\n'
         '<circle id="dot" fill="'+BLUE+'" cx="24" cy="20" r="3"/>')
write('amplefile-mark-small.svg', svg(32, 32, small, 'AmpleFile optically compensated small mark'))

# One shared outer outline, one pocket-rim segment, one independent pulse target.
menubar = ('<path id="folder-back" d="M3.25 3.75H6.25C6.7 3.75 6.95 3.9 7.25 4.3L8.05 5.35'
           'C8.25 5.65 8.5 5.75 8.9 5.75H14.75C15.5784 5.75 16.25 6.4216 16.25 7.25V13.25'
           'C16.25 14.0784 15.5784 14.75 14.75 14.75H3.25C2.4216 14.75 1.75 14.0784 1.75 13.25V5.25'
           'C1.75 4.4216 2.4216 3.75 3.25 3.75Z" fill="none" stroke="#000000" stroke-width="1.5" stroke-linejoin="round"/>\n'
           '<path id="folder-front" d="M2 7.25H16" fill="none" stroke="#000000" stroke-width="1.5" stroke-linecap="round"/>\n'
           '<circle id="dot" fill="#000000" cx="12.5" cy="11.25" r="1.25"/>')
write('amplefile-menubar.svg', svg(18, 18, menubar, 'AmpleFile menu-bar template'))

wordmark = outlined_text('AmpleFile', 800, 192, dot_id='dot')
_, _, bounds = wordmark
word_width, word_height = bounds[2]-bounds[0], bounds[3]-bounds[1]
write('amplefile-wordmark.svg', svg(word_width+48, word_height+48,
      place_text(wordmark, 24, 24, dot_id='dot'), 'AmpleFile outlined wordmark'))

# The folder's 192px height equals the cap height; its center sits a little below
# the cap center for optical balance against the lowercase body and p descender.
mark_width, mark_height, gap, pad = 271.2, 192, 56, 28
mark_scale = mark_width/904
mark_y = 28 + 10
mark_transform = f'translate({number(pad-60*mark_scale)} {number(mark_y-192*mark_scale)}) scale({number(mark_scale)})'
text_x = pad+mark_width+gap
lock_width, lock_height = text_x+word_width+pad, word_height+56
lockup = mark_contents(mark_transform)+'\n'+place_text(wordmark,text_x,28,dot_id='wordmark-dot',prefix='wordmark-letter')
write('amplefile-lockup.svg', svg(lock_width, lock_height, lockup, 'AmpleFile horizontal lockup'))

# Four full-canvas vector sources for Icon Composer. The background layer's
# Dark and Mono colors are native Icon Composer appearance annotations.
layers = SOURCE / 'icon-layers'
layers.mkdir(exist_ok=True)
(layers / 'Background.svg').write_text(svg(1024,1024,
    f'<rect id="background" fill="{LIGHT}" width="1024" height="1024"/>', 'Background'),encoding='utf-8')
composition = json.loads((SOURCE / 'icon-composition.json').read_text(encoding='utf-8'))
icon_dot = composition['dot']
for name, content in [
    ('Folder Back', f'<path id="folder-back" fill="{BACK}" d="{composition["folderBackPath"]}"/>'),
    ('Folder Front', f'<path id="folder-front" fill="{FRONT}" d="{composition["folderFrontPath"]}"/>'),
    ('Dot', f'<circle id="dot" fill="{BLUE}" cx="{icon_dot["cx"]}" cy="{icon_dot["cy"]}" r="{icon_dot["r"]}"/>'),
]:
    (layers / f'{name}.svg').write_text(svg(1024,1024,
        content, name),encoding='utf-8')

# Social image is fully vector-originated, including its lettering.
share_scale = 890/lock_width
share_lockup = f'<g transform="translate(155 {number(250-lock_height*share_scale/2)}) scale({number(share_scale)})">{lockup}</g>'
tag = outlined_text('A smart file explorer.',600,28)
tag_width = tag[2][2]-tag[2][0]
domain = outlined_text('amplefile.com',500,19)
domain_width = domain[2][2]-domain[2][0]
share = (f'<rect id="background" fill="{LIGHT}" width="1200" height="630"/>\n'+share_lockup+'\n'
         +place_text(tag,(1200-tag_width)/2,355,prefix='tagline-letter')+'\n'
         +place_text(domain,(1200-domain_width)/2,548,prefix='domain-letter'))
(SOURCE / 'amplefile-share.svg').write_text(svg(1200,630,share,'AmpleFile — A smart file explorer.'),encoding='utf-8')

(SOURCE / 'design-spec.json').write_text(json.dumps({
    'brand':'AmpleFile','colors':{'Manila':FRONT,'Manila Deep':BACK,'Ink':INK,'Signal Blue':BLUE,'Light background':LIGHT},
    'mark':{'canvas':[1024,1024],'bounds':[60,192,964,832],'dot':{'cx':760,'cy':656,'r':80}},
    'smallMark':{'canvas':[32,32],'bounds':[2,6,30,26],'dot':{'cx':24,'cy':20,'r':3}},
    'menuBar':{'canvas':[18,18],'outline':1.5,'dot':{'cx':12.5,'cy':11.25,'r':1.25}},
    'wordmark':{'font':'Plus Jakarta Sans','weight':800,'outlines':True,'kerning':'HarfBuzz','blueDot':'independent circle replacing i tittle'},
    'icon':{'canvas':[1024,1024],'approvedStudy':composition['approvedStudy'],
            'compositionSource':'icon-composition.json','placement':composition['placement'],
            'dot':icon_dot,'layers':['Background','Folder Back','Folder Front','Dot'],
            'target':'macOS','designGeneration':26},
},indent=2)+'\n',encoding='utf-8')
print('Created five flat SVG masters, four Icon Composer layers, outlined share artwork, and design specification.')
