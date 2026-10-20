"""Side-by-side Design-reference comparisons and colour statistics (Phase 3B evidence).

Usage: python scripts/compare-references.py
Reads Design/*.png and docs/evidence/phase3b/{before,after,renders}; writes
compare-references.png, compare-before-after.png, renders-contact-sheet.png and
colour-statistics.json into docs/evidence/phase3b/.
"""
import colorsys
import glob
import json
import os

from PIL import Image, ImageDraw

OUT = 'docs/evidence/phase3b'
refs = sorted(glob.glob('Design/*.png'))
renders = sorted(glob.glob(f'{OUT}/renders/*.png'))
W, H = 800, 450


def label(draw, xy, text):
    draw.text(xy, text, fill='white')


sheet = Image.new('RGB', (W * 2, H * len(refs)), 'black')
draw = ImageDraw.Draw(sheet)
for i, (ref, app) in enumerate(zip(refs, [f'{OUT}/renders/view-{v}-cinematic.png' for v in (0, 4, 5)])):
    sheet.paste(Image.open(ref).convert('RGB').resize((W, H)), (0, i * H))
    sheet.paste(Image.open(app).convert('RGB').resize((W, H)), (W, i * H))
    label(draw, (8, i * H + 8), 'DESIGN REFERENCE')
    label(draw, (W + 8, i * H + 8), 'APPLICATION (real capture)')
sheet.save(f'{OUT}/compare-references.png')

before = Image.open(f'{OUT}/before/view-0-balanced.png').convert('RGB').resize((W, 500))
after = Image.open(f'{OUT}/after/view-0-balanced.png').convert('RGB').resize((W, 500))
pair = Image.new('RGB', (W * 2, 500))
pair.paste(before, (0, 0)); pair.paste(after, (W, 0))
d = ImageDraw.Draw(pair)
label(d, (8, 8), 'BEFORE (Phase 3)'); label(d, (W + 8, 8), 'AFTER (Phase 3B gaseous)')
pair.save(f'{OUT}/compare-before-after.png')

thumbs = [Image.open(f).convert('RGB').resize((640, 360)) for f in renders]
contact = Image.new('RGB', (1280, 360 * ((len(thumbs) + 1) // 2)))
for i, t in enumerate(thumbs):
    contact.paste(t, ((i % 2) * 640, (i // 2) * 360))
contact.save(f'{OUT}/renders-contact-sheet.png')


def stats(path):
    im = Image.open(path).convert('RGB').resize((320, 180))
    hsv = [colorsys.rgb_to_hsv(*(c / 255 for c in im.getpixel((x, y)))) for y in range(180) for x in range(320)]
    n = len(hsv)
    return {
        'saturation': round(sum(h[1] for h in hsv) / n, 3),
        'value': round(sum(h[2] for h in hsv) / n, 3),
        'bright': round(sum(1 for h in hsv if h[2] > 0.85) / n, 3),
        'vividMagenta': round(sum(1 for h in hsv if 0.75 < h[0] < 0.95 and h[1] > 0.6 and h[2] > 0.5) / n, 3),
    }


result = {
    'method': '320x180 downsample; mean HSV saturation/value; bright = V>0.85; vividMagenta = hue 0.75-0.95, S>0.6, V>0.5',
    'references': {os.path.basename(f): stats(f) for f in refs},
    'application': {os.path.basename(f): stats(f) for f in renders},
}
with open(f'{OUT}/colour-statistics.json', 'w') as fh:
    json.dump(result, fh, indent=2)
for group in ('references', 'application'):
    for name, value in result[group].items():
        print(group[:3].upper(), name[-22:], value)
