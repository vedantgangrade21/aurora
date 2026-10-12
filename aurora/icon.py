"""The Aurora mark.

Drawn at runtime rather than shipped as a binary blob, then written out once as
.ico and .png so Windows, the tray and the web UI can all share one artwork.
"""
from pathlib import Path

from PIL import Image, ImageDraw

ASSETS = Path(__file__).resolve().parent.parent / "assets"
ICO_PATH = ASSETS / "aurora.ico"
PNG_PATH = ASSETS / "aurora.png"

# Windows picks the nearest of these for the taskbar, alt-tab, title bar and
# Explorer, so the small ones matter as much as the big one.
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48),
             (64, 64), (128, 128), (256, 256)]

TOP = (124, 92, 255)       # violet
BOTTOM = (255, 92, 138)    # pink
LABEL = (10, 10, 16, 235)

SUPERSAMPLE = 4


def render(size: int = 256) -> Image.Image:
    """A vinyl-ish disc: violet-to-pink wash, dark label, punched spindle hole."""
    dim = size * SUPERSAMPLE
    img = Image.new("RGBA", (dim, dim), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    for y in range(dim):
        blend = y / max(1, dim - 1)
        colour = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * blend) for i in range(3))
        draw.line([(0, y), (dim, y)], fill=colour + (255,))

    mask = Image.new("L", (dim, dim), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, dim - 1, dim - 1], fill=255)
    img.putalpha(mask)

    draw = ImageDraw.Draw(img)
    pad = dim * 0.34
    draw.ellipse([pad, pad, dim - pad, dim - pad], fill=LABEL)
    hole = dim * 0.455
    draw.ellipse([hole, hole, dim - hole, dim - hole], fill=(0, 0, 0, 0))

    return img.resize((size, size), Image.LANCZOS)


def ensure_files(force: bool = False):
    """Write assets/aurora.ico and .png if they are not already there."""
    ASSETS.mkdir(parents=True, exist_ok=True)
    if force or not (ICO_PATH.exists() and PNG_PATH.exists()):
        master = render(256)
        master.save(PNG_PATH, format="PNG")
        master.save(ICO_PATH, format="ICO", sizes=ICO_SIZES)
    return ICO_PATH, PNG_PATH


if __name__ == "__main__":
    ico, png = ensure_files(force=True)
    print("wrote", ico)
    print("wrote", png)
