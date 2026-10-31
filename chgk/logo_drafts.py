"""Claude-drawn team logos: drafts, the brief for drawing them without an API key, and accepting them.

A draft is an SVG in `logos/drafts/<slug>/<team_id>.svg` (private, like the whole
library); a redraw keeps the one before as `<team_id>.1.svg`, `.2.svg`, … `chgk logos
--draw` asks the Claude API for it, with the library's own logos as style references,
then shows Claude its own drawing, rendered, and lets it fix what it sees (REVIEW_ROUNDS
times, or until it approves). Without `ANTHROPIC_API_KEY` it writes a brief for drawing
them, with the same rules and review, in a Claude Code session instead. `--accept`
moves a draft into `logos/` under a Latin file name and records it in teams.py.

The API key is read from the environment only, and never stored, printed or logged.
"""

import base64
import io
import os
import re
import shutil
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, cast

import anthropic
import httpx
from PIL import Image

from chgk import logos
from chgk.cards.geometry import INCH, card_parts, card_rects
from chgk.config import CardFields, Layout
from chgk.svg import check_svg, render_svg
from chgk.teams import Team, write_teams

API_KEY_ENV = "ANTHROPIC_API_KEY"
MODEL = "claude-opus-5-5"
EFFORT = "max"  # always Opus at max effort (user rule)
FALLBACK_BETA = "server-side-fallback-2026-07-01"  # a declined request is re-run on Anthropic's fallback model
MAX_TOKENS = 128000  # the model's limit; max effort thinks at length, and only what is used is billed
TASK_BUDGET_BETA = "task-budgets-2026-03-13"
# Claude sees this budget and plans to finish within it, so a max-effort drawing ends before MAX_TOKENS.
TASK_BUDGET = 100_000
CUT_OFF_RETRIES = 1  # a drawing cut off anyway is asked for again, so a team is not left with nothing
REVIEW_ROUNDS = 2  # after the first drawing: render it, show it back, let Claude fix it (or approve)
PARALLEL = 4  # teams drawn at the same time
MAX_REFERENCES = 4
REFERENCE_SIDE = 512  # px: enough to show the style, cheap in tokens
HEARTBEAT = 120  # s: a progress line while a round is still running
RENDER_SIDE = 800  # px: the drawing shown back for review
CARD_SIDE = 260  # px: the pale version shown back small, as it reads on the card
EDGE_MARGIN = 30  # canvas units (of 1000) that stay empty along every edge
APPROVED = "APPROVED"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".svg"}
STEM_LENGTH = 40  # an accepted logo's file name, before ".svg"


@dataclass(frozen=True)
class LogoLook:
    """How a tournament prints its logos, which the prompt describes to Claude."""

    grey: float  # ink of the logo's dark parts (CardFields.logo_grey)
    side_cm: float  # the logo square as printed
    card_w_cm: float
    card_h_cm: float
    sized: bool  # CardFields.logo_size set: centred on the card; else it fits the writing area
    under_qr: bool  # the QR code covers the logo's top-right corner


def logo_look(fields: CardFields, layout: Layout) -> LogoLook:
    """The printed size and shade of a logo with these card settings (the cards' own geometry)."""
    card = card_rects(layout)[0]
    logo_pt = fields.logo_size * INCH if fields.logo_size else None
    parts = card_parts(card, layout.qr_size * INCH, logo_pt)
    cm = 2.54 / INCH
    return LogoLook(
        grey=fields.logo_grey,
        side_cm=parts.logo.w * cm,
        card_w_cm=card.w * cm,
        card_h_cm=card.h * cm,
        sized=fields.logo_size is not None,
        under_qr=parts.logo.intersects(parts.qr),
    )


DEFAULT_LOOK = logo_look(CardFields(), Layout())


def system_prompt(look: LogoLook) -> str:
    """The system text: how the logo is used (from the tournament's settings) and the set's style."""
    where = "centred on the card" if look.sized else "in the writing area below the question number"
    qr = (
        "The card's QR code covers the logo's top-right corner."
        if look.under_qr
        else "The card's QR code sits above it, at the top right."
    )
    return f"""\
You draw team logos for the answer cards of a sport ЧГК («Что? Где? Когда?») quiz tournament.

How the logo is used: it is printed behind the team's handwritten answers on small cards
(about {look.card_w_cm:.1f} × {look.card_h_cm:.1f} cm), as a square about {look.side_cm:.1f} cm wide {where},
turned into a very pale grey watermark: the darkest tenth of the drawing is printed
at about {look.grey:.0%} ink and everything else lighter. So the logo must read as a few big,
simple, flat shapes; fine detail disappears. {qr}

The style is fixed by the tournament's existing logos, which you are shown: the ЧГК owl in a
small scene that acts out the team's name as a visual pun, flat light-grey shapes with
slightly darker outlines, a couple of question marks or an hourglass as accents, and the
team name in bold capitals underneath. New logos must look like they belong to the same set.

You write the SVG by hand, so plan the composition in canvas coordinates before drawing,
and check every coordinate against the layout rules."""


