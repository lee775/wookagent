"""Verify shipped character cutouts and office illustration."""

from pathlib import Path
from PIL import Image

assets = Path(__file__).resolve().parents[1] / "src" / "assets"
characters = sorted((assets / "characters").glob("*-v1.webp"))
assert len(characters) == 17, f"Expected 17 characters, found {len(characters)}"

total = 0
for path in characters:
    with Image.open(path) as image:
        image.load()
        assert image.size == (512, 768), (path.name, image.size)
        assert image.mode == "RGBA", (path.name, image.mode)
        alpha = image.getchannel("A")
        assert alpha.getpixel((0, 0)) == 0, path.name
        assert alpha.getextrema()[1] >= 245, path.name
        bounds = alpha.point(lambda value: 255 if value > 24 else 0).getbbox()
        assert bounds is not None, path.name
        margins = (
            bounds[0] / image.width,
            bounds[1] / image.height,
            (image.width - bounds[2]) / image.width,
            (image.height - bounds[3]) / image.height,
        )
        assert min(margins) >= 0.08, (path.name, margins)
        print(f"{path.name}: {path.stat().st_size / 1024:.1f} KiB; min padding {min(margins):.1%}")
        total += path.stat().st_size

office = assets / "office-after-hours-v1.webp"
with Image.open(office) as image:
    image.load()
    assert image.size == (1672, 941), image.size
    print(f"{office.name}: {office.stat().st_size / 1024:.1f} KiB")
    total += office.stat().st_size

assert total < 8 * 1024 * 1024, total
print(f"Total art: {total / 1024 / 1024:.2f} MiB")
