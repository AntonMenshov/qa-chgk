"""Claude-drawn logos: the API request (mocked HTTP, never a real call), drafts, the brief, preview and accept."""

import base64
import io
import json
import os
import shutil
from dataclasses import replace

import anthropic
import httpx2
import pytest
from anthropic import DefaultHttpxClient
from conftest import LONG_NAME, runner
from PIL import Image
from pypdf import PdfReader

import chgk.logos as logos
from chgk import logo_drafts as drafts
from chgk.cards.build import build_logo_preview
from chgk.cli import app
from chgk.config import CardFields, Layout
from chgk.teams import read_teams

SECRET = "sk-ant-test-SECRET-never-printed"
OWL_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">'
    '<circle cx="500" cy="400" r="250" fill="#e0e0e0" stroke="#b0b0b0" stroke-width="8"/>'
    '<text x="500" y="900" font-family="PT Sans" font-weight="bold" font-size="120" text-anchor="middle" '
    'fill="#dedede" stroke="#a8a8a8">СИНИЕ</text></svg>'
)


@pytest.fixture(autouse=True)
def library(tmp_path, monkeypatch):
    """A logo library of our own (the fallback owl and one team logo), and no API key unless a test sets it."""
    lib = tmp_path / "library"
    lib.mkdir()
    shutil.copy(logos.LOGO_LIBRARY / "nologo.png", lib / "nologo.png")
    Image.new("RGBA", (300, 300), (120, 120, 120, 255)).save(lib / "other-team.png")
    monkeypatch.setattr(logos, "LOGO_LIBRARY", lib)
    monkeypatch.delenv(drafts.API_KEY_ENV, raising=False)
    return lib


def sse(text: str, stop_reason: str = "end_turn") -> str:
    """A streamed Messages API reply with one text block."""
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": drafts.MODEL,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 10, "output_tokens": 1},
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
            "usage": {"output_tokens": 1234},
        },
        {"type": "message_stop"},
    ]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)


def team_of(request) -> str:
    """The team a request is about: the «name» in its first user message."""
    first = json.loads(request.content)["messages"][0]["content"][-1]["text"]
    return first.split("Draw the logo of the team «", 1)[1].split("».\n", 1)[0]


def mock_client(replies, seen: list, api_key: str = SECRET) -> anthropic.Anthropic:
    """A real SDK client whose HTTP is answered from `replies`: SSE text or an httpx2.Response, in order.

    `replies` is one list, or a dict team name → list (teams are drawn in parallel).
    """

    def handler(request):
        seen.append(request)
        queue = replies[team_of(request)] if isinstance(replies, dict) else replies
        if not queue:
            error = {"type": "error", "error": {"type": "invalid_request_error", "message": "test: no reply left"}}
            return httpx2.Response(400, json=error)
        reply = queue.pop(0)
        if isinstance(reply, httpx2.Response):
            return reply
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, text=reply)

    transport = httpx2.MockTransport(handler)
    return anthropic.Anthropic(api_key=api_key, max_retries=0, http_client=DefaultHttpxClient(transport=transport))


def fenced(svg: str) -> str:
    return f"Here it is:\n```svg\n{svg}\n```\n"


# ---- the request and the reply ----


OWL_2 = OWL_SVG.replace('r="250"', 'r="240"')
OWL_3 = OWL_SVG.replace('r="250"', 'r="230"')
APPROVE = sse(drafts.APPROVED)


def body(request) -> dict:
    return json.loads(request.content)


