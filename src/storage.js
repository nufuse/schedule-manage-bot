/**
 * storage.js v5
 * per-guild データストレージ
 * data/{guildId}/state.json   : Bot状態（メッセージID・ハッシュ等）
 * data/{guildId}/notices.json : 通知設定（eventId → [{roleId, minutesBefore, firedAt?}]）
 */
const fs   = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "../data");

function read(guildId, file) {
  const p = path.join(DATA, guildId, file);
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return {}; }
}

function write(guildId, file, data) {
  const dir = path.join(DATA, guildId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data, null, 2), "utf-8");
}

// ── state ──────────────────────────────────────────────
function loadState(guildId)          { return read(guildId, "state.json"); }
function saveState(guildId, partial) { write(guildId, "state.json", { ...loadState(guildId), ...partial, updatedAt: new Date().toISOString() }); }

// ── notices ────────────────────────────────────────────
// 構造: { [eventId]: [ { roleId, minutesBefore, firedAt? } ] }
function loadNotices(guildId)         { return read(guildId, "notices.json"); }
function saveNotices(guildId, data)   { write(guildId, "notices.json", data); }

function getNoticesForEvent(guildId, eventId) {
  return loadNotices(guildId)[eventId] || [];
}

function setNoticesForEvent(guildId, eventId, notices) {
  const all = loadNotices(guildId);
  if (!notices || notices.length === 0) {
    delete all[eventId];
  } else {
    all[eventId] = notices;
  }
  saveNotices(guildId, all);
}

function deleteNoticesForEvent(guildId, eventId) {
  const all = loadNotices(guildId);
  delete all[eventId];
  saveNotices(guildId, all);
}

function markNoticeFired(guildId, eventId, index) {
  const all = loadNotices(guildId);
  if (all[eventId]?.[index]) {
    all[eventId][index].firedAt = new Date().toISOString();
    saveNotices(guildId, all);
  }
}

function resetFiredForEvent(guildId, eventId) {
  const all = loadNotices(guildId);
  if (all[eventId]) {
    all[eventId] = all[eventId].map(n => {
      const copy = { roleId: n.roleId, minutesBefore: n.minutesBefore };
      if (n.targetType) copy.targetType = n.targetType;
      return copy;
    });
    saveNotices(guildId, all);
  }
}

function deleteNoticeEntry(guildId, eventId, index) {
  const all = loadNotices(guildId);
  if (all[eventId]) {
    all[eventId].splice(index, 1);
    if (all[eventId].length === 0) delete all[eventId];
    saveNotices(guildId, all);
  }
}

module.exports = {
  loadState, saveState,
  loadNotices, getNoticesForEvent, setNoticesForEvent,
  deleteNoticesForEvent, markNoticeFired,
  resetFiredForEvent, deleteNoticeEntry,
};
