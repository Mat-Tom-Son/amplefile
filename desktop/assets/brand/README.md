# AmpleFile brand sources

The **Manila** brand: a manila folder with one Signal dot, which
stands for the Worker. These files are the only source of the mark. Every
installed icon, the menu-bar template, the favicons, the Chrome extension
icons, the installer background, and the in-app lockups are generated from
them; nothing else in the repository carries its own copy.

## Colors

| Name | Value | Where |
| --- | --- | --- |
| Manila | `#EFCB7E` | folder front |
| Manila Deep | `#D4A14F` | folder back |
| Ink | `#16202B` | lettering; the Dark icon field |
| Signal Blue | `#1F63D6` | the folder dot and the i's tittle |
| Light | `#F4F5F6` | the Default icon field; the installer and share image |

Every SVG uses these flat fills only: no gradients, shadows, filters, raster
images, or embedded fonts. The lighting in the macOS icon comes from Apple's
renderer.

## Designer files

- `amplefile-mark.svg`: the full-color mark on a 1024 x 1024 artboard. Three
  shapes: `folder-back`, `folder-front`, and `dot`.
- `amplefile-mark-small.svg`: the mark redrawn on a 32 x 32 grid for 16–32 px,
  with a taller tab and a larger dot.
- `amplefile-menubar.svg`: the black 18 x 18 menu-bar template, a 1.5-unit
  folder outline with a separate filled `dot`.
- `amplefile-wordmark.svg`: "AmpleFile" in Plus Jakarta Sans ExtraBold,
  outlined, with the i's tittle as a Signal Blue circle.
- `amplefile-lockup.svg`: the mark and the Ink wordmark as one image.
- `AmpleFile.icon`: the macOS app icon, an Icon Composer document with the
  layers Background, Folder Back, Folder Front, and Dot, a Default look on
  Light and a Dark look on Ink.
- `AmpleFile-macOS-1024.png`: Icon Composer's Default export.
- `amplefile-share-1200x630.png`: the link-preview image for amplefile.com.
- `source/`: the designer's build scripts, geometry, the share image's
  vector source, and Plus Jakarta Sans under its SIL Open Font License
  (`source/OFL.txt`). The SVGs above are the editable artwork; the scripts
  only reproduce them.

## Generated here

- `AmpleFile.iconset/`: Apple's own renderings of `AmpleFile.icon` at every
  macOS size, so the 16 and 32 px icons are drawn small rather than shrunk.
  Refresh them, and `AmpleFile-macOS-1024.png`, after changing the `.icon`
  (needs Icon Composer):

  ```
  npm run brand:icon
  ```

- `amplefile-lockup-dark.svg`: the lockup with Light lettering for dark
  themes.
- `png/amplefile-mark-<size>.png`: the flat mark at 16–1024 px, from the
  small master up to 32 px and the full master above.

`npm run desktop:icons` writes those two, and installs into `desktop/assets/`:
`icon.icns` (from the iconset), `icon.png` (the 1024 px Default), `icon.ico`
and `icon-32.png` (the flat mark), `iconTemplate.png` and `@2x` (the menu-bar
icon), and `iconTemplateWorking1–5.png` and `@2x` (the frames in which the
dot fades while work is running). It also refreshes the favicon data URIs in
`web-local/index.html` and `popover.html`, and draws the installer background.
`tests/amplefile-brand.test.ts` checks that every output still matches these
sources.

The packaged app does not ship this folder; electron-builder leaves out
`brand/` when it copies `desktop/assets`.