def test_first_request_max_effort_opus_with_references():
    seen = []
    refs, warnings = drafts.reference_blocks(drafts.reference_logos())
    svg = drafts.draw_logo(mock_client([sse(fenced(OWL_SVG)), APPROVE], seen), "Синие зайцы", refs)
    assert svg == OWL_SVG and warnings == []
    first = body(seen[0])
    assert first["model"] == drafts.MODEL == "claude-opus-5-5"
    assert first["output_config"] == {"effort": "max", "task_budget": {"type": "tokens", "total": 100_000}}
    assert first["max_tokens"] > drafts.TASK_BUDGET  # room to finish the SVG within the hard limit
    assert drafts.TASK_BUDGET_BETA in seen[0].headers["anthropic-beta"]
    assert first["max_tokens"] == 128000
    assert first["stream"] is True and first["fallbacks"] == "default"
    assert first["cache_control"] == {"type": "ephemeral"}
    assert drafts.FALLBACK_BETA in seen[0].headers["anthropic-beta"]
    assert first["system"] == drafts.system_prompt(drafts.DEFAULT_LOOK)
    content = first["messages"][0]["content"]
    images = [block for block in content if block["type"] == "image"]
    assert len(images) == 2  # the owl and the other team's logo
    assert images[-1]["cache_control"] == {"type": "ephemeral"}  # the same for every team: cached
    assert "«Синие зайцы»" in content[-1]["text"] and "«СИНИЕ ЗАЙЦЫ»" in content[-1]["text"]
    assert drafts.style_rules("Синие зайцы") in content[-1]["text"]


