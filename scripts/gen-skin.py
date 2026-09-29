import os
import random
from PIL import Image

random.seed(7)
img = Image.new('RGBA', (64, 64), (0, 0, 0, 0))
px = img.load()


def rect(x, y, w, h, col, jitter=6):
    for i in range(x, x + w):
        for j in range(y, y + h):
            d = random.randint(-jitter, jitter)
            px[i, j] = tuple(max(0, min(255, c + d)) for c in col[:3]) + (255,)


SKIN = (224, 172, 138)
HAIR = (46, 20, 72)
HOOD = (109, 40, 217)
HOOD2 = (88, 28, 186)
PINK = (236, 72, 153)
PANTS = (30, 18, 52)
SHOE = (14, 8, 24)
WHITE = (245, 240, 255)
EYE = (124, 58, 237)

for (x, y) in [(8, 0), (16, 0), (0, 8), (8, 8), (16, 8), (24, 8)]:
    rect(x, y, 8, 8, SKIN)
rect(8, 0, 8, 8, HAIR)
rect(24, 8, 8, 8, HAIR)
for (x, y) in [(0, 8), (16, 8)]:
    rect(x, y, 8, 3, HAIR)
rect(8, 8, 8, 2, HAIR)
rect(8, 10, 1, 1, HAIR)
rect(15, 10, 1, 1, HAIR)
px[9, 12] = WHITE + (255,)
px[10, 12] = EYE + (255,)
px[13, 12] = EYE + (255,)
px[14, 12] = WHITE + (255,)
rect(11, 14, 2, 1, (170, 110, 90), 0)

for (x, y, w, h) in [(20, 16, 8, 4), (28, 16, 8, 4), (16, 20, 4, 12), (20, 20, 8, 12), (28, 20, 4, 12), (32, 20, 8, 12)]:
    rect(x, y, w, h, HOOD)
rect(20, 30, 8, 2, HOOD2)
for k in range(4):
    px[21 + k, 22 + k] = PINK + (255,)
    px[26 - k, 22 + k] = PINK + (255,)

for (bx, by) in [(40, 16), (32, 48)]:
    for (x, y, w, h) in [(bx + 4, by, 4, 4), (bx + 8, by, 4, 4), (bx, by + 4, 4, 12), (bx + 4, by + 4, 4, 12), (bx + 8, by + 4, 4, 12), (bx + 12, by + 4, 4, 12)]:
        rect(x, y, w, h, HOOD)
    for x in (bx, bx + 4, bx + 8, bx + 12):
        rect(x, by + 13, 4, 1, PINK, 0)
        rect(x, by + 14, 4, 2, SKIN)
    rect(bx + 8, by, 4, 4, SKIN)

for (lx, ly) in [(0, 16), (16, 48)]:
    for (x, y, w, h) in [(lx + 4, ly, 4, 4), (lx + 8, ly, 4, 4), (lx, ly + 4, 4, 12), (lx + 4, ly + 4, 4, 12), (lx + 8, ly + 4, 4, 12), (lx + 12, ly + 4, 4, 12)]:
        rect(x, y, w, h, PANTS)
    rect(lx + 8, ly, 4, 4, SHOE)
    for x in (lx, lx + 4, lx + 8, lx + 12):
        rect(x, ly + 14, 4, 2, SHOE)

out = 'default-skin.png'
img.save(out)
print('ok')
