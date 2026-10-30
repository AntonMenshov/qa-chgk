"""Claude-drawn logos: the API request (mocked HTTP, never a real call), drafts, the brief, preview and accept."""

import base64
import io
import json
import os
import shutil

import anthropic
import httpx2
import pytest
from anthropic import DefaultHttpxClient
from PIL import Image
from pypdf import PdfReader
from typer.testing import CliRunner

import chgk.logos as logos
from chgk import logo_drafts as drafts
from chgk.cards.build import build_logo_preview
from chgk.cli import app
from chgk.teams import read_teams

runner = CliRunner()
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
        {"type": "message_delta", "delta": {"stop_reason": stop_reason, "stop_sequence": None}, "usage": {}},
        {"type": "message_stop"},
    ]
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)


def mock_client(replies: list, seen: list, api_key: str = SECRET) -> anthropic.Anthropic:
    """A real SDK client whose HTTP goes to `replies` (SSE text, or an httpx2.Response) in order."""

    def handler(request):
        seen.append(request)
        reply = replies.pop(0)
        if isinstance(reply, httpx2.Response):
            return reply
        return httpx2.Response(200, headers={"content-type": "text/event-stream"}, text=reply)

    transport = httpx2.MockTransport(handler)
    return anthropic.Anthropic(api_key=api_key, max_retries=0, http_client=DefaultHttpxClient(transport=transport))


def fenced(svg: str) -> str:
    return f"Here it is:\n```svg\n{svg}\n```\n"


# ---- the request and the reply ----


def test_draw_logo_request_and_reply():
    seen = []
    refs, warnings = drafts.reference_blocks(drafts.reference_logos())
    svg = drafts.draw_logo(mock_client([sse(fenced(OWL_SVG))], seen), "Синие зайцы", refs)
    assert svg == OWL_SVG and warnings == []
    request = seen[0]
    body = json.loads(request.content)
    assert body["model"] == drafts.MODEL == "claude-opus-5-5"
    assert body["stream"] is True
    assert body["fallbacks"] == "default"
    assert drafts.FALLBACK_BETA in request.headers["anthropic-beta"]
    content = body["messages"][0]["content"]
    images = [block for block in content if block["type"] == "image"]
    assert len(images) == 2  # the owl and the other team's logo
    assert images[-1]["cache_control"] == {"type": "ephemeral"}  # the same for every team: cached
    assert "«Синие зайцы»" in content[-1]["text"] and "«СИНИЕ ЗАЙЦЫ»" in content[-1]["text"]


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


@pytest.mark.parametrize(
    "reply,error",
    [
        (sse("I'd rather not."), "no SVG"),
        (sse(fenced(OWL_SVG.replace("<circle", "<script>x</script><circle"))), "refused"),
        (sse(fenced(OWL_SVG), stop_reason="refusal"), "declined"),
        (sse("```svg\n<svg xmlns=", stop_reason="max_tokens"), "cut off"),
    ],
)
def test_unusable_replies_are_value_errors(reply, error):
    with pytest.raises(ValueError, match=error):
        drafts.draw_logo(mock_client([reply], []), "Синие зайцы", [])


def test_api_errors_pass_through():
    error = httpx2.Response(529, json={"type": "error", "error": {"type": "overloaded_error", "message": "busy"}})
    with pytest.raises(anthropic.APIStatusError):
        drafts.draw_logo(mock_client([error], []), "Синие зайцы", [])


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
    ],
)
def test_file_stem_is_latin(name, stem):
    assert drafts.file_stem(name) == stem


# ---- the brief (no API key) ----


def test_brief_lists_the_teams_paths_and_references(folder, tmp_path):
    teams = read_teams(folder / "teams.py")[1:]
    out = drafts.write_brief(tmp_path / "brief.md", folder, "test-cup", teams)
    text = out.read_text(encoding="utf-8")
    assert "logos/nologo.png" in text.replace("library/", "logos/")  # references by path
    for t in teams:
        assert f"{t.team_id} «{t.name}»" in text
        assert f"drafts/test-cup/{t.team_id}.svg" in text
        assert f"«{t.name.upper()}»" in text
    assert f"chgk logos {folder} --accept all" in text


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
    text = (folder / "out" / "test-cup" / "logo-brief.md").read_text(encoding="utf-8")
    assert "A02" in text and "A03" in text and "### A01" not in text  # A01 has a logo
    assert "a brief for 2 logos" in result.output


def test_draw_with_a_key_saves_drafts_previews_and_never_shows_the_key(folder, monkeypatch):
    monkeypatch.setenv(drafts.API_KEY_ENV, SECRET)
    seen = []
    replies = [sse(fenced(OWL_SVG)), sse("no drawing today")]
    monkeypatch.setattr(drafts, "make_client", lambda: mock_client(replies, seen, os.environ[drafts.API_KEY_ENV]))
    result = runner.invoke(app, ["logos", str(folder), "--draw"])
    assert result.exit_code == 0, result.output
    assert len(seen) == 2  # A02 and A03, the teams without a logo
    assert seen[0].headers["authorization"] == f"Bearer {SECRET}"  # the key from the environment
    assert SECRET not in result.output
    assert drafts.draft_path("test-cup", "A02").read_text(encoding="utf-8") == OWL_SVG
    assert not drafts.draft_path("test-cup", "A03").exists()
    assert "A03 «Думать быстро»: no usable drawing" in result.output
    assert (folder / "out" / "test-cup" / "logo-preview.pdf").is_file()
    assert "--accept all" in result.output
    # a second --draw only asks for the team still without a draft
    replies.append(sse(fenced(OWL_SVG)))
    assert runner.invoke(app, ["logos", str(folder), "--draw"]).exit_code == 0
    assert len(seen) == 3 and "Думать быстро" in json.loads(seen[2].content)["messages"][0]["content"][-1]["text"]
    assert "Nothing to draw" in runner.invoke(app, ["logos", str(folder), "--draw"]).output


def test_draw_team_redraws_even_with_a_logo(folder, monkeypatch):
    monkeypatch.setenv(drafts.API_KEY_ENV, SECRET)
    seen = []
    monkeypatch.setattr(drafts, "make_client", lambda: mock_client([sse(fenced(OWL_SVG))], seen))
    result = runner.invoke(app, ["logos", str(folder), "--draw", "--team", "a01"])
    assert result.exit_code == 0, result.output
    assert len(seen) == 1 and drafts.draft_path("test-cup", "A01").is_file()


def test_a_wrong_key_stops_and_is_not_shown(folder, monkeypatch):
    monkeypatch.setenv(drafts.API_KEY_ENV, SECRET)
    refused = httpx2.Response(
        401, json={"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}
    )
    seen = []
    monkeypatch.setattr(drafts, "make_client", lambda: mock_client([refused], seen))
    result = runner.invoke(app, ["logos", str(folder), "--draw"])
    assert result.exit_code == 1
    assert len(seen) == 1  # stopped at the first team
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