def style_rules(name: str) -> str:
    """What a logo for team `name` must look like: shared by the API prompt and the brief."""
    caps = name.upper()
    return f"""Idea
- One clear idea: the owl itself acts out «{name}» — it holds or uses the prop, wears the
  costume, is caught in the situation. An owl merely standing next to an object is weak.
- Think of the readings of the name first (a pun, an idiom, a film or song it quotes, the
  literal words) and pick the one a ЧГК player gets at a glance.
- At most three props, each a big, simple silhouette that is recognisable on its own at
  2 cm. The joke must not depend on small details (a bandage on an ear, a tiny card suit,
  a label): those vanish when printed pale. Draw a thing by its characteristic outline (a
  gladiolus is a tall spike of ruffled funnel flowers up one side of the stem with
  sword-shaped leaves; a cluster of circles reads as roses).

The owl
- The same ЧГК owl as in the references: a round, egg-shaped body, two ear tufts, big round
  eyes (white discs with grey pupils and a small white highlight), a small diamond beak,
  a lighter belly with a few small chevron feathers, wings at the sides, two small feet.
- It may change pose, expression (eyebrows, half-closed eyes, a grin), and wear clothes or
  hats, but it stays recognisably that owl and is the largest figure in the scene.

Layout (viewBox="0 0 1000 1000")
- The drawing sits in the upper part, y 40 to 720, centred, with balanced weight; a thin
  ground line under it is fine. The name block sits below y 760.
- Nothing within {EDGE_MARGIN} units of any edge, nothing outside the canvas.
- Top-right corner (x > 800, y < 200): only an accent there (a question mark, a star), never
  part of the joke: the QR code may cover it.
- Two or three question marks, or an hourglass, as small light accents in empty space,
  touching neither the owl nor the name.

Greys
- Flat fills only, light: large areas #e4e4e4 to #f2f2f2, smaller parts #d9d9d9 to #e8e8e8.
- Outlines #a8a8a8 to #c0c0c0, stroke-width 6 to 9, stroke-linejoin="round"; small accents
  may be #b0b0b0 to #c8c8c8.
- No large area darker than #c8c8c8 (a dark hat or cat becomes the darkest tenth and makes
  the rest of the logo print too pale). No colour, gradients, shadows, filters, blur or
  textures. White or transparent background.

The name
- Exactly «{caps}»: same spelling, digits, Latin letters and punctuation (+, -, numbers).
- <text> with font-family="PT Sans", font-weight="bold", text-anchor="middle", x="500";
  fill #dedede, stroke #a8a8a8, stroke-width 3 to 4.
- Size: font-size 90 to 120. A bold capital is about 0.62 × font-size wide, so each line
  must stay under 900 units: one line if it fits at 96 or more, otherwise two lines split at
  a word, as even as possible (three only if unavoidable), line spacing about 1.05 × size.
- No other text, except a short word or number that is itself part of a prop (a calendar
  page, a jersey number), in the same font.

SVG
- Plain drawing: <path>, <circle>, <ellipse>, <rect>, <line>, <polyline>, <polygon>, <g>,
  <text>, and <defs>/<use> pointing at ids in the same file.
- Refused (the file is rejected): <script>, <foreignObject>, <image>, event handlers, links to
  anything outside the file, web fonts, @import, a DOCTYPE."""


def review_checklist(name: str) -> str:
    """How to check one drawing: shared by the API's review rounds and the brief."""
    return f"""1. At card size (the small pale image) is it clearly the ЧГК owl, and is the scene readable?
2. Does it act out «{name}» so that a ЧГК player gets the pun? Is every prop recognisable by
   its outline alone? Is anything misdrawn: limbs from nowhere, things floating, wrong
   overlaps, a prop that reads as something else?
3. Is the name exactly «{name.upper()}», fully inside the canvas, in balanced lines, with clear
   space between it and the drawing?
4. Are the margins at least {EDGE_MARGIN} units, and is the top-right corner free of anything
   the joke needs?
5. Are the greys right: light fills, darker outlines, no large dark area, still legible pale?
6. Does it look like it belongs with the reference logos (owl proportions, line weight)?"""


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


