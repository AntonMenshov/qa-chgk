import time
import tracemalloc

import pytest

from chgk.logos import open_logo, pale
from chgk.svg import CUT_FROM, check_svg, render_svg

NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'


def svg(body: str, view_box: str = "0 0 200 100") -> str:
    return f'<svg {NS} viewBox="{view_box}">{body}</svg>'


SQUARE = '<rect x="10" y="10" width="80" height="80" fill="#888"/>'
NAME = '<text x="100" y="80" font-family="{family}" font-weight="bold" font-size="30">ФИАСКО</text>'


def test_a_square_svg_is_not_cut():
    image = render_svg(svg(SQUARE, "0 0 100 100"), 600)
    assert image.size == (600, 600) and CUT_FROM not in image.info


@pytest.mark.parametrize("view_box", ["0 0 200 100", "0 0 100 400"])
def test_a_non_square_svg_is_cut_to_a_square_of_its_shorter_side(view_box):
    image = render_svg(svg(SQUARE, view_box), 600)
    assert image.size == (600, 600) and CUT_FROM in image.info


def test_the_cut_follows_the_drawing_and_keeps_it_whole():
    off_centre = '<rect x="150" y="10" width="40" height="80" fill="#888"/>'  # at the right of a 200×100 canvas
    image = render_svg(svg(off_centre, "0 0 200 100"), 100)
    box = image.getchannel("A").getbbox()
    assert box == (50, 10, 90, 90)  # the square was centred on the rectangle's x 150–190 and clamped to the canvas


def test_a_drawing_wider_than_the_square_is_cut_around_its_centre():
    wide = '<rect x="0" y="10" width="200" height="80" fill="#888"/>'
    image = render_svg(svg(wide, "0 0 200 100"), 100)
    assert image.getchannel("A").getbbox() == (0, 10, 100, 90)


def test_an_empty_non_square_svg_is_still_square():
    assert render_svg(svg("", "0 0 200 100"), 100).size == (100, 100)


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


def test_a_very_tall_svg_is_refused_before_it_is_drawn():
    with pytest.raises(ValueError, match="long and narrow"):
        render_svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 100000"/>', 300)


def test_width_and_height_decide_the_size_not_the_viewbox():
    with pytest.raises(ValueError, match="long and narrow"):
        render_svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="10" height="2000"/>', 300)
    image = render_svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="20" height="100"/>', 300)
    assert max(image.size) == 300


@pytest.mark.parametrize(
    "size", ['width="100mm" height="100mm"', 'width="1in" height="1in"', 'width="72pt" height="72pt"']
)
def test_physical_units_are_drawn(size):
    text = f'<svg {NS} {size} viewBox="0 0 100 100">{SQUARE}</svg>'
    assert render_svg(text, 300).size == (300, 300)


@pytest.mark.parametrize("size", ['width="1em" height="1000em"', 'width="100%" height="100000%"'])
def test_a_size_that_cant_be_read_is_refused_before_drawing(size):
    with pytest.raises(ValueError, match="can't be read"):
        render_svg(f'<svg {NS} {size} viewBox="0 0 1 1"/>', 300)


def test_an_exponent_counts_for_the_shape():
    with pytest.raises(ValueError, match="long and narrow"):
        render_svg(f'<svg {NS} width="1e0" height="1e4"/>', 300)


def test_an_endless_size_is_refused():
    with pytest.raises(ValueError, match="endless"):
        render_svg(f'<svg {NS} viewBox="0 0 inf inf"/>', 300)


def test_import_in_capitals_is_refused():
    with pytest.raises(ValueError, match="@import"):
        render_svg(svg('<style>@IMPORT "x.css";</style>'), 300)


def test_the_standard_doctype_is_accepted_but_nothing_defined_in_it():
    head = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'
    assert render_svg(head + svg(SQUARE, "0 0 100 100"), 100).size == (100, 100)
    for bad in ('<!DOCTYPE svg [<!ENTITY x "y">]>', """<!DOCTYPE svg SYSTEM "a>b" [<!ELEMENT svg ANY>]>"""):
        with pytest.raises(ValueError, match="DOCTYPE"):
            render_svg(bad + svg(SQUARE), 100)


@pytest.mark.parametrize("opening", ["<!DOCTYPE " + "a" * 1_900_000, "<!DOCTYPE " * 190_000])
def test_a_crafted_doctype_costs_neither_memory_nor_time(opening):
    start = time.monotonic()
    tracemalloc.start()
    with pytest.raises(ValueError):
        check_svg(opening)
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    assert peak < 50_000_000 and time.monotonic() - start < 5


def test_an_entity_is_refused_whatever_its_form():
    with pytest.raises(ValueError, match="DOCTYPE"):
        check_svg('<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>')


def test_the_words_in_a_comment_are_harmless():
    check_svg('<svg xmlns="http://www.w3.org/2000/svg"><!-- <!ENTITY x "y"> --></svg>')
