// For `tsc` only: in Apps Script all files share one global scope (`chgk backend bundle` strips
// logic.js's `export`s), so its names are globals everywhere else.
import * as L from './logic.js';

declare global {
  const STATUS_VALUE: typeof L.STATUS_VALUE;
  const MAX_PHOTO_CHARS: typeof L.MAX_PHOTO_CHARS;
  const fail: typeof L.fail;
  const tokensEqual: typeof L.tokensEqual;
  const colLetter: typeof L.colLetter;
  const totalQuestions: typeof L.totalQuestions;
  const photoFileName: typeof L.photoFileName;
  const validateReserve: typeof L.validateReserve;
  const latinName: typeof L.latinName;
  const driveNames: typeof L.driveNames;
  const roundFormulas: typeof L.roundFormulas;
  const summaryFormulas: typeof L.summaryFormulas;
  const DRIVE_ROOT: typeof L.DRIVE_ROOT;
  const reservePlaceholder: typeof L.reservePlaceholder;
  const nameEdits: typeof L.nameEdits;
  const TOKEN_KINDS: typeof L.TOKEN_KINDS;
  const validateRequest: typeof L.validateRequest;
  const NOT_A_MARK: typeof L.NOT_A_MARK;
  const sentMarks: typeof L.sentMarks;
  const eventError: typeof L.eventError;
  const mergeCell: typeof L.mergeCell;
  const applyEvents: typeof L.applyEvents;
  const normalizeCellInput: typeof L.normalizeCellInput;
  const FIRST_MARK_COL: typeof L.FIRST_MARK_COL;
  const roundSheetName: typeof L.roundSheetName;
  const roundLayout: typeof L.roundLayout;
  const roundRow: typeof L.roundRow;
  const questionCell: typeof L.questionCell;
  const questionAt: typeof L.questionAt;
  const summaryLayout: typeof L.summaryLayout;
  const summaryRow: typeof L.summaryRow;
  const placeFormula: typeof L.placeFormula;
  const placeLabels: typeof L.placeLabels;
  const standings: typeof L.standings;
  const compareIds: typeof L.compareIds;
  const compareStandings: typeof L.compareStandings;
  const summarySortSpec: typeof L.summarySortSpec;
  const roundSortSpec: typeof L.roundSortSpec;
  const roundOrder: typeof L.roundOrder;
  const summaryOrder: typeof L.summaryOrder;
  const metaLayout: typeof L.metaLayout;
  const sheetEdits: typeof L.sheetEdits;
  const statsRows: typeof L.statsRows;
  const disputedKeys: typeof L.disputedKeys;
  const disputedSheet: typeof L.disputedSheet;
  const planTeamRows: typeof L.planTeamRows;
  const RequestError: typeof L.RequestError;
  type RequestError = L.RequestError;
}