def _png_block(image: Image.Image) -> dict[str, Any]:
    """An image as an API PNG block, transparent parts white as on the card."""
    flat = Image.new("RGB", image.size, "white")
    rgba = image.convert("RGBA")
    flat.paste(rgba, mask=rgba)
    buffer = io.BytesIO()
    flat.save(buffer, "PNG")
    data = base64.standard_b64encode(buffer.getvalue()).decode("ascii")
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}}


def reference_blocks(paths: list[Path]) -> tuple[list[dict[str, Any]], list[str]]:
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
        blocks.append(_png_block(image))
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


def measure(image: Image.Image) -> str:
    """Facts about a rendered drawing that are hard to see: where its ink reaches, in canvas units."""
    flat = Image.new("L", image.size, 255)
    flat.paste(image.convert("L"), mask=image.convert("RGBA"))
    box = flat.point(lambda v: 255 if v < 250 else 0).getbbox()
    if box is None:
        return "The drawing is empty: nothing was drawn."
    scale = 1000 / max(image.size)
    left, top, right, bottom = (round(v * scale) for v in box)
    margins = {"left": left, "top": top, "right": 1000 - right, "bottom": 1000 - bottom}
    tight = [f"{side} {m}" for side, m in margins.items() if m < EDGE_MARGIN]
    where = f"The ink spans x {left}–{right} and y {top}–{bottom} of 0–1000."
    return where + (f" Too close to the edge: {', '.join(tight)} units." if tight else "")


def _review_message(name: str, image: Image.Image, grey: float, round_no: int) -> dict[str, Any]:
    card = logos.pale(image, grey).convert("RGBA")
    card.thumbnail((CARD_SIDE, CARD_SIDE))
    text = (
        f"Review {round_no} of {REVIEW_ROUNDS}. The first image is your SVG as rendered (the name in PT Sans "
        f"bold); the second is how it prints on the card, pale and small. {measure(image)}\n\n"
        f"Check it like a strict art director:\n{review_checklist(name)}\n\n"
        f"If everything passes and nothing is worth improving, reply with the single word {APPROVED}. "
        "Otherwise reply with at most three short lines on what you change, then the complete corrected "
        "SVG (the whole file, not a diff) in one ```svg code block."
    )
    return {"role": "user", "content": [_png_block(image), _png_block(card), {"type": "text", "text": text}]}


class CutOffError(ValueError):
    """The reply hit MAX_TOKENS before it was complete."""


_now = time.monotonic  # the clock for progress lines and round times (tests replace it)


def _ask(client: anthropic.Anthropic, messages: Any, system: str, log: Any, label: str) -> tuple[Any, str]:
    """One streamed request; returns the message and a note on its time and tokens.

    A max-effort round can think for many minutes before any text: `log` gets a line every
    HEARTBEAT seconds meanwhile.
    """
    started = last = _now()
    with client.beta.messages.stream(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        betas=[FALLBACK_BETA, TASK_BUDGET_BETA],
        fallbacks="default",
        output_config=cast(Any, {"effort": EFFORT, "task_budget": {"type": "tokens", "total": TASK_BUDGET}}),
        cache_control={"type": "ephemeral"},  # each round resends the conversation so far: cache it
        system=system,
        messages=messages,
    ) as stream:
        for _event in stream:
            if _now() - last >= HEARTBEAT:
                last = _now()
                log(f"{label}: still working ({(last - started) / 60:.0f} min)")
        message = stream.get_final_message()
    usage = message.usage
    note = f"{(_now() - started) / 60:.1f} min, {(usage.output_tokens or 0) / 1000:.1f}k tokens out"
    if message.stop_reason == "refusal":
        raise ValueError("the API declined to draw it")
    if message.stop_reason == "max_tokens":
        raise CutOffError(f"the reply was cut off at {MAX_TOKENS // 1000}k tokens, before the SVG ended ({note})")
    return message, note


