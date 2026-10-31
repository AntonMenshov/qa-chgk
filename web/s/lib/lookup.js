// «Чья карточка?»: what a scanned code is, in words, with nothing recorded and the current
// question left alone. Works without a session too (before setup: no team names, only
// what the QR code itself holds).

import {decodeBoard, decodeCard, decodeSetup} from './payload.js';
import {NOT_A_MARK} from '../../shared/logic.js';
import {statusOf, STATUS_LABEL} from './marks.js';

/**
 * @param {string} text        the scanned QR code
 * @param {import('./session.js').Session|null} session  this phone's tournament, if set up
 * @returns {{tone: "ok"|"warn"|"bad", title: string, details: string[]}}
 */
export function identify(text, session = null) {
  const setup = decodeSetup(text);
  if (setup) {
    return {tone: 'warn', title: 'QR «Доступ жюри»', details: [`Турнир ${setup.tid}. Это не карточка команды.`]};
  }
  const board = decodeBoard(text);
  if (board) {
    return {tone: 'warn', title: 'QR табло', details: [`Турнир ${board.tid}. Ссылка для проектора, не карточка.`]};
  }
  const c = decodeCard(text);
  if (!c) {
    return {tone: 'bad', title: 'Не карточка ЧГК', details: []};
  }

  const which =
    c.spare !== null ? `Запасная карточка №${c.spare}: номер вопроса вписан от руки` : `Вопрос ${c.question}`;
  if (!session) {
    return {tone: 'ok', title: `Команда ID ${c.teamId}`, details: [which, `Турнир ${c.tid}`]};
  }
  if (c.tid !== session.tid) {
    return {
      tone: 'bad',
      title: 'Карточка другого турнира',
      details: [`Турнир ${c.tid} (здесь ${session.tid})`, `Команда ID ${c.teamId} · ${which}`],
    };
  }
  const team = session.byId.get(c.teamId);
  if (!team) {
    return {tone: 'bad', title: `Команда ID ${c.teamId}`, details: ['Нет в списке команд этого турнира', which]};
  }

  const id =
    `ID ${team.team_id}` +
    (team.reserve && !session.isPlaying(team) ? ' · запасной комплект, команда ещё не названа' : '');
  const unnamed = team.reserve && !session.isPlaying(team);
  if (c.spare !== null) {
    return {tone: unnamed ? 'warn' : 'ok', title: team.name, details: [which, id]};
  }
  if (c.question > session.total) {
    return {tone: 'bad', title: team.name, details: [`Вопрос ${c.question}, а в турнире всего ${session.total}`, id]};
  }
  const value = session.valueOf(team.team_id, c.question);
  const status = statusOf(value);
  return {
    tone: unnamed || value === NOT_A_MARK ? 'warn' : 'ok',
    title: team.name,
    details: [
      `Вопрос ${c.question} · тур ${session.roundOf(c.question)}`,
      id,
      value === NOT_A_MARK
        ? 'В таблице непонятное значение: исправьте его там'
        : status
          ? `Отметка: ${STATUS_LABEL[status]}`
          : 'Отметки пока нет',
    ],
  };
}
