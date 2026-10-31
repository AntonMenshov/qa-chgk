// The public results: a separate Sheet with only «Итоги», the round tabs and «Статистика», as
// values. Anyone with its link may view it. The real Sheet stays private: a viewer can download
// hidden tabs too (disputes, jurors, devices, photo links), so hiding them protects nothing.

const PUBLISH_EVERY_MS = 30000; // each publication is two Sheets API calls (quota: 60 per minute)
const SPARE_ROWS = 10; // written blank below the teams: a row deleted from the real Sheet goes here too

/** The tabs the public copy has: [{name, cols}]. */
function publicTabs_(sizes) {
  return [{name: TABS.summary, cols: summaryLayout(sizes).width}]
    .concat(sizes.map((_, i) => ({name: roundSheetName(i + 1), cols: roundLayout(sizes, i + 1).width})))
    .concat([{name: TABS.stats, cols: 4}]);
}

/** Create the public copy in the tournament's folder, with the real tabs' look; returns its ID. */
function createPublicCopy_(ss, reg, name) {
  const copy = SpreadsheetApp.create(name);
  const file = DriveApp.getFileById(copy.getId());
  file.moveTo(DriveApp.getFolderById(reg.folder_id));
  const blank = copy.getSheets()[0];
  publicTabs_(reg.round_sizes).forEach((tab) => {
    ss.getSheetByName(tab.name).copyTo(copy).setName(tab.name);
  });
  copy.deleteSheet(blank);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return copy.getId();
}

/** Copy the computed values across: a failure only leaves the public copy behind for a while. */
function publish_(ss, reg, props) {
  if (!reg.public_id) {
    return;
  }
  try {
    timed_('publish', () => {
      SpreadsheetApp.flush();
      const tabs = publicTabs_(reg.round_sizes);
      const blocks = readBlocks_(
        ss,
        tabs.map((tab) => ({name: tab.name, row: 1, col: 1, cols: tab.cols})),
      );
      const w = writer_(open_({spreadsheet_id: reg.public_id}));
      tabs.forEach((tab, i) => {
        const blank = Array.from({length: SPARE_ROWS}, () => new Array(tab.cols).fill(''));
        w.set(tab.name, 1, 1, blocks[i].concat(blank));
      });
      w.flush();
      SpreadsheetApp.flush();
    });
    props.setProperty(`pub:${reg.tid}`, String(Date.now()));
    props.deleteProperty(`dirty:${reg.tid}`);
  } catch (err) {
    Logger.log(`publish ${reg.tid}: ${err}`);
  }
}

/** The marks changed: the next request after the pause publishes them. */
function markUnpublished_(props, reg) {
  if (reg.public_id) {
    props.setProperty(`dirty:${reg.tid}`, '1');
  }
}

/** After a request: publish if something changed and the pause is over; never waits for the lock. */
function publishIfDue_(ss, reg, props) {
  if (!reg.public_id || !props.getProperty(`dirty:${reg.tid}`)) {
    return;
  }
  if (Date.now() - Number(props.getProperty(`pub:${reg.tid}`) || 0) < PUBLISH_EVERY_MS) {
    return;
  }
  const lock = LockService.getScriptLock();
  if (lock.tryLock(0)) {
    try {
      publish_(ss, reg, props);
    } finally {
      lock.releaseLock();
    }
  }
}

/** `chgk results-copy`: a tournament made before public copies gets one; its real Sheet turns private. */
function makePublicCopy_(ss, reg, props) {
  if (reg.public_id) {
    return {ok: true, public_id: reg.public_id, existed: true};
  }
  const real = SpreadsheetApp.openById(reg.spreadsheet_id);
  const name = driveNames(reg.tid, reg.name, reg.date).results;
  reg.public_id = createPublicCopy_(real, reg, name);
  saveRegistry_(reg);
  publish_(ss, reg, props);
  DriveApp.getFileById(reg.spreadsheet_id).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.EDIT);
  return {ok: true, public_id: reg.public_id, existed: false};
}