def draw_logo(
    client: anthropic.Anthropic,
    name: str,
    references: list[dict[str, Any]],
    look: LogoLook = DEFAULT_LOOK,
    log: Callable[[str], None] = lambda line: None,
) -> str:
    """Ask Claude for one team's logo, then let it review and fix its own rendering; return checked SVG text.

    `references` come from reference_blocks; `look` is how the tournament prints logos
    (logo_look), for the system text and the pale card-size image Claude reviews; `log` gets
    a line per round (and progress lines while one runs). A reply whose SVG is refused or
    can't be drawn goes back to Claude as feedback; a reply cut off before there is any
    drawing is asked for again (CUT_OFF_RETRIES).
    ValueError if no round gave a usable SVG; API errors (anthropic.APIError) pass through.
    """
    intro = "The images above are the tournament's existing logos: match their style. " if references else ""
    first = (
        f"{intro}Draw the logo of the team «{name}».\n\n{style_rules(name)}\n\n"
        "Reply with at most three short lines on the idea, then the SVG in one ```svg code block."
    )
    messages = [{"role": "user", "content": [*references, {"type": "text", "text": first}]}]
    svg, problem = None, None
    retries = CUT_OFF_RETRIES
    round_no = -1
    while round_no < REVIEW_ROUNDS:
        round_no += 1
        label = "drawing" if round_no == 0 else f"review {round_no}"
        try:
            message, note = _ask(client, messages, system_prompt(look), log, label)
        except CutOffError as err:
            if svg is None and retries:
                retries -= 1
                round_no -= 1  # the same request again: a retry is not a review
                log(f"{label}: {err}; asking again")
                continue
            if svg is None:
                raise
            log(f"{label}: {err}; keeping the previous drawing")
            break
        except (ValueError, anthropic.APIError, httpx.HTTPError) as err:
            if svg is None:
                raise
            log(f"{label}: {err}; keeping the previous drawing")  # it is paid for
            break
        messages.append({"role": "assistant", "content": message.content})
        text = "".join(block.text for block in message.content if block.type == "text")
        if svg is not None and text.strip().strip(".").upper() == APPROVED:
            log(f"review {round_no}: approved ({note})")
            return svg
        try:
            candidate = extract_svg(text)
            check_svg(candidate)
            image = render_svg(candidate, RENDER_SIDE)
        except ValueError as err:
            problem = str(err)
            log(f"{label}: unusable ({problem}; {note})")
            messages.append(
                {
                    "role": "user",
                    "content": f"That reply can't be used: {problem}. Reply with the complete SVG in one "
                    "```svg code block, following every rule.",
                }
            )
            continue
        if svg is None:  # the first usable drawing, whichever round it came in
            unreviewed = round_no == REVIEW_ROUNDS
            log(
                f"drawn ({note})" + ("; not reviewed: unusable replies used up the review rounds" if unreviewed else "")
            )
        else:
            log(f"review {round_no}: revised ({note})")
        svg = candidate
        if round_no < REVIEW_ROUNDS:
            messages.append(_review_message(name, image, look.grey, round_no + 1))
    if svg is None:
        raise ValueError(problem or "no usable SVG")
    return svg


