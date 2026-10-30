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

    @property
    def is_spare(self) -> bool:
        return self.id.spare is not None


def spare_card(tid: str, team: Team, n: int) -> Card:
    return Card(team, CardId(tid, team.team_id, spare=n))


def team_deck(tournament: Tournament, tid: str, team: Team) -> list[Card]:
    numbered = [
        Card(team, CardId(tid, team.team_id, question=q), tournament.round_of(q))
        for q in range(1, tournament.total_questions + 1)
    ]
    spares = [spare_card(tid, team, n) for n in range(1, tournament.spares_per_team + 1)]
    return numbered + spares
