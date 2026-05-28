/**
 * guildConfig.js
 * per-guild 設定の読み書き
 * 保存先: data/{guildId}/config.json
 *
 * config 構造:
 * {
 *   channelId:        string   カレンダー投稿チャンネル
 *   calendarId:       string   Google Calendar ID
 *   notifyChannelId:  string|null  通知チャンネル（null → channelId と同じ）
 *   logChannelId:     string|null  ログチャンネル（null → ログなし）
 *   logEnabled:       boolean  ログ通知ON/OFF（省略時はON扱い）
 *   language:         "ja"|"en"  Bot表示言語（省略時はja）
 *   operatorRoleName: string   操作ロール名
 * }
 */
const fs   = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "../data");

function configPath(guildId) {
  return path.join(DATA, guildId, "config.json");
}

/**
 * @param {string} guildId
 * @returns {{ channelId, calendarId, notifyChannelId, logChannelId, logEnabled, language, operatorRoleName } | null}
 */
function loadConfig(guildId) {
  try {
    const p = configPath(guildId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { return null; }
}

function saveConfig(guildId, data) {
  const dir = path.join(DATA, guildId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(guildId), JSON.stringify(data, null, 2), "utf-8");
}

function deleteConfig(guildId) {
  const dir = path.join(DATA, guildId);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/**
 * config.json が存在するギルドIDの一覧を返す
 * @returns {string[]}
 */
function getAllGuildIds() {
  try {
    if (!fs.existsSync(DATA)) return [];
    return fs.readdirSync(DATA).filter(f => {
      const p = path.join(DATA, f, "config.json");
      return fs.existsSync(p);
    });
  } catch { return []; }
}

module.exports = { loadConfig, saveConfig, deleteConfig, getAllGuildIds };
