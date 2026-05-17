/**
 * storage.js v4
 * state.json  : Bot状態（メッセージID・ハッシュ等）
 * notices.json: 通知設定（eventId → [{roleId, minutesBefore, fired}]）
 */
const fs   = require("fs");
const path = require("path");
const DATA = path.join(__dirname, "../data");

function read(file) {
  const p = path.join(DATA, file);
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return {}; }
}

function write(file, data) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 2), "utf-8");
}

// ── state ──────────────────────────────────────────────
function loadState()        { return read("state.json"); }
function saveState(partial) { write("state.json", { ...loadState(), ...partial, updatedAt: new Date().toISOString() }); }

// ── notices ────────────────────────────────────────────
// 構造: { [eventId]: [ { roleId, minutesBefore, firedAt? } ] }
function loadNotices()          { return read("notices.json"); }
function saveNotices(data)      { write("notices.json", data); }

function getNoticesForEvent(eventId) {
  return loadNotices()[eventId] || [];
}

function setNoticesForEvent(eventId, notices) {
  const all = loadNotices();
  if (!notices || notices.length === 0) {
    delete all[eventId];
  } else {
    all[eventId] = notices;
  }
  saveNotices(all);
}

function deleteNoticesForEvent(eventId) {
  const all = loadNotices();
  delete all[eventId];
  saveNotices(all);
}

function markNoticeFired(eventId, index) {
  const all = loadNotices();
  if (all[eventId]?.[index]) {
    all[eventId][index].firedAt = new Date().toISOString();
    saveNotices(all);
  }
}

function resetFiredForEvent(eventId) {
  const all = loadNotices();
  if (all[eventId]) {
    all[eventId] = all[eventId].map(n => {
      const copy = { roleId: n.roleId, minutesBefore: n.minutesBefore };
      if (n.targetType) copy.targetType = n.targetType;
      return copy;
    });
    saveNotices(all);
  }
}

function deleteNoticeEntry(eventId, index) {
  const all = loadNotices();
  if (all[eventId]) {
    all[eventId].splice(index, 1);
    if (all[eventId].length === 0) delete all[eventId];
    saveNotices(all);
  }
}

module.exports = {
  loadState, saveState,
  loadNotices, getNoticesForEvent, setNoticesForEvent,
  deleteNoticesForEvent, markNoticeFired,
  resetFiredForEvent, deleteNoticeEntry,
};
