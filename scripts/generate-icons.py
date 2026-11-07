"""Draws the plugin's icons. Run with: python scripts/generate-icons.py (needs Pillow)."""
from pathlib import Path

from PIL import Image, ImageDraw

IMAGES = Path(__file__).parent.parent / "com.lee-cleobury.pc-stats.sdPlugin" / "imgs"
CANVAS = 1024

# Chip outline and pins, then three rising bars, in a 1024-unit square.
CHIP = (232, 232, 792, 792)
CHIP_RADIUS = 84
CHIP_STROKE = 56
PIN_POSITIONS = (360, 512, 664)
PIN_LENGTH = 92
PIN_WIDTH = 56
BARS = ((352, 616, 448, 680), (464, 472, 560, 680), (576, 344, 672, 680))
BAR_RADIUS = 20

SIZES = {
	"plugin/marketplace.png": 288,
	"plugin/marketplace@2x.png": 512,
	"plugin/category-icon.png": 28,
	"plugin/category-icon@2x.png": 56,
	"actions/counter/key.png": 72,
	"actions/counter/key@2x.png": 144,
	"actions/counter/icon.png": 20,
	"actions/counter/icon@2x.png": 40,
}


def draw_logo() -> Image.Image:
	"""White mark on transparency, matching Stream Deck's own icons."""
	mask = Image.new("L", (CANVAS, CANVAS), 0)
	draw = ImageDraw.Draw(mask)
	draw.rounded_rectangle(CHIP, CHIP_RADIUS, outline=255, width=CHIP_STROKE)
	left, top, right, bottom = CHIP
	half = PIN_WIDTH / 2
	for position in PIN_POSITIONS:
		draw.rounded_rectangle((position - half, top - PIN_LENGTH, position + half, top), half, fill=255)
		draw.rounded_rectangle((position - half, bottom, position + half, bottom + PIN_LENGTH), half, fill=255)
		draw.rounded_rectangle((left - PIN_LENGTH, position - half, left, position + half), half, fill=255)
		draw.rounded_rectangle((right, position - half, right + PIN_LENGTH, position + half), half, fill=255)
	for bar in BARS:
		draw.rounded_rectangle(bar, BAR_RADIUS, fill=255)

	logo = Image.new("RGBA", (CANVAS, CANVAS), (255, 255, 255, 0))
	logo.putalpha(mask)
	return logo


def main() -> None:
	# Trim the margin so the mark stays legible at 20px.
	logo = draw_logo().crop((116, 116, 908, 908))
	for relative_path, size in SIZES.items():
		path = IMAGES / relative_path
		path.parent.mkdir(parents=True, exist_ok=True)
		logo.resize((size, size), Image.Resampling.LANCZOS).save(path)


if __name__ == "__main__":
	main()
