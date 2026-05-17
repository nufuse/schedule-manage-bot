/**
 * logger.js
 * console.log/warn/error をファイルにも記録する（日別ローテーション）
 * logs/YYYY-MM-DD.log に書き出し、KEEP_DAYS 日より古いファイルを自動削除
 */
const fs   = require("fs");
const path = require("path");

const LOG_DIR   = path.join(__dirname, "../logs");
const KEEP_DAYS = 7; // 保持する日数

let currentDate   = "";
let currentStream = null;

function getDateStr() {
  // "sv-SE" ロケールで "YYYY-MM-DD" を取得
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
}

function getStream() {
  const today = getDateStr();
  if (today !== currentDate) {
    if (currentStream) currentStream.end();
    fs.mkdirSync(LOG_DIR, { recursive: true });
    currentDate   = today;
    currentStream = fs.createWriteStream(
      path.join(LOG_DIR, `${today}.log`),
      { flags: "a", encoding: "utf-8" }
    );
    pruneOldLogs();
  }
  return currentStream;
}

function pruneOldLogs() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(LOG_DIR)) {
      if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue;
      const p = path.join(LOG_DIR, file);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch { /* ログ削除失敗は無視 */ }
}

function formatLine(level, args) {
  const ts  = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  const msg = args
    .map(a => {
      if (a instanceof Error) return a.stack || String(a);
      if (typeof a === "object" && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(" ");
  return `[${ts}] [${level}] ${msg}\n`;
}

// 元のメソッドを保持してからオーバーライド
const _log   = console.log.bind(console);
const _warn  = console.warn.bind(console);
const _error = console.error.bind(console);

console.log = (...args) => {
  _log(...args);
  try { getStream().write(formatLine("INFO",  args)); } catch { /* ignore */ }
};

console.warn = (...args) => {
  _warn(...args);
  try { getStream().write(formatLine("WARN",  args)); } catch { /* ignore */ }
};

console.error = (...args) => {
  _error(...args);
  try { getStream().write(formatLine("ERROR", args)); } catch { /* ignore */ }
};

/** グレースフルシャットダウン時にストリームを閉じる */
function close() {
  return new Promise(resolve => {
    if (currentStream) {
      currentStream.end(resolve);
      currentStream = null;
    } else {
      resolve();
    }
  });
}

module.exports = { close };