def test_review_shows_the_rendering_back_in_the_same_conversation():
    seen = []
    look = replace(drafts.DEFAULT_LOOK, grey=0.1)
    drafts.draw_logo(mock_client([sse(fenced(OWL_SVG)), APPROVE], seen), "Синие зайцы", [], look)
    assert len(seen) == 2
    messages = body(seen[1])["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    assert OWL_SVG in messages[1]["content"][0]["text"]  # Claude's own reply, sent back unchanged
    review = messages[2]["content"]
    full, card = (Image.open(io.BytesIO(base64.b64decode(b["source"]["data"]))) for b in review[:2])
    assert full.size == (drafts.RENDER_SIDE, drafts.RENDER_SIDE)
    assert card.size == (drafts.CARD_SIDE, drafts.CARD_SIDE)
    assert card.convert("L").getextrema()[0] >= round(255 * 0.9) - 3  # pale (resampling may ring a little)
    assert "Review 1 of 2" in review[2]["text"] and "The ink spans x" in review[2]["text"]
    assert drafts.review_checklist("Синие зайцы") in review[2]["text"]


def test_the_system_text_follows_the_tournaments_card_settings():
    sized = drafts.logo_look(CardFields(logo_size=1.85, logo_grey=0.1), Layout())
    text = drafts.system_prompt(sized)
    assert "about 4.7 cm wide centred on the card" in text and "about 10% ink" in text
    assert "QR code covers the logo's top-right corner" in text
    default = drafts.system_prompt(drafts.logo_look(CardFields(), Layout()))  # logo_size None: the writing area
    assert "about 3.3 cm wide in the writing area" in default and "about 12% ink" in default
    assert "QR code sits above it" in default


def test_review_loop_revises_then_approves():
    seen, lines = [], []
    replies = [sse(fenced(OWL_SVG)), sse("Bigger owl.\n" + fenced(OWL_2)), APPROVE]
    svg = drafts.draw_logo(mock_client(replies, seen), "Синие зайцы", [], log=lines.append)
    assert svg == OWL_2
    assert [line.split(" (")[0] for line in lines] == ["drawn", "review 1: revised", "review 2: approved"]
    assert lines[0].endswith("min, 1.2k tokens out)")  # time and tokens of each round
    assert "Review 2 of 2" in body(seen[2])["messages"][-1]["content"][-1]["text"]


def test_review_rounds_are_capped():
    seen, lines = [], []
    replies = [sse(fenced(OWL_SVG)), sse(fenced(OWL_2)), sse(fenced(OWL_3))]
    svg = drafts.draw_logo(mock_client(replies, seen), "Синие зайцы", [], log=lines.append)
    assert svg == OWL_3 and len(seen) == 1 + drafts.REVIEW_ROUNDS
    assert [line.split(" (")[0] for line in lines] == ["drawn", "review 1: revised", "review 2: revised"]


def test_an_unusable_reply_goes_back_as_feedback():
    seen, lines = [], []
    unsafe = OWL_SVG.replace("<circle", "<script>x</script><circle")
    replies = [sse("Thinking about owls."), sse(fenced(unsafe)), sse(fenced(OWL_SVG))]
    svg = drafts.draw_logo(mock_client(replies, seen), "Синие зайцы", [], log=lines.append)
    assert svg == OWL_SVG
    assert lines[0].startswith("drawing: unusable (the reply has no SVG;")
    assert "refused" in lines[1]
    assert "can't be used: the reply has no SVG" in body(seen[1])["messages"][-1]["content"]


def test_only_a_plain_approved_counts_as_approval():
    seen = []
    replies = [sse(fenced(OWL_SVG)), sse("Not APPROVED yet: the name overflows."), sse(fenced(OWL_2))]
    assert drafts.draw_logo(mock_client(replies, seen), "Синие зайцы", []) == OWL_2
    assert len(seen) == 3  # the "Not APPROVED" reply was not taken as approval
    assert drafts.draw_logo(mock_client([sse(fenced(OWL_SVG)), sse(" Approved.\n")], []), "Синие зайцы", []) == OWL_SVG


def test_a_first_drawing_in_the_last_round_is_logged_as_not_reviewed():
    lines = []
    replies = [sse("no drawing"), sse("still none"), sse(fenced(OWL_SVG))]
    assert drafts.draw_logo(mock_client(replies, []), "Синие зайцы", [], log=lines.append) == OWL_SVG
    assert lines[-1].startswith("drawn (") and lines[-1].endswith(
        "not reviewed: unusable replies used up the review rounds"
    )


def test_approval_before_any_drawing_does_not_count():
    seen = []
    replies = [APPROVE, sse(fenced(OWL_SVG)), APPROVE]
    assert drafts.draw_logo(mock_client(replies, seen), "Синие зайцы", []) == OWL_SVG


@pytest.mark.parametrize(
    "reply,error",
    [
        (sse("I'd rather not."), "no SVG"),
        (sse(fenced(OWL_SVG.replace("<circle", "<script>x</script><circle"))), "refused"),
    ],
)
def test_no_usable_svg_in_any_round_is_a_value_error(reply, error):
    with pytest.raises(ValueError, match=error):
        drafts.draw_logo(mock_client([reply] * (drafts.REVIEW_ROUNDS + 1), []), "Синие зайцы", [])


@pytest.mark.parametrize(
    "reply,error",
    [
        (sse(fenced(OWL_SVG), stop_reason="refusal"), "declined"),
        (sse("```svg\n<svg xmlns=", stop_reason="max_tokens"), "cut off"),
    ],
)
def test_a_stopped_reply(reply, error):
    with pytest.raises(ValueError, match=error):
        drafts.draw_logo(mock_client([reply] * (1 + drafts.CUT_OFF_RETRIES), []), "Синие зайцы", [])
    lines = []
    svg = drafts.draw_logo(mock_client([sse(fenced(OWL_SVG)), reply], []), "Синие зайцы", [], log=lines.append)
    assert svg == OWL_SVG  # a stopped review keeps the drawing it had
    assert error in lines[-1]


def test_a_long_round_says_it_is_still_working(monkeypatch):
    clock = iter(range(0, 10_000, 50))  # every look at the clock: 50 s later
    monkeypatch.setattr(drafts, "_now", lambda: next(clock))
    lines = []
    drafts.draw_logo(mock_client([sse(fenced(OWL_SVG)), APPROVE], []), "Синие зайцы", [], log=lines.append)
    assert any(line.startswith("drawing: still working (") for line in lines)


def test_a_drawing_cut_off_is_asked_for_again():
    seen, lines = [], []
    cut = sse("```svg\n<svg xmlns=", stop_reason="max_tokens")
    replies = [cut, sse(fenced(OWL_SVG)), sse(fenced(OWL_2)), APPROVE]
    svg = drafts.draw_logo(mock_client(replies, seen), "Синие зайцы", [], log=lines.append)
    assert svg == OWL_2 and len(seen) == 4  # the retry does not use up a review
    assert lines[0].startswith("drawing: the reply was cut off at 128k tokens") and lines[0].endswith("asking again")
    assert body(seen[1])["messages"] == body(seen[0])["messages"]  # the same request again
    assert [line.split(" (")[0] for line in lines[1:]] == ["drawn", "review 1: revised", "review 2: approved"]


def test_a_drawing_cut_off_twice_is_an_error():
    cut = sse("```svg\n<svg xmlns=", stop_reason="max_tokens")
    with pytest.raises(ValueError, match="cut off"):
        drafts.draw_logo(mock_client([cut, cut], []), "Синие зайцы", [])


def test_api_errors_pass_through():
    error = httpx2.Response(529, json={"type": "error", "error": {"type": "overloaded_error", "message": "busy"}})
    with pytest.raises(anthropic.APIStatusError):
        drafts.draw_logo(mock_client([error], []), "Синие зайцы", [])


def test_measure_reports_the_ink_and_tight_edges():
    image = Image.new("RGBA", (800, 800), (0, 0, 0, 0))
    image.paste((150, 150, 150, 255), (80, 0, 800, 400))
    text = drafts.measure(image)
    assert "x 100–1000 and y 0–500" in text
    assert "Too close to the edge: top 0, right 0 units." in text
    assert "Too close" not in drafts.measure(Image.new("RGB", (100, 100), "white").crop((0, 0, 100, 100)))


def test_reference_images_are_small_pngs_on_white(library):
    Image.new("RGBA", (2000, 1000), (0, 0, 0, 0)).save(library / "clear.png")
    (library / "broken.png").write_bytes(b"not a png")
    refs, warnings = drafts.reference_blocks(drafts.reference_logos())
    assert [p.name for p in drafts.reference_logos()] == ["nologo.png", "broken.png", "clear.png", "other-team.png"]
    assert len(warnings) == 1 and "broken.png" in warnings[0]
    clear = Image.open(io.BytesIO(base64.b64decode(refs[1]["source"]["data"])))
    assert clear.size == (drafts.REFERENCE_SIDE, drafts.REFERENCE_SIDE // 2)
    assert clear.mode == "RGB" and clear.getextrema() == ((255, 255),) * 3  # transparent → white


def test_references_leave_out_drafts(library):
    drafts.save_draft("cup", "A01", OWL_SVG)
    assert all("drafts" not in p.parts for p in drafts.reference_logos())


def test_a_redraw_keeps_the_previous_drafts():
    path = drafts.save_draft("cup", "A01", OWL_SVG)
    drafts.save_draft("cup", "A01", OWL_2)
    drafts.save_draft("cup", "A01", OWL_3)
    assert path.read_text(encoding="utf-8") == OWL_3
    assert path.with_name("A01.1.svg").read_text(encoding="utf-8") == OWL_SVG
    assert path.with_name("A01.2.svg").read_text(encoding="utf-8") == OWL_2


@pytest.mark.parametrize(
    "text",
    [
        OWL_SVG,
        fenced(OWL_SVG),
        f"```xml\n{OWL_SVG}\n```",
        f"Thoughts <b>first</b>.\n{OWL_SVG}\nDone.",
    ],
)
def test_extract_svg(text):
    assert drafts.extract_svg(text) == OWL_SVG


def test_api_key_only_from_the_environment(monkeypatch):
    assert not drafts.api_key_set()
    monkeypatch.setenv(drafts.API_KEY_ENV, SECRET)
    assert drafts.api_key_set()
    assert drafts.make_client().api_key == SECRET


@pytest.mark.parametrize(
    "name,stem",
    [
        ("Звезды сошлись", "zvezdy-soshlis"),
        ("Фиаско", "fiasko"),
        ("Щука и Ёж", "shchuka-i-ezh"),
        ("42", "42"),
        ("«Подъём»!", "podem"),
        ("???", "team"),
        ("Команда с очень-очень длинным названием", "komanda-s-ochen-ochen-dlinnym-nazvaniem"),
        ("Очень длинное название команды из многих слов", "ochen-dlinnoe-nazvanie-komandy-iz"),
        ("А" * 50, "a" * 40),  # one long word: cut at 40
    ],
)
def test_file_stem_is_latin(name, stem):
    assert drafts.file_stem(name) == stem


# ---- the brief (no API key) ----


def test_brief_lists_the_teams_paths_and_references(folder, tmp_path):
    teams = read_teams(folder / "teams.py")[1:]
    look = replace(drafts.DEFAULT_LOOK, grey=0.07)
    out = drafts.write_brief(tmp_path / "brief.md", folder, "test-cup", teams, look)
    text = out.read_text(encoding="utf-8")
    assert "logos/nologo.png" in text.replace("library/", "logos/")  # references by path
    for t in teams:
        assert f"{t.team_id} «{t.name}»" in text
        assert f"drafts/test-cup/{t.team_id}.svg" in text
        assert f"«{t.name.upper()}»" in text
    assert f"chgk logos {folder} --accept all" in text
    assert drafts.system_prompt(look) in text and drafts.review_checklist("<the team name>") in text  # as the API
    assert "pale(im, 0.07)" in text and f"up to {drafts.REVIEW_ROUNDS} times" in text  # the tournament's shade
    assert "/tmp/" not in text.replace(str(tmp_path), "") and str(tmp_path / "review-card.png") in text
    assert "never overwritten" in text


# ---- preview and accept ----


def test_preview_shows_one_real_card_per_draft(folder, tmp_path):
    teams = read_teams(folder / "teams.py")
    shades = {"A01": "#e0e0e0", "A02": "#d0d0d0", "A03": ""}  # different drawings: the PDF keeps one copy of each
    paths = {
        t.team_id: drafts.save_draft("test-cup", t.team_id, OWL_SVG.replace("#e0e0e0", shades[t.team_id]))
        for t in teams
    }
    (paths["A03"]).write_text("<svg", encoding="utf-8")  # broken: a warning, left out
    out, warnings = build_logo_preview(folder, paths, tmp_path / "preview.pdf")
    pages = PdfReader(out).pages
    assert len(pages) == 1
    assert len(pages[0].images) == 2  # A01 and A02 with their drafts
    assert len(warnings) == 1 and "A03.svg" in warnings[0]
    assert not (folder / "state.json").exists()  # a preview is not a tournament
    assert build_logo_preview(folder, {"A03": paths["A03"]}, tmp_path / "none.pdf")[0] is None


def test_accept_moves_drafts_into_the_library_and_teams_py(folder, library):
    teams = read_teams(folder / "teams.py")
    for tid in ("A02", "A03"):
        drafts.save_draft("test-cup", tid, OWL_SVG)
    accepted = drafts.accept_drafts(folder / "teams.py", "test-cup", teams, ["A03"])
    assert [(t.team_id, t.logo_file) for t in accepted] == [("A03", "dumat-bystro.svg")]
    assert (library / "dumat-bystro.svg").read_text(encoding="utf-8") == OWL_SVG
    assert not drafts.draft_path("test-cup", "A03").exists()
    assert drafts.draft_path("test-cup", "A02").exists()  # not asked for: still a draft
    again = read_teams(folder / "teams.py")
    assert [t.logo_file for t in again] == ["z.png", "", "dumat-bystro.svg"]
    assert [(t.team_id, t.name) for t in again] == [(t.team_id, t.name) for t in teams]


def test_accept_the_same_team_twice_in_one_list(folder, library):
    drafts.save_draft("test-cup", "A03", OWL_SVG)
    teams = read_teams(folder / "teams.py")
    (accepted,) = drafts.accept_drafts(folder / "teams.py", "test-cup", teams, ["A03", "A03"])
    assert read_teams(folder / "teams.py")[2].logo_file == accepted.logo_file == "dumat-bystro.svg"


def test_accept_never_overwrites_another_teams_logo(folder, library):
    teams = read_teams(folder / "teams.py")
    (library / "dumat-bystro.svg").write_text(OWL_SVG, encoding="utf-8")  # someone else's file
    drafts.save_draft("test-cup", "A03", OWL_SVG.replace("#e0e0e0", "#e5e5e5"))
    (accepted,) = drafts.accept_drafts(folder / "teams.py", "test-cup", teams, None)
    assert accepted.logo_file == "dumat-bystro-a03.svg"
    assert (library / "dumat-bystro.svg").read_text(encoding="utf-8") == OWL_SVG
    # a redraw for the same team replaces its own file
    drafts.save_draft("test-cup", "A03", OWL_SVG)
    (again,) = drafts.accept_drafts(folder / "teams.py", "test-cup", read_teams(folder / "teams.py"), None)
    assert again.logo_file == "dumat-bystro-a03.svg"
    assert (library / "dumat-bystro-a03.svg").read_text(encoding="utf-8") == OWL_SVG


def test_accept_refuses_a_bad_draft_and_changes_nothing(folder, library):
    teams = read_teams(folder / "teams.py")
    before = (folder / "teams.py").read_text(encoding="utf-8")
    drafts.save_draft("test-cup", "A02", OWL_SVG)
    drafts.save_draft("test-cup", "A03", OWL_SVG.replace("<circle", "<script>x</script><circle"))
    with pytest.raises(ValueError, match="refused"):
        drafts.accept_drafts(folder / "teams.py", "test-cup", teams, None)
    with pytest.raises(ValueError, match="no draft for A01"):
        drafts.accept_drafts(folder / "teams.py", "test-cup", teams, ["A01"])
    assert (folder / "teams.py").read_text(encoding="utf-8") == before
    assert drafts.draft_path("test-cup", "A02").exists()
    assert not any(library.glob("*.svg"))


# ---- the command ----


def test_report_shows_each_team_and_the_key_status(folder):
    result = runner.invoke(app, ["logos", str(folder)])
    assert result.exit_code == 0, result.output
    lines = result.output.splitlines()
    assert any("A01" in line and "z.png" in line and "own logo" in line for line in lines)
    assert any("A02" in line and "(none)" in line and "tournament logo" in line for line in lines)
    assert f"{drafts.API_KEY_ENV}: not set" in result.output


def test_draw_without_a_key_writes_the_brief_and_calls_nothing(folder, monkeypatch):
    monkeypatch.setattr(drafts, "make_client", lambda: pytest.fail("no API call without a key"))
    result = runner.invoke(app, ["logos", str(folder), "--draw"])
    assert result.exit_code == 0, result.output
    text = (folder.parent / "out" / "test-cup" / "logo-brief.md").read_text(encoding="utf-8")
    assert "A02" in text and "A03" in text and "### A01" not in text  # A01 has a logo
    assert "a brief for 2 logos" in result.output


def test_draw_with_a_key_saves_drafts_previews_and_never_shows_the_key(folder, monkeypatch):
    monkeypatch.setenv(drafts.API_KEY_ENV, SECRET)
    seen = []
    no_svg = sse("no drawing today")
    replies = {"Длинное": [sse(fenced(OWL_SVG)), APPROVE], "Думать быстро": [no_svg] * (drafts.REVIEW_ROUNDS + 1)}
    replies[LONG_NAME] = replies.pop("Длинное")
    monkeypatch.setattr(drafts, "make_client", lambda: mock_client(replies, seen, os.environ[drafts.API_KEY_ENV]))
    result = runner.invoke(app, ["logos", str(folder), "--draw"])
    assert result.exit_code == 0, result.output
    assert {team_of(r) for r in seen} == {LONG_NAME, "Думать быстро"}  # A02 and A03, the teams without a logo
    assert len(seen) == 2 + drafts.REVIEW_ROUNDS + 1
    assert {r.headers["authorization"] for r in seen} == {f"Bearer {SECRET}"}  # the key from the environment
    assert SECRET not in result.output
    assert "at max effort" in result.output
    assert "A02 «" in result.output and "review 1: approved" in result.output
    assert drafts.draft_path("test-cup", "A02").read_text(encoding="utf-8") == OWL_SVG
    assert not drafts.draft_path("test-cup", "A03").exists()
    assert "A03 «Думать быстро»: no usable drawing" in result.output
    assert (folder.parent / "out" / "test-cup" / "logo-preview.pdf").is_file()
    assert "--accept all" in result.output
    # a second --draw only asks for the team still without a draft
    replies["Думать быстро"] += [sse(fenced(OWL_SVG)), APPROVE]
    assert runner.invoke(app, ["logos", str(folder), "--draw"]).exit_code == 0
    assert {team_of(r) for r in seen[5:]} == {"Думать быстро"}
    assert "Nothing to draw" in runner.invoke(app, ["logos", str(folder), "--draw"]).output


def test_draw_team_redraws_even_with_a_logo_and_keeps_the_old_draft(folder, monkeypatch):
    monkeypatch.setenv(drafts.API_KEY_ENV, SECRET)
    drafts.save_draft("test-cup", "A01", OWL_2)
    seen = []
    monkeypatch.setattr(drafts, "make_client", lambda: mock_client([sse(fenced(OWL_SVG)), APPROVE], seen))
    result = runner.invoke(app, ["logos", str(folder), "--draw", "--team", "a01"])
    assert result.exit_code == 0, result.output
    assert len(seen) == 2 and drafts.draft_path("test-cup", "A01").read_text(encoding="utf-8") == OWL_SVG
    assert drafts.draft_path("test-cup", "A01").with_name("A01.1.svg").read_text(encoding="utf-8") == OWL_2


def test_draw_drafts_saves_each_team_and_reports_failures_per_team(folder):
    teams = read_teams(folder / "teams.py")[1:]  # A02 and A03
    replies = {LONG_NAME: [sse(fenced(OWL_SVG)), APPROVE], "Думать быстро": [sse("no drawing")] * 3}
    lines = []
    outcomes = drafts.draw_drafts(
        mock_client(replies, []), "test-cup", teams, [], log=lambda t, line, problem: lines.append((t.team_id, problem))
    )
    assert [(o.team.team_id, o.path, bool(o.error), o.skipped) for o in outcomes] == [
        ("A02", drafts.draft_path("test-cup", "A02"), False, False),
        ("A03", None, True, False),
    ]
    assert drafts.draft_path("test-cup", "A02").read_text(encoding="utf-8") == OWL_SVG
    assert outcomes[1].error.startswith("no usable drawing")
    assert ("A03", True) in lines and ("A02", False) in lines


def test_draw_drafts_stops_on_a_refused_key(folder, monkeypatch):
    monkeypatch.setattr(drafts, "PARALLEL", 1)
    refused = httpx2.Response(
        401, json={"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}
    )
    seen = []
    with pytest.raises(anthropic.AuthenticationError):
        drafts.draw_drafts(mock_client([refused], seen), "test-cup", read_teams(folder / "teams.py"), [])
    assert len(seen) == 1  # the other teams never started
    assert not drafts.drafts_dir("test-cup").exists()


def test_a_wrong_key_stops_and_is_not_shown(folder, monkeypatch):
    monkeypatch.setenv(drafts.API_KEY_ENV, SECRET)
    monkeypatch.setattr(drafts, "PARALLEL", 1)
    refused = httpx2.Response(
        401, json={"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}
    )
    seen = []
    monkeypatch.setattr(drafts, "make_client", lambda: mock_client([refused], seen))
    result = runner.invoke(app, ["logos", str(folder), "--draw"])
    assert result.exit_code == 1
    assert len(seen) == 1  # stopped at the first team: the second was never started
    assert "refused ANTHROPIC_API_KEY" in result.output and SECRET not in result.output


def test_accept_from_the_command(folder, library):
    drafts.save_draft("test-cup", "A02", OWL_SVG)
    result = runner.invoke(app, ["logos", str(folder), "--accept", "all"])
    assert result.exit_code == 0, result.output
    a02 = read_teams(folder / "teams.py")[1]
    assert a02.logo_file.endswith(".svg") and (library / a02.logo_file).is_file()
    assert any("A02" in line and "own logo" in line for line in result.output.splitlines())


@pytest.mark.parametrize(
    "args,error",
    [(["--team", "A01"], "--team goes with --draw"), (["--draw", "--accept", "all"], "one at a time")],
)
def test_option_mistakes(folder, args, error):
    result = runner.invoke(app, ["logos", str(folder), *args])
    assert result.exit_code == 1 and error in result.output


def test_unknown_team_for_draw(folder, monkeypatch):
    monkeypatch.setenv(drafts.API_KEY_ENV, SECRET)
    result = runner.invoke(app, ["logos", str(folder), "--draw", "--team", "Z99"])
    assert result.exit_code == 1 and "Z99" in result.output
