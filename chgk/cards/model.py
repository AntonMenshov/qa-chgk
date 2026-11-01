"""The cards each team gets: numbered cards for every question, then spares."""

from dataclasses import dataclass

from chgk.config import Tournament
from chgk.ids import CardId
from chgk.teams import Team


@dataclass(frozen=True)
class Card:
    team: Team
    id: CardId
    round: int | None = None  # None for spares

    def __post_init__(self) -> None:
        if self.team.team_id != self.id.team_id:  # its name would print on another team's QR code
            raise ValueError(f"card of team {self.id.team_id} made for team {self.team.team_id}")
        if (self.round is None) != self.is_spare:
            raise ValueError("a numbered card has a round, and a spare has none")

    @property
    def is_spare(self) -> bool:
        return self.id.spare is not None


def spare_card(tid: str, team: Team, n: int) -> Card:
    return Card(team, CardId(tid, team.team_id, spare=n))


def team_deck(tournament: Tournament, tid: str, team: Team) -> list[Card]:
    rounds = [r for r, size in enumerate(tournament.round_sizes, start=1) for _ in range(size)]
    numbered = [Card(team, CardId(tid, team.team_id, question=q), r) for q, r in enumerate(rounds, start=1)]
    spares = [spare_card(tid, team, n) for n in range(1, tournament.spares_per_team + 1)]
    return numbered + spares