def save_draft(slug: str, team_id: str, svg: str) -> Path:
    """Write a team's draft; a draft already there is kept as <team_id>.1.svg (.2.svg, …), never overwritten."""
    path = draft_path(slug, team_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        n = 1
        while (old := path.with_name(f"{team_id}.{n}.svg")).exists():
            n += 1
        path.rename(old)
    path.write_text(svg, encoding="utf-8")
    return path


@dataclass(frozen=True)
class DraftOutcome:
    team: Team
    path: Path | None = None  # the saved draft
    error: str = ""  # why there is none: an API error, or no usable drawing
    skipped: bool = False  # never started: the API had refused the key


def draw_drafts(
    client: anthropic.Anthropic,
    slug: str,
    teams: list[Team],
    references: list[dict[str, Any]],
    look: LogoLook = DEFAULT_LOOK,
    log: Callable[[Team, str, bool], None] = lambda team, line, problem: None,
) -> list[DraftOutcome]:
    """Draw these teams' logos, PARALLEL at a time, and save each as a draft; one outcome per team.

    `log(team, line, problem)` gets each team's progress lines and its result as they happen
    (`problem` marks an API error or no usable drawing). A refused API key stops the teams
    not started yet and raises anthropic.AuthenticationError.
    """
    key_refused = threading.Event()

    def draw_one(team: Team) -> Path | None:
        if key_refused.is_set():
            return None
        try:
            svg = draw_logo(client, team.name, references, look, lambda line: log(team, line, False))
        except anthropic.AuthenticationError:
            key_refused.set()
            raise
        return save_draft(slug, team.team_id, svg)

    outcomes: dict[str, DraftOutcome] = {}
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futures = {pool.submit(draw_one, t): t for t in teams}
        try:
            for future in as_completed(futures):
                team = futures[future]
                try:
                    path = future.result()
                except anthropic.AuthenticationError:
                    raise
                except (anthropic.APIError, httpx.HTTPError) as err:
                    outcome = DraftOutcome(team, error=f"API error ({type(err).__name__}); try again later")
                except OSError as err:
                    outcome = DraftOutcome(team, error=f"could not save the draft ({err})")
                except ValueError as err:
                    outcome = DraftOutcome(team, error=f"no usable drawing ({err}); try again")
                else:
                    outcome = DraftOutcome(team, path=path, skipped=path is None)
                if outcome.error:
                    log(team, outcome.error, True)
                elif outcome.path:
                    log(team, f"saved {outcome.path}", False)
                outcomes[team.team_id] = outcome
        except BaseException:
            pool.shutdown(cancel_futures=True)  # Ctrl-C must not leave queued teams drawing, and billing
            raise
    return [outcomes[t.team_id] for t in teams]


def write_brief(out: Path, folder: Path, slug: str, teams: list[Team], look: LogoLook = DEFAULT_LOOK) -> Path:
    """Instructions for drawing these teams' logos in a Claude Code session (no API key needed)."""
    root = logos.LOGO_LIBRARY.parent
    review = Path(out).parent  # the review images go next to the brief
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
        "Write each one as an SVG file at the path given, one file per team, by hand: draw each",
        "logo on its own (no shared template). If a file is already there, move it to",
        "`<team_id>.1.svg` (or the next free number) first: drafts are never overwritten.",
        "",
        "## How they are used",
        "",
        system_prompt(look),
        "",
        f"## Review each drawing (up to {REVIEW_ROUNDS} times, or until it passes)",
        "",
        "Render it, look at it at full size and pale at card size, and fix what fails:",
        "",
        "```",
        'uv run python -c "from chgk.svg import open_svg; from chgk.logos import pale; '
        f"im = open_svg('<file>', {RENDER_SIDE}); im.save('{review}/review-full.png'); "
        f"card = pale(im, {look.grey}); card.thumbnail(({CARD_SIDE}, {CARD_SIDE})); "
        f"card.save('{review}/review-card.png')\"",
        "```",
        "",
        review_checklist("<the team name>"),
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
        cut = stem[: STEM_LENGTH + 1]
        stem = cut.rsplit("-", 1)[0] if "-" in cut else stem[:STEM_LENGTH]  # whole words where there are any
    return stem or "team"


def _free_name(stem: str, folders: tuple[Path, ...], taken: set[str]) -> str:
    """`<stem>.svg`, or with -2, -3, …: another tournament's logo in the shared library is never overwritten."""
    name, n = f"{stem}.svg", 1
    while name in taken or any((base / name).exists() for base in folders):
        n += 1
        name = f"{stem}-{n}.svg"
    return name


def accept_drafts(teams_path: Path, slug: str, teams: list[Team], team_ids: list[str] | None) -> list[Team]:
    """Move drafts into logos/ and record them in teams.py; `team_ids` None means every draft.

    Returns the teams that got a new logo. A draft whose SVG is refused or can't be drawn
    is an error, and nothing is changed.
    """
    drafts = existing_drafts(slug, teams)
    if team_ids is not None:
        team_ids = list(dict.fromkeys(team_ids))  # A01,A01 means A01 once
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
        # In the tournament's folder too: resolve_logo looks there first, and would hide the new logo.
        clash = any((base / name).exists() for base in (logos.LOGO_LIBRARY, teams_path.parent))
        if (clash and team.logo_file != name) or name in taken:
            own = f"{file_stem(team.name)}-{tid.lower()}"
            folders = (logos.LOGO_LIBRARY, teams_path.parent)
            name = f"{own}.svg" if team.logo_file == f"{own}.svg" else _free_name(own, folders, taken)
        taken.add(name)
        shutil.move(drafts[tid], logos.LOGO_LIBRARY / name)
        by_id[tid] = replace(team, logo_file=name)
        accepted.append(by_id[tid])
    write_teams(teams_path, [by_id[t.team_id] for t in teams])
    return accepted
