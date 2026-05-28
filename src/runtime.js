const { EmbedBuilder } = require("discord.js");
const { getLang, pick } = require("./i18n");

function getAndIncrementStartupCount(fs, path) {
  const dir  = path.join(__dirname, "../data");
  const file = path.join(dir, ".startup_count");
  let count  = 0;
  try {
    if (fs.existsSync(file)) count = parseInt(fs.readFileSync(file, "utf8").trim()) || 0;
    count++;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(count), "utf8");
  } catch {}
  return count;
}

function fmtTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function currentYM() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function hasPermission(member, operatorRoleName) {
  if (!member) return false;
  if (member.permissions.has(require("discord.js").PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some(r => r.name === operatorRoleName);
}

function normalizeTime(str) {
  if (!str) return "";
  str = str.trim();
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const digits = str.replace(/\D/g, "");
  if (/^\d{3,4}$/.test(digits)) {
    const padded = digits.padStart(4, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2)}`;
  }
  return str;
}

function isLogNotifyEnabled(cfg) {
  return Boolean(cfg?.logChannelId) && cfg.logEnabled !== false;
}

function normalizeSystemLogToggles(cfg) {
  return {
    startup: cfg?.systemLogToggles?.startup !== false,
    connection: cfg?.systemLogToggles?.connection !== false,
    error: cfg?.systemLogToggles?.error !== false,
  };
}

function isSystemLogEnabled(cfg, category) {
  if (!isLogNotifyEnabled(cfg)) return false;
  const toggles = normalizeSystemLogToggles(cfg);
  return toggles[category] !== false;
}

function fmtCd(content, n, lang = "ja") {
  return `${content}\n-# (${lang === "en" ? `Deletes in ${n}s` : `${n}秒後に消えます`})`;
}

function startCountdownDelete(interaction, content, seconds = 5, lang = "ja") {
  for (let i = seconds - 1; i >= 1; i--) {
    setTimeout(() => interaction.editReply({ content: fmtCd(content, i, lang) }).catch(() => {}), (seconds - i) * 1000);
  }
  setTimeout(() => interaction.deleteReply().catch(() => {}), seconds * 1000);
}

async function sendAuditLog(client, action, interaction, { title, dateStr, timeStr, desc }, config) {
  if (!isLogNotifyEnabled(config)) return;
  try {
    const lang = getLang(config);
    const ch = await client.channels.fetch(config.logChannelId);
    const colorMap = { "追加": 0x57f287, "変更": 0xfee75c, "削除": 0xed4245 };
    const iconMap  = { "追加": "📅", "変更": "✏️", "削除": "🗑️" };
    const actionEn = { "追加": "Added", "変更": "Updated", "削除": "Deleted" };
    const memberName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    let body = `**${title}**\n📅 ${dateStr}\u3000\`${timeStr}\``;
    if (desc) body += `\n📝 ${desc}`;
    const embed = new EmbedBuilder()
      .setColor(colorMap[action] ?? 0x5865f2)
      .setTitle(lang === "en" ? `${iconMap[action]} Event ${actionEn[action] || action}` : `${iconMap[action]} 予定${action}`)
      .setDescription(body)
      .setFooter({ text: `${memberName} (@${interaction.user.username})`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error("[AuditLog] 送信失敗:", e.message);
  }
}

function buildSystemLogMessage(kind, payload, lang) {
  switch (kind) {
    case "startup":
      return {
        title: payload.startupCount > 1
          ? (lang === "en" ? `🔄 Bot Restart (#${payload.startupCount})` : `🔄 Bot 再起動 (#${payload.startupCount})`)
          : (lang === "en" ? "✅ Bot Started" : "✅ Bot 起動"),
        description: lang === "en"
          ? `Login: **${payload.clientTag}**\nStarted at: ${payload.ts}\nPID: ${payload.pid}`
          : `ログイン: **${payload.clientTag}**\n起動時刻: ${payload.ts}\nPID: ${payload.pid}`,
      };
    case "disconnect":
      return {
        title: lang === "en" ? "⚠️ Discord Disconnected" : "⚠️ Discord 接続切断",
        description: lang === "en"
          ? `shard: ${payload.shardId} | code: ${payload.code}\nTime: ${payload.ts}`
          : `shard: ${payload.shardId} | code: ${payload.code}\n時刻: ${payload.ts}`,
      };
    case "reconnecting":
      return {
        title: lang === "en" ? "🔄 Discord Reconnecting..." : "🔄 Discord 再接続中…",
        description: lang === "en"
          ? `shard: ${payload.shardId}\nTime: ${payload.ts}`
          : `shard: ${payload.shardId}\n時刻: ${payload.ts}`,
      };
    case "resume":
      return {
        title: lang === "en" ? "✅ Discord Connection Resumed" : "✅ Discord 接続再開",
        description: lang === "en"
          ? `shard: ${payload.shardId} | replayed: ${payload.replayed}\nTime: ${payload.ts}`
          : `shard: ${payload.shardId} | replayed: ${payload.replayed}\n時刻: ${payload.ts}`,
      };
    case "error":
      return {
        title: lang === "en" ? "❌ Discord Error" : "❌ Discord エラー",
        description: lang === "en" ? `${payload.message}\nTime: ${payload.ts}` : `${payload.message}\n時刻: ${payload.ts}`,
      };
    case "shutdown":
      return {
        title: lang === "en" ? "🛑 Bot Stopping" : "🛑 Bot 停止",
        description: lang === "en"
          ? `Signal: ${payload.signal}\nTime: ${payload.ts}`
          : `シグナル: ${payload.signal}\n時刻: ${payload.ts}`,
      };
    default:
      return { title: "Bot", description: "" };
  }
}

async function sendSystemLog(client, color, kind, payload, category, getAllGuildIds, loadConfig) {
  for (const gid of getAllGuildIds()) {
    const cfg = loadConfig(gid);
    if (!isSystemLogEnabled(cfg, category)) continue;
    try {
      const lang = getLang(cfg);
      const msg  = buildSystemLogMessage(kind, payload, lang);
      const ch = await client.channels.fetch(cfg.logChannelId);
      await ch.send({
        embeds: [new EmbedBuilder().setColor(color).setTitle(msg.title).setDescription(msg.description).setTimestamp()]
      });
    } catch (e) {
      console.error(`[SystemLog][${gid}] 送信失敗: ${e.message}`);
    }
  }
}

function formatEventLocal(event, lang = "ja") {
  return require("./calendar").formatEvent(event, lang);
}

module.exports = {
  getAndIncrementStartupCount,
  fmtTimestamp,
  currentYM,
  hasPermission,
  normalizeTime,
  isLogNotifyEnabled,
  normalizeSystemLogToggles,
  isSystemLogEnabled,
  fmtCd,
  startCountdownDelete,
  sendAuditLog,
  sendSystemLog,
  formatEventLocal,
  getLang,
  pick,
};
