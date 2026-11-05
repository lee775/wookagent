"""욱채 화면 색 검사: 거부된 참고 앱(크림·세이지·짙은 녹색)과 v2(보라·코발트)에서 충분히 멀어졌는지 잰다.

사용: python -I palette_gate.py <capture.png> [<capture.png> ...]
     python -I palette_gate.py --room <s04-studio-busy.png>   (나무·황갈 바닥 비율 검사 추가)

기준 (1440x900 캡처 s01-s08 각각):
  creamSage  : L* > 80 이면서 (b* > 3.5 또는 a* < -2) 인 픽셀 비율 < 10%
  refGreen   : #3e5546 과 dE76 < 10 인 픽셀 비율 < 1%
  violet     : 채도 C* > 20 이고 색상각 255-320도 인 픽셀 비율 < 0.5%
  --room     : #dcc39b 또는 #d8cfb4 와 dE76 < 10 인 픽셀 비율 < 3% (s04)
하나라도 넘으면 종료 코드 1.
"""
import sys
import math
from PIL import Image


def srgb_to_lab(r, g, b):
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = lin(r), lin(g), lin(b)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = (0.2126 * r + 0.7152 * g + 0.0722 * b)
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def hex_lab(h):
    h = h.lstrip('#')
    return srgb_to_lab(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


REF_GREEN = hex_lab('#3e5546')
WOOD = [hex_lab('#dcc39b'), hex_lab('#d8cfb4')]


def de(a, b):
    return math.sqrt(sum((p - q) ** 2 for p, q in zip(a, b)))


def measure(path, room=False):
    im = Image.open(path).convert('RGB')
    im.thumbnail((720, 720))
    counts = im.getcolors(maxcolors=720 * 720) or []
    total = sum(c for c, _ in counts) or 1
    cream = green = violet = wood = 0
    cache = {}
    for c, rgb in counts:
        lab = cache.get(rgb)
        if lab is None:
            lab = cache[rgb] = srgb_to_lab(*rgb)
        L, a, b = lab
        if L > 80 and (b > 3.5 or a < -2):
            cream += c
        if de(lab, REF_GREEN) < 10:
            green += c
        chroma = math.hypot(a, b)
        hue = (math.degrees(math.atan2(b, a)) + 360) % 360
        if chroma > 20 and 255 <= hue <= 320:
            violet += c
        if room and any(de(lab, w) < 10 for w in WOOD):
            wood += c
    r = {
        'creamSage': round(100 * cream / total, 2),
        'refGreen': round(100 * green / total, 2),
        'violet': round(100 * violet / total, 2),
    }
    if room:
        r['woodTan'] = round(100 * wood / total, 2)
    return r


LIMITS = {'creamSage': 10.0, 'refGreen': 1.0, 'violet': 0.5, 'woodTan': 3.0}


def main(argv):
    room = '--room' in argv
    paths = [p for p in argv if p != '--room']
    if not paths:
        print(__doc__)
        return 2
    failed = False
    for p in paths:
        r = measure(p, room=room)
        bad = [k for k, v in r.items() if v >= LIMITS[k]]
        failed |= bool(bad)
        print(f"{'FAIL' if bad else 'ok  '} {p}  " + '  '.join(f"{k}={v}%" for k, v in r.items()) + (f"  <- {', '.join(bad)}" if bad else ''))
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
