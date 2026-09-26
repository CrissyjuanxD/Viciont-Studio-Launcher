# Genera los recursos gráficos del launcher a partir del logo de la web.
import os, sys, math
from PIL import Image, ImageDraw, ImageFilter, ImageFont

proj = sys.argv[1]
build = os.path.join(proj, 'build')
img_dir = os.path.join(proj, 'src', 'renderer', 'img')
icon = Image.open(os.path.join(build, 'icon.png')).convert('RGBA')

# Icono de Windows con todos los tamaños
icon.save(os.path.join(build, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
icon.resize((256, 256), Image.LANCZOS).save(os.path.join(img_dir, 'icon.png'))
icon.resize((32, 32), Image.LANCZOS).save(os.path.join(img_dir, 'favicon.png'))

emblem = Image.open(os.path.join(img_dir, 'emblem.webp')).convert('RGBA')
logo = Image.open(os.path.join(img_dir, 'logo-full.webp')).convert('RGBA')

def font(names, size):
    for n in names:
        p = os.path.join(os.environ.get('WINDIR', 'C:\\Windows'), 'Fonts', n)
        if os.path.exists(p):
            try:
                f = ImageFont.truetype(p, size)
                return f
            except Exception:
                pass
    return ImageFont.load_default()

def backdrop(w, h, seed=0):
    base = Image.new('RGB', (w, h), (6, 2, 12))
    glow = Image.new('RGB', (w, h), (0, 0, 0))
    d = ImageDraw.Draw(glow)
    # manchas moradas y rosas difuminadas (como la espiral de la web)
    for (cx, cy, r, col) in [(0.25, 0.22, 0.75, (124, 58, 237)), (0.85, 0.75, 0.7, (236, 72, 153)), (0.5, 0.5, 0.45, (168, 85, 247))]:
        R = int(r * max(w, h))
        d.ellipse([cx * w - R / 2, cy * h - R / 2, cx * w + R / 2, cy * h + R / 2], fill=col)
    glow = glow.filter(ImageFilter.GaussianBlur(max(w, h) * 0.18))
    out = Image.blend(base, glow, 0.36)
    vig = Image.new('L', (w, h), 0)
    ImageDraw.Draw(vig).ellipse([-w*0.25, -h*0.25, w*1.25, h*1.25], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(max(w, h)*0.12))
    out = Image.composite(out, Image.new('RGB', (w, h), (4, 1, 9)), vig)
    return out

def scanlines(im, alpha=18):
    ov = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for y in range(0, im.size[1], 3):
        d.line([(0, y), (im.size[0], y)], fill=(255, 255, 255, alpha))
    return Image.alpha_composite(im.convert('RGBA'), ov)

# Barra lateral del instalador NSIS (164 x 314, BMP)
w, h = 164, 314
side = scanlines(backdrop(w, h))
em = emblem.copy()
em.thumbnail((118, 118), Image.LANCZOS)
glow = Image.new('RGBA', side.size, (0, 0, 0, 0))
gx, gy = (w - em.width) // 2, 46
glow.paste((236, 72, 153, 255), (gx, gy), em)
glow = glow.filter(ImageFilter.GaussianBlur(9))
side = Image.alpha_composite(side, glow)
side.alpha_composite(em, (gx, gy))
d = ImageDraw.Draw(side)
f1 = font(['bahnschrift.ttf', 'segoeuib.ttf', 'arialbd.ttf'], 30)
f2 = font(['bahnschrift.ttf', 'segoeui.ttf', 'arial.ttf'], 13)
f3 = font(['consola.ttf', 'cour.ttf'], 11)
def center(text, y, f, fill):
    tw = d.textlength(text, font=f)
    d.text(((w - tw) / 2, y), text, font=f, fill=fill)
center('VICIONT', 182, f1, (255, 255, 255))
center('STUDIO', 212, f1, (240, 171, 252))
center('L A U N C H E R', 250, f2, (216, 180, 254))
center('by CrissyjuanxD', 288, f3, (155, 140, 186))
d.line([(34, 244), (130, 244)], fill=(236, 72, 153), width=1)
side.convert('RGB').save(os.path.join(build, 'installerSidebar.bmp'))
side.convert('RGB').save(os.path.join(build, 'uninstallerSidebar.bmp'))

# Imagen para el README / redes (1280 x 640)
W, H = 1280, 640
banner = scanlines(backdrop(W, H), 12)
lg = logo.copy()
lg.thumbnail((760, 340), Image.LANCZOS)
g2 = Image.new('RGBA', banner.size, (0, 0, 0, 0))
lx, ly = (W - lg.width) // 2, 150
g2.paste((168, 85, 247, 255), (lx, ly), lg)
g2 = g2.filter(ImageFilter.GaussianBlur(18))
banner = Image.alpha_composite(banner, g2)
banner.alpha_composite(lg, (lx, ly))
d = ImageDraw.Draw(banner)
fb = font(['bahnschrift.ttf', 'segoeuib.ttf'], 44)
text = 'L A U N C H E R'
tw = d.textlength(text, font=fb)
d.text(((W - tw) / 2, 505), text, font=fb, fill=(240, 171, 252))
banner.convert('RGB').save(os.path.join(proj, 'docs', 'banner.png'), optimize=True)
print('ok')
