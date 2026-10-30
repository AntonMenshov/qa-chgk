// What a scanned QR code means. Mirrors chgk/ids.py; both are checked against
// tests/vectors/qr_payloads.json and tests/vectors/jury_links.json.
//
// Card:       <scanner_url>#<TID>.<TEAM>.<Q>     (Q = question number, or S<n> for a spare card)
// Jury link:  <scanner_url>#setup=<TID>.<JURY_TOKEN>.<DEPLOYMENT_ID>
// Board link: <board_url>?grid=<N>#board=<TID>.<BOARD_TOKEN>.<DEPLOYMENT_ID>  (tests/vectors/board_links.json)

const TID = '[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}';
const CARD_RE = new RegExp(`^(${TID})\\.([0-9A-Z]{1,8})\\.(?:([1-9][0-9]{0,2})|S([1-9][0-9]?))$`);
const SETUP_RE = new RegExp(`^setup=(${TID})\\.([A-Za-z0-9_-]{16,})\\.([A-Za-z0-9_-]{10,})$`);
const BOARD_RE = new RegExp(`^board=(${TID})\\.([A-Za-z0-9_-]{16,})\\.([A-Za-z0-9_-]{10,})$`);

const fragment = (text) => {
  const s = String(text || '');
  const hash = s.lastIndexOf('#');
  return hash >= 0 ? s.slice(hash + 1) : s;
};

/** {tid, teamId, question, spare} for an answer card, or null. Exactly one of question/spare is set. */
export function decodeCard(text) {
  const m = CARD_RE.exec(fragment(text));
  if (!m) {
    return null;
  }
  return {
    tid: m[1],
    teamId: m[2],
    question: m[3] ? Number(m[3]) : null,
    spare: m[4] ? Number(m[4]) : null,
  };
}

/** {tid, juryToken, backendUrl} for a jury setup link, or null. */
export function decodeSetup(text) {
  const m = SETUP_RE.exec(fragment(text));
  if (!m) {
    return null;
  }
  return {tid: m[1], juryToken: m[2], backendUrl: `https://script.google.com/macros/s/${m[3]}/exec`};
}

/**
 * The projector board link, built exactly as chgk/ids.py encode_board_link builds it for
 * the jury sheet (checked against the shared vectors), from the board page's own address.
 */
export function encodeBoardLink(boardPageUrl, access, gridMax) {
  const m = /\/macros\/s\/([A-Za-z0-9_-]+)\/exec$/.exec(access.backendUrl);
  if (!m) {
    throw new Error(`not an Apps Script web app URL: ${access.backendUrl}`);
  }
  return `${boardPageUrl}?grid=${gridMax}#board=${access.tid}.${access.boardToken}.${m[1]}`;
}

/** {tid, boardToken, backendUrl} for a projector board link, or null. */
export function decodeBoard(text) {
  const m = BOARD_RE.exec(fragment(text));
  if (!m) {
    return null;
  }
  return {tid: m[1], boardToken: m[2], backendUrl: `https://script.google.com/macros/s/${m[3]}/exec`};
}
