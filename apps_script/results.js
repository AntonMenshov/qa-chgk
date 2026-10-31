// The public results: a separate Sheet with only «Итоги», the round tabs and «Статистика», as
// values. Anyone with its link may view it. The real Sheet stays private: a viewer can download
// hidden tabs too (disputes, jurors, devices, photo links), so hiding them protects nothing.

const PUBLISH_EVERY_MS = 30000; // each publication is two Sheets API calls (quota: 60 per minute)
const TIMER_PROPERTY = 'pub_timer';
const TIMER_AFTER_MS = 60000;
const TIMER_MAX_AGE_MS = 300000; // armed longer ago than this: it was lost, arm another
const GIVE_UP_TIMER_MS = 3600000; // changed this long ago and still failing: only reads retry, no more timers

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
      const copy = open_({spreadsheet_id: reg.public_id});
      const w = writer_(copy);
      tabs.forEach((tab, i) => {
        // Blank down to the copy's last row: rows deleted from the real Sheet go here too.
        const stale = (copy.getSheetByName(tab.name)?.getLastRow() || 0) - blocks[i].length;
        const blank = Array.from({length: Math.max(stale, 0)}, () => new Array(tab.cols).fill(''));
        w.set(tab.name, 1, 1, blocks[i].concat(blank));
      });
      w.flush();
      SpreadsheetApp.flush();
      if (w.fellBack) {
        throw new Error('written the slow way: publish again'); // and still counts as unpublished
      }
    });
    props.setProperty(`pub:${reg.tid}`, String(Date.now()));
    props.deleteProperty(`dirty:${reg.tid}`);
  } catch (err) {
    Logger.log(`publish ${reg.tid}: ${err}`);
    props.setProperty(`pub:${reg.tid}`, String(Date.now())); // a pause before the next try, too
    markUnpublished_(props, reg);
  }
}

/**
 * The marks changed: the next read after the pause publishes them. If none comes (the last marks,
 * everyone gone home), a one-off timer does: at most one at a time, and it removes itself.
 */
function markUnpublished_(props, reg) {
  if (!reg.public_id) {
    return;
  }
  const since = Number(props.getProperty(`dirty:${reg.tid}`)) || Date.now();
  props.setProperty(`dirty:${reg.tid}`, String(since));
  if (Date.now() - since < GIVE_UP_TIMER_MS) {
    armTimer_(props);
  }
}

function armTimer_(props) {
  const armed = Number(props.getProperty(TIMER_PROPERTY) || 0);
  if (Date.now() - armed > TIMER_MAX_AGE_MS) {
    try {
      ScriptApp.newTrigger('publishWaiting').timeBased().after(TIMER_AFTER_MS).create();
      props.setProperty(TIMER_PROPERTY, String(Date.now()));
    } catch (err) {
      Logger.log(`publish timer: ${err}`); // the next read still publishes
    }
  }
}

/** The one-off timer: publish whatever still waits, on every tournament, then remove itself. */
function publishWaiting() {
  const props = PropertiesService.getScriptProperties();
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'publishWaiting')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  props.deleteProperty(TIMER_PROPERTY);
  try {
    withLock_(() => {
      props
        .getKeys()
        .filter((key) => key.startsWith('dirty:'))
        .forEach((key) => {
          const tid = key.slice('dirty:'.length);
          const raw = props.getProperty(`t:${tid}`);
          if (!raw) {
            props.deleteProperty(key);
            return;
          }
          const reg = registry_(props, tid);
          publish_(open_(reg), reg, props);
        });
    });
  } catch (err) {
    Logger.log(`publish timer: ${err}`); // the lock was busy: these are perhaps the last marks of the game
    armTimer_(props);
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
  // On the existed path too: a first run may have stopped before the Sheet turned private.
  if (reg.public_id) {
    DriveApp.getFileById(reg.spreadsheet_id).setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.EDIT);
    publish_(ss, reg, props);
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
