import pytest

from chgk.logos import open_logo, pale
from chgk.svg import check_svg, render_svg

NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'


def svg(body: str, view_box: str = "0 0 200 100") -> str:
    return f'<svg {NS} viewBox="{view_box}">{body}</svg>'


SQUARE = '<rect x="10" y="10" width="80" height="80" fill="#888"/>'
NAME = '<text x="100" y="80" font-family="{family}" font-weight="bold" font-size="30">ФИАСКО</text>'


def test_render_keeps_aspect_and_fits_the_longer_side():
    assert render_svg(svg(SQUARE), 600).size == (600, 300)
    assert render_svg(svg(SQUARE, "0 0 100 400"), 600).size == (150, 600)


def test_svg_becomes_a_pale_logo_like_a_png(tmp_path):
    (tmp_path / "logo.svg").write_text(svg(SQUARE), encoding="utf-8")
    out = pale(open_logo(tmp_path / "logo.svg"), 0.1)
    assert out.mode == "L"
    darkest, lightest = out.getextrema()
    assert abs(darkest - round(255 * 0.9)) <= 1
    assert lightest == 255  # the transparent background is white


@pytest.mark.parametrize("family", ["PT Sans", "Helvetica", "Arial, sans-serif", "NoSuchFont"])
def test_text_is_always_set_in_pt_sans(family):
    """No system fonts: whatever font the file names, the lettering is PT Sans, the same everywhere."""
    reference = render_svg(svg(NAME.format(family="PT Sans")), 400)
    image = render_svg(svg(NAME.format(family=family)), 400)
    assert image.getbbox() is not None  # the text is drawn, not dropped
    assert image.tobytes() == reference.tobytes()


@pytest.mark.parametrize(
    "body",
    [
        "<script>alert(1)</script>",
        '<rect width="10" height="10" onclick="alert(1)"/>',
        '<image href="file:///etc/passwd" width="10" height="10"/>',
        '<image xlink:href="https://example.com/a.png" width="10" height="10"/>',
        '<use href="other.svg#owl"/>',
        '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
        '<rect width="10" height="10" fill="url(https://example.com/p.svg#g)"/>',
        '<rect width="10" height="10" style="fill: url(\'/tmp/p.svg#g\')"/>',
        "<style>@import url(https://example.com/a.css);</style>",
        "<style>rect { fill: url(http://example.com/x.svg#p) }</style>",
    ],
)
def test_unsafe_svgs_are_refused(body):
    with pytest.raises(ValueError, match="refused"):
        check_svg(svg(body))


def test_entities_are_refused():
    text = f'<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg {NS}><text>&a;</text></svg>'
    with pytest.raises(ValueError, match="DOCTYPE"):
        check_svg(text)


@pytest.mark.parametrize(
    "body",
    [
        '<defs><linearGradient id="g"/></defs><rect width="10" height="10" fill="url(#g)"/>',
        '<defs><path id="p" d="M0 0h5v5z"/></defs><use href="#p"/><use xlink:href="#p"/>',
        "<style>rect { fill: #ccc }</style>",
        '<image href="data:image/png;base64,iVBORw0KGgo=" width="1" height="1"/>',
        "<text>url(see the card) onclick</text>",
    ],
)
def test_plain_drawing_is_accepted(body):
    check_svg(svg(body))


@pytest.mark.parametrize("text", ["<svg", "<html/>", "not xml at all"])
def test_not_an_svg(text):
    with pytest.raises(ValueError):
        check_svg(text)


def test_broken_svg_file_is_a_value_error(tmp_path):
    (tmp_path / "bad.svg").write_bytes(b"\xff\xfe<svg")
    with pytest.raises(ValueError):
        open_logo(tmp_path / "bad.svg")
