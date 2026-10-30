import pytest
from PIL import Image, ImageDraw

from chgk.config import CardFields, LogoMode
from chgk.logos import FALLBACK_KEY, TOURNAMENT_KEY, first_logo, logo_chain, open_logo, pale


def sample_logo(mode="RGB", size=(120, 80)) -> Image.Image:
    img = Image.new(mode, size, (255, 255, 255, 0) if mode == "RGBA" else "white")
    draw = ImageDraw.Draw(img)
    draw.ellipse((10, 10, 70, 70), fill=(200, 0, 0, 255) if mode == "RGBA" else (200, 0, 0))
    draw.rectangle((80, 20, 110, 60), fill=(0, 0, 0, 255) if mode == "RGBA" else (0, 0, 0))
    return img


@pytest.mark.parametrize("grey", [0.03, 0.08, 0.25])
def test_pale_is_greyscale_and_never_darker_than_requested(grey):
    out = pale(sample_logo(), grey)
    assert out.mode == "L"
    darkest, lightest = out.getextrema()
    limit = round(255 * (1 - grey))
    assert limit - 1 <= darkest <= limit + 1  # the dark parts reach the requested ink, never more
    assert lightest == 255


def test_transparent_background_becomes_white():
    out = pale(sample_logo("RGBA"), 0.1)
    assert out.getpixel((2, 2)) == 255
    assert out.getpixel((95, 40)) < 255


def test_size_and_aspect_preserved():
    assert pale(sample_logo(size=(300, 100)), 0.03).size == (300, 100)


def test_light_drawing_with_a_few_dark_pixels_still_reaches_the_shade():
    """The user's logos: mostly light grey (~200) with a handful of near-black pixels."""
    img = Image.new("L", (100, 100), 255)
    ImageDraw.Draw(img).rectangle((10, 10, 89, 89), fill=200)  # the drawing
    for i in range(5):
        img.putpixel((i, 0), 60)  # stray dark pixels
    out = pale(img, 0.2)
    assert out.getpixel((50, 50)) == round(255 - 255 * 0.2)  # the drawing itself gets the full 20%
    assert out.getpixel((0, 0)) == round(255 - 255 * 0.2)  # darker pixels are clamped
    assert out.getpixel((95, 95)) == 255


def test_blank_image_stays_white():
    assert pale(Image.new("RGBA", (10, 10), (0, 0, 0, 0)), 0.2).getextrema() == (255, 255)


@pytest.mark.parametrize("grey", [0, -0.1, 1.5])
def test_invalid_grey(grey):
    with pytest.raises(ValueError):
        pale(sample_logo(), grey)


def test_load_png_and_reject_svg(tmp_path):
    sample_logo().save(tmp_path / "logo.png")
    assert pale(open_logo(tmp_path / "logo.png"), 0.03).mode == "L"
    (tmp_path / "logo.svg").write_text("<svg/>")
    with pytest.raises(ValueError, match="SVG"):
        open_logo(tmp_path / "logo.svg")


def test_resolve_prefers_tournament_folder_then_library(tmp_path, monkeypatch):
    import chgk.logos as logos

    library = tmp_path / "library"
    folder = tmp_path / "tournament"
    library.mkdir()
    folder.mkdir()
    monkeypatch.setattr(logos, "LOGO_LIBRARY", library)
    sample_logo().save(library / "a.png")
    sample_logo().save(library / "b.png")
    sample_logo().save(folder / "b.png")
    assert logos.resolve_logo("a.png", folder) == library / "a.png"
    assert logos.resolve_logo("b.png", folder) == folder / "b.png"
    assert logos.resolve_logo("missing.png", folder) is None


def test_large_logos_are_downscaled(tmp_path):
    sample_logo(size=(2000, 1000)).save(tmp_path / "big.png")
    assert open_logo(tmp_path / "big.png").size == (600, 300)


def test_fallback_owl_ships_with_the_repo():
    from chgk.logos import LOGO_LIBRARY

    assert (LOGO_LIBRARY / "nologo.png").is_file()


@pytest.mark.parametrize(
    "mode,chain",
    [
        (LogoMode.NONE, []),
        (LogoMode.TEAM, ["A01", FALLBACK_KEY]),
        (LogoMode.TOURNAMENT, [TOURNAMENT_KEY, FALLBACK_KEY]),
        (LogoMode.TEAM_ELSE_TOURNAMENT, ["A01", TOURNAMENT_KEY, FALLBACK_KEY]),
    ],
)
def test_logo_chain_per_mode(mode, chain):
    fields = CardFields(logo=mode, tournament_logo="t.png")
    assert logo_chain(fields, "A01") == chain
    loaded = {FALLBACK_KEY: None, TOURNAMENT_KEY: None}  # A01's own logo missing
    assert first_logo(fields, "A01", loaded) == next((k for k in chain if k in loaded), None)
