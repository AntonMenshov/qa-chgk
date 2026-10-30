import pytest
from PIL import Image, ImageDraw

from chgk.logos import load_pale_logo, pale


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
    assert darkest >= round(255 * (1 - grey)) - 1
    assert darkest <= round(255 * (1 - grey)) + 1  # full range used: black part hits the limit
    assert lightest == 255


def test_transparent_background_becomes_white():
    out = pale(sample_logo("RGBA"), 0.1)
    assert out.getpixel((2, 2)) == 255
    assert out.getpixel((95, 40)) < 255


def test_size_and_aspect_preserved():
    assert pale(sample_logo(size=(300, 100)), 0.03).size == (300, 100)


def test_faint_source_is_stretched():
    faint = Image.new("L", (10, 10), 250)
    faint.putpixel((0, 0), 230)
    out = pale(faint, 0.2)
    assert out.getextrema() == (round(255 - 255 * 0.2), 255)


@pytest.mark.parametrize("grey", [0, -0.1, 1.5])
def test_invalid_grey(grey):
    with pytest.raises(ValueError):
        pale(sample_logo(), grey)


def test_load_png_and_reject_svg(tmp_path):
    sample_logo().save(tmp_path / "logo.png")
    assert load_pale_logo(tmp_path / "logo.png", 0.03).mode == "L"
    (tmp_path / "logo.svg").write_text("<svg/>")
    with pytest.raises(ValueError, match="SVG"):
        load_pale_logo(tmp_path / "logo.svg", 0.03)


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
    assert load_pale_logo(tmp_path / "big.png", 0.03).size == (600, 300)


def test_fallback_owl_ships_with_the_repo():
    from chgk.logos import LOGO_LIBRARY

    assert (LOGO_LIBRARY / "nologo.png").is_file()
