"""Claude-drawn team logos: drafts, the brief for drawing them without an API key, and accepting them.

A draft is an SVG in `logos/drafts/<slug>/<team_id>.svg` (private, like the whole
library). `chgk logos --draw` asks the Claude API for it, with the library's own logos
as style references; without `ANTHROPIC_API_KEY` it writes a brief for drawing them in
a Claude Code session instead. `--accept` moves a draft into `logos/` under a Latin
file name and records it in teams.py.

The API key is read from the environment only, and never stored, printed or logged.
"""

import base64
import io
import os
import re
import shutil
from dataclasses import replace
from pathlib import Path

import anthropic
from PIL import Image

from chgk import logos
from chgk.svg import render_svg
from chgk.teams import Team, write_teams

API_KEY_ENV = "ANTHROPIC_API_KEY"
MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"  # a declined request is re-run on Anthropic's fallback model
MAX_TOKENS = 64000
MAX_REFERENCES = 4
REFERENCE_SIDE = 512  # px: enough to show the style, cheap in tokens
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".svg"}
STEM_LENGTH = 40  # an accepted logo's file name, before ".svg"

SYSTEM = (
    "You draw team logos for the answer cards of a ЧГК («Что? Где? Когда?») quiz tournament. "
    "They are printed as a very pale grey watermark behind handwriting, so they must read as "
    "simple flat shapes and keep the style of the team logos the tournament already has."
)


def style_rules(name: str) -> str:
    """What a logo for team `name` must look like: shared by the API prompt and the brief."""
    return f"""\
- The ЧГК owl (big round eyes, ear tufts, a simple flat body) acting out the team name «{name}»:
  a visual pun or a small scene that fits it, as in the reference logos.
- A few small question marks, or an hourglass, around it.
- Flat shapes in light grey only: fills #d9d9d9 to #efefef, outlines and details #aaaaaa to #c8c8c8.
  No colour, gradients, shadows or photos. White or transparent background.
- Below the drawing, the name «{name.upper()}» in bold capitals: <text> with font-family="PT Sans"
  and font-weight="bold", centred, light grey fill with a slightly darker outline. Split a long
  name over two lines.
- A square canvas, viewBox="0 0 1000 1000", nothing outside it.
- Plain SVG drawing only: no <script>, <foreignObject>, <image>, event handlers, external
  references, web fonts or DOCTYPE (such files are refused)."""


def api_key_set() -> bool:
    return bool(os.environ.get(API_KEY_ENV))


def make_client() -> anthropic.Anthropic:
    """The API client, with the key from the environment and nothing else."""
    return anthropic.Anthropic(api_key=os.environ[API_KEY_ENV])


def drafts_dir(slug: str) -> Path:
    return logos.LOGO_LIBRARY / "drafts" / slug


def draft_path(slug: str, team_id: str) -> Path:
    return drafts_dir(slug) / f"{team_id}.svg"


def existing_drafts(slug: str, teams: list[Team]) -> dict[str, Path]:
    """team_id → draft file, for the teams that have one."""
    return {t.team_id: draft_path(slug, t.team_id) for t in teams if draft_path(slug, t.team_id).is_file()}


def reference_logos() -> list[Path]:
    """The library's logos that show the style: the fallback owl first, then the team logos (no drafts)."""
    files = sorted(p for p in logos.LOGO_LIBRARY.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)
    files.sort(key=lambda p: p.name != "nologo.png")
    return files[:MAX_REFERENCES]


def reference_blocks(paths: list[Path]) -> tuple[list[dict], list[str]]:
    """The reference logos as API image blocks (PNG on white), plus warnings for files that can't be read.

    The same blocks open every team's request, so they are cached: later teams pay less for them.
    """
    blocks, warnings = [], []
    for path in paths:
        try:
            image = logos.open_logo(path).convert("RGBA")
        except ValueError as err:
            warnings.append(f"reference {path.name}: {err}; left out")
            continue
        image.thumbnail((REFERENCE_SIDE, REFERENCE_SIDE))
        flat = Image.new("RGB", image.size, "white")  # transparent → white, as on the card
        flat.paste(image, mask=image)
        buffer = io.BytesIO()
        flat.save(buffer, "PNG")
        data = base64.standard_b64encode(buffer.getvalue()).decode("ascii")
        blocks.append({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}})
    if blocks:
        blocks[-1] = {**blocks[-1], "cache_control": {"type": "ephemeral"}}
    return blocks, warnings


def extract_svg(text: str) -> str:
    """The SVG in a reply: a ```svg block, or else the first <svg>…</svg>."""
    block = re.search(r"```(?:svg|xml)?\s*(<svg.*?</svg>)\s*```", text, re.DOTALL)
    match = block or re.search(r"<svg.*?</svg>", text, re.DOTALL)
    if not match:
        raise ValueError("the reply has no SVG")
    return match.group(1) if block else match.group(0)


