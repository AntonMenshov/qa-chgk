import pytest
from conftest import TEAM_ROWS, write_teams_file
from PIL import Image, ImageDraw

from chgk.config import CardFields, LogoMode
from chgk.logos import FALLBACK_KEY, TOURNAMENT_KEY, first_logo, load_logos, logo_chain, open_logo, pale, resolve_logo
from chgk.teams import Team


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


def test_load_png_and_svg_refuse_unsafe_svg(tmp_path):
    sample_logo().save(tmp_path / "logo.png")
    assert pale(open_logo(tmp_path / "logo.png"), 0.03).mode == "L"
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20">{}</svg>'
    (tmp_path / "logo.svg").write_text(svg.format('<rect width="10" height="10"/>'))
    assert open_logo(tmp_path / "logo.svg").size == (600, 600)
    (tmp_path / "bad.svg").write_text(svg.format("<script>alert(1)</script>"))
    with pytest.raises(ValueError, match="refused"):
        open_logo(tmp_path / "bad.svg")


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


@pytest.mark.parametrize(
    "mode,loaded,expected",
    [
        (LogoMode.NONE, {"A01", "tournament", "fallback"}, None),
        (LogoMode.TEAM, {"A01", "fallback"}, "A01"),
        (LogoMode.TEAM, {"tournament", "fallback"}, "fallback"),  # TEAM mode ignores the tournament logo
        (LogoMode.TEAM, set(), None),
        (LogoMode.TOURNAMENT, {"A01", "tournament", "fallback"}, "tournament"),
        (LogoMode.TOURNAMENT, {"A01", "fallback"}, "fallback"),
        (LogoMode.TEAM_ELSE_TOURNAMENT, {"A01", "tournament", "fallback"}, "A01"),
        (LogoMode.TEAM_ELSE_TOURNAMENT, {"tournament", "fallback"}, "tournament"),
        (LogoMode.TEAM_ELSE_TOURNAMENT, {"fallback"}, "fallback"),
        (LogoMode.TEAM_ELSE_TOURNAMENT, {"A02"}, None),  # another team's logo is never used
    ],
)
def test_first_logo_follows_the_chain(mode, loaded, expected):
    fields = CardFields(logo=mode, tournament_logo="t.png")
    assert first_logo(fields, "A01", {key: Image.new("L", (1, 1)) for key in loaded}) == expected


def test_logo_report_says_what_each_team_shows(folder):
    from chgk.config import load_config
    from chgk.logos import logo_report
    from chgk.teams import read_teams

    (folder / "broken.png").write_bytes(b"not a png")
    write_teams_file(folder, [TEAM_ROWS[0], ("A02", "Вторые", "", "broken.png"), ("A03", "Третьи", "", "gone.png")])
    teams = read_teams(folder / "teams.py")
    fields = load_config(folder).card
    rows, warnings = logo_report(folder, fields, teams)
    assert [(r.team_id, r.problem and r.problem[:20], r.shown) for r in rows] == [
        ("A01", None, "own logo"),
        ("A02", "not a readable image", "tournament logo"),
        ("A03", "not found", "tournament logo"),
    ]
    assert len(warnings) == 2
    (folder / "t.png").unlink()  # no tournament logo either: the owl from the library
    rows, _ = logo_report(folder, fields, teams)
    assert [r.shown for r in rows] == ["own logo", "fallback logo", "fallback logo"]
    rows, _ = logo_report(folder, CardFields(logo=LogoMode.NONE), teams)
    assert {r.shown for r in rows} == {"no logo"}
    assert rows[0].problem is None  # the team's own logo is fine, the mode just doesn't show it


def test_a_damaged_png_is_a_warning_not_a_crash(tmp_path):
    path = tmp_path / "bad.png"
    Image.effect_noise((1000, 1000), 50).save(path)  # noise: several IDAT chunks
    data = bytearray(path.read_bytes())
    second = data.index(b"IDAT", data.index(b"IDAT") + 4)
    data[second - 4 : second + 4] = b"\xff" * 8  # a damaged chunk header: Pillow raises SyntaxError
    path.write_bytes(bytes(data))
    with pytest.raises(ValueError):
        open_logo(path)


def test_a_phone_photo_is_turned_upright(tmp_path):
    path = tmp_path / "photo.jpg"
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90°
    Image.new("RGB", (300, 100), "black").save(path, exif=exif)
    assert open_logo(path).size == (100, 300)


def test_a_palette_logo_is_shrunk_smoothly(tmp_path):
    path = tmp_path / "palette.png"
    image = Image.new("RGB", (1200, 1200), "white")
    ImageDraw.Draw(image).line((0, 0, 1199, 1199), fill="black", width=3)
    image.convert("P").save(path)
    logo = open_logo(path)
    assert logo.mode == "RGBA"
    assert len(logo.convert("L").getcolors(256)) > 2


def test_a_cut_svg_logo_is_reported(tmp_path):
    rect = '<rect width="9" height="9"/>'
    (tmp_path / "wide.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20">{rect}</svg>')
    (tmp_path / "square.svg").write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">{rect}</svg>')
    fields = CardFields(logo=LogoMode.TEAM, fallback_logo="square.svg")
    teams = [Team(team_id="A01", name="Синие зайцы", logo_file="wide.svg")]
    images, warnings = load_logos(tmp_path, fields, teams)
    assert images["A01"].size == (600, 600)
    assert len(warnings) == 1 and "'wide.svg' is not square" in warnings[0]


def test_a_logo_on_off_white_paper_keeps_its_drawing():
    scan = Image.new("RGB", (600, 600), (240, 240, 238))
    ImageDraw.Draw(scan).rectangle((200, 200, 400, 400), fill="black")
    printed = pale(scan, 0.14)
    assert printed.getpixel((10, 10)) == 255  # the paper is white
    assert printed.getpixel((300, 300)) == round(255 * (1 - 0.14))  # the drawing has the ink


def test_a_logo_that_would_print_nothing_is_refused(tmp_path):
    path = tmp_path / "white.png"
    circle = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
    ImageDraw.Draw(circle).ellipse((10, 10, 90, 90), fill="white")
    circle.save(path)
    with pytest.raises(ValueError, match="nothing would print"):
        open_logo(path)


def test_a_sliver_of_a_png_is_refused(tmp_path):
    path = tmp_path / "long.png"
    Image.new("L", (10000, 10)).save(path)
    with pytest.raises(ValueError, match="long and narrow"):
        open_logo(path)


def test_a_transparent_colour_leaves_no_halo_when_shrunk(tmp_path):
    path = tmp_path / "keyed.png"
    image = Image.new("RGB", (1200, 1200), (0, 0, 0))
    ImageDraw.Draw(image).ellipse((100, 100, 1100, 1100), fill=(128, 128, 128))
    image.save(path, transparency=(0, 0, 0))
    assert open_logo(path).mode == "RGBA"


def test_a_logo_name_cant_reach_outside_its_folders(tmp_path):
    (tmp_path / "secret.png").write_bytes(b"x")
    inner = tmp_path / "t"
    inner.mkdir()
    assert resolve_logo("../secret.png", inner) is None
    assert resolve_logo(str(tmp_path / "secret.png"), inner) is None