def draw_logo(client: anthropic.Anthropic, name: str, references: list[dict]) -> str:
    """Ask Claude for one team's logo (`references` from reference_blocks); return checked SVG text.

    ValueError if the reply has no usable SVG; API errors (anthropic.APIError) pass through.
    """
    content = list(references)
    intro = "The images above are logos of other teams. " if references else ""
    content.append(
        {
            "type": "text",
            "text": f"{intro}Draw the logo of the team «{name}» in that style:\n{style_rules(name)}\n\n"
            "Reply with the SVG only, in one ```svg code block.",
        }
    )
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        betas=[FALLBACK_BETA],
        fallbacks="default",
        output_config={"effort": "high"},
        system=SYSTEM,
        messages=[{"role": "user", "content": content}],
    ) as stream:
        message = stream.get_final_message()
    if message.stop_reason == "refusal":
        raise ValueError("the API declined to draw it")
    if message.stop_reason == "max_tokens":
        raise ValueError("the reply was cut off before the SVG ended")
    svg = extract_svg("".join(block.text for block in message.content if block.type == "text"))
    render_svg(svg, 200)  # refused or undrawable SVG → ValueError
    return svg


def save_draft(slug: str, team_id: str, svg: str) -> Path:
    path = draft_path(slug, team_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(svg, encoding="utf-8")
    return path


def write_brief(out: Path, folder: Path, slug: str, teams: list[Team]) -> Path:
    """Instructions for drawing these teams' logos in a Claude Code session (no API key needed)."""
    root = logos.LOGO_LIBRARY.parent
    refs = "\n".join(f"- `{p.relative_to(root)}`" for p in reference_logos()) or "- (none in logos/ yet)"
    lines = [
        f"# Logo drafts for `{slug}`",
        "",
        "Open Claude Code in this repository and ask it to follow this file.",
        "",
        "## Style references",
        "",
        "Look at these logos first; the new ones must look like they belong with them:",
        "",
        refs,
        "",
        "## Logos to draw",
        "",
        "Write each one as an SVG file at the path given. One file per team.",
        "",
    ]
    for t in teams:
        lines += [
            f"### {t.team_id} «{t.name}» → `{draft_path(slug, t.team_id).relative_to(root)}`",
            "",
            style_rules(t.name),
            "",
        ]
    lines += [
        "## Then",
        "",
        f"1. `uv run chgk logos {folder}`: checks the drafts and makes the preview PDF on real cards.",
        f"2. `uv run chgk logos {folder} --accept all` (or `--accept A01,A02`) records them in teams.py.",
        "",
    ]
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8")
    return out


CYRILLIC = dict(zip("абвгдезийклмнопрстуфыэ", "abvgdeziyklmnoprstufye", strict=True)) | {
    "ё": "e",
    "ж": "zh",
    "х": "kh",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "shch",
    "ю": "yu",
    "я": "ya",
    "ъ": "",
    "ь": "",  # the signs are dropped
}


def file_stem(name: str) -> str:
    """A Latin file name for a team name: «Звезды сошлись» → «zvezdy-soshlis»; at most 40 characters."""
    latin = "".join(CYRILLIC.get(ch, ch) for ch in name.lower())
    stem = re.sub(r"[^a-z0-9]+", "-", latin).strip("-")
    if len(stem) > STEM_LENGTH:
        stem = stem[: STEM_LENGTH + 1].rsplit("-", 1)[0]  # whole words only
    return stem or "team"


def accept_drafts(teams_path: Path, slug: str, teams: list[Team], team_ids: list[str] | None) -> list[Team]:
    """Move drafts into logos/ and record them in teams.py; `team_ids` None means every draft.

    Returns the teams that got a new logo. A draft whose SVG is refused or can't be drawn
    is an error, and nothing is changed.
    """
    drafts = existing_drafts(slug, teams)
    if team_ids is None:
        team_ids = [t.team_id for t in teams if t.team_id in drafts]
        if not team_ids:
            raise ValueError(f"no drafts in {drafts_dir(slug)}")
    missing = [tid for tid in team_ids if tid not in drafts]
    if missing:
        raise ValueError(f"no draft for {', '.join(missing)} in {drafts_dir(slug)}")
    for tid in team_ids:
        try:
            logos.open_logo(drafts[tid])
        except ValueError as err:
            raise ValueError(f"draft {drafts[tid]}: {err}") from err
    by_id = {t.team_id: t for t in teams}
    taken: set[str] = set()
    accepted = []
    for tid in team_ids:
        team = by_id[tid]
        name = f"{file_stem(team.name)}.svg"
        clash = (logos.LOGO_LIBRARY / name).exists() and team.logo_file != name
        if clash or name in taken:
            name = f"{file_stem(team.name)}-{tid.lower()}.svg"
        taken.add(name)
        shutil.move(drafts[tid], logos.LOGO_LIBRARY / name)
        by_id[tid] = replace(team, logo_file=name)
        accepted.append(by_id[tid])
    write_teams(teams_path, [by_id[t.team_id] for t in teams])
    return accepted
