/**
 * embed.js v4
 */
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  RoleSelectMenuBuilder, UserSelectMenuBuilder,
} = require("discord.js");
const { formatEvent } = require("./calendar");
const { getNoticesForEvent } = require("./storage");

// 通知時間の简易表示ラベル
function minutesToShort(m) {
  if (m < 60) return `${m}分`;
  const h = m / 60;
  return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
}

// イベントの通知設定をコンパクトな文字列に変換
function buildNoticeSummary(guildId, eventId) {
  const notices = getNoticesForEvent(guildId, eventId);
  if (!notices || notices.length === 0) return "";
  const parts = notices.map(n => {
    const mention = n.roleId === "@everyone" || n.roleId === "@here"
      ? n.roleId
      : n.targetType === "user" ? `<@${n.roleId}>` : `<@&${n.roleId}>`;
    return `${mention}/${minutesToShort(n.minutesBefore)}`;
  });
  return "🔔" + parts.join(" ");
}

function buildCalendarEmbed(guildId, events, year, month) {
  const now        = new Date();
  const isThisMonth = now.getFullYear() === year && now.getMonth() + 1 === month;
  const todayDate  = now.getDate();
  const monthNames = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
  const label      = isThisMonth ? "今月" : (now.getFullYear() === year && month === now.getMonth() + 2) ? "来月" : `${year}年`;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📅  ${year}年 ${monthNames[month-1]}　${label}`)
    .setTimestamp();

  if (events.length === 0) {
    embed.setDescription("この月の予定はありません。");
    return embed;
  }

  // 開始時刻順にソート
  const sorted = [...events].sort((a, b) => {
    const ta = new Date(a.start.dateTime || a.start.date).getTime();
    const tb = new Date(b.start.dateTime || b.start.date).getTime();
    return ta - tb;
  });

  const lines = [];
  let lastDay = null;
  let lastDayEventCount = 0;
  for (const event of sorted) {
    const f       = formatEvent(event);
    const isToday = isThisMonth && f.d === todayDate;
    const dot     = f.w === "日" ? "🔴" : f.w === "土" ? "🔵" : "▫️";
    const todayMark = isToday ? " 📍今日" : "";

    // 日付ヘッダーは日付が変わったときのみ出力
    if (f.d !== lastDay) {
      if (lastDay !== null) lines.push("");
      lines.push(`${dot} **${f.d}** ${f.w}${todayMark}`);
      lastDay = f.d;
      lastDayEventCount = 0;
    }

    // 同じ日の2件目以降は空行で区切る
    if (lastDayEventCount > 0) lines.push("");
    lastDayEventCount++;

    const noticeStr   = buildNoticeSummary(guildId, event.id);
    const noticeCount = getNoticesForEvent(guildId, event.id).length;
    lines.push(`　\`${f.timeStr}\`　${f.title}${noticeStr && noticeCount <= 1 ? "　" + noticeStr : ""}`);
    if (f.desc) lines.push(`　${f.desc.replace(/^\n　/, "")}`);
    if (noticeStr && noticeCount > 1) lines.push(`　${noticeStr}`);
  }
  lines.push("");

  const desc = lines.join("\n");
  embed.setDescription(desc.length > 4000 ? desc.substring(0, 3990) + "\n…（省略）" : desc);
  return embed;
}

function buildCalendarButtons(year, month) {
  const prev = month === 1  ? { y: year-1, m: 12 } : { y: year, m: month-1 };
  const next = month === 12 ? { y: year+1, m: 1  } : { y: year, m: month+1 };
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_prev_${prev.y}_${prev.m}`).setLabel(`◀ ${prev.m}月`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_next_${next.y}_${next.m}`).setLabel(`${next.m}月 ▶`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("btn_refresh").setLabel("🔄 更新").setStyle(ButtonStyle.Primary),
  );
}

function buildStatusEmbed(guildId, events, lastUpdated, botRoleName, online = true) {
  const now        = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const upcoming   = events
    .filter(e => e.start.dateTime ? new Date(e.start.dateTime) > now : new Date(e.start.date) >= todayStart)
    .sort((a, b) => new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date));
  const next       = upcoming[0];
  let nextStr = "なし";
  if (next) {
    const f         = formatEvent(next);
    const noticeStr = buildNoticeSummary(guildId, next.id);
    const desc      = f.desc ? f.desc.replace(/^\n　/, "") : "";
    const baseInfo  = `${f.d}日(${f.w}) ${f.title}　\`${f.timeStr}\``;
    const indent    = "　　　　 "; // ⏭️ 直近　 の幅に合わせたインデント

    const nextLines = [baseInfo];
    if (desc)      nextLines.push(`${indent}${desc}`);
    if (noticeStr) nextLines.push(`${indent}${noticeStr}`);

    nextStr = nextLines.join("\n");
  }
  const jst = d => new Date(d).toLocaleString("ja-JP", { timeZone:"Asia/Tokyo", month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" });

  return new EmbedBuilder()
    .setColor(online ? 0x2b2d31 : 0x747f8d)
    .setDescription(
      `${online ? "🟢 **Bot稼働中**" : "🔴 **Bot停止中**"}\n` +
      `📆 今月　**${events.length}件**　残り **${upcoming.length}件**\n` +
      `⏭️ 直近　${nextStr}\n` +
      `🔃 最終同期　${lastUpdated ? jst(lastUpdated) : "未取得"}\n` +
      `🔐 操作権限　\`${botRoleName || "CalendarOperator"}\` ロール保持者・管理者`
    );
}

function buildActionButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("btn_add").setLabel("➕ 予定を追加").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("btn_edit_select").setLabel("✏️ 編集").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("btn_delete_select").setLabel("🗑️ 削除").setStyle(ButtonStyle.Danger),
  );
}

function buildSelectMenu(events, customId, placeholder) {
  if (events.length === 0) return null;
  const options = events.slice(0, 25).map(e => {
    const f = formatEvent(e);
    return {
      label: `${f.d}日(${f.w}) ${f.title}`.substring(0, 100),
      description: (f.timeStr + (f.desc ? "　" + f.desc.replace(/\n　/,"") : "")).substring(0, 100),
      value: e.id,
    };
  });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options)
  );
}

/**
 * 通知設定 - ロール選択ステップ
 * @returns {ActionRowBuilder[]} [roleSelectRow, specialRolesAndSkipRow]
 */
function buildRoleSelectForNotify(eventId) {
  const roleRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId(`select_notify_role_${eventId}`)
      .setPlaceholder("🔔 通知するロールを選択")
      .setMinValues(1)
      .setMaxValues(1)
  );
  const userRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`select_notify_user_${eventId}`)
      .setPlaceholder("👤 個人に通知するユーザーを選択")
      .setMinValues(1)
      .setMaxValues(1)
  );
  const specialRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_notify_everyone_${eventId}`).setLabel("@everyone").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_notify_here_${eventId}`).setLabel("@here").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`btn_notify_skip_${eventId}`).setLabel("スキップ（通知なし）").setStyle(ButtonStyle.Danger),
  );
  return [roleRow, userRow, specialRow];
}

/**
 * 通知設定 - 時間選択ステップ
 * @returns {ActionRowBuilder[]} [時間ボタン行1, 時間ボタン行2]
 */
function buildNotifyTimeButtons(eventId, targetId, targetType = "role") {
  // ユーザーは btn_notify_u_ プレフィックス、ロールは btn_notify_t_
  const p = targetType === "user" ? "btn_notify_u" : "btn_notify_t";
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_10`).setLabel("10分前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_30`).setLabel("30分前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_60`).setLabel("1時間前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_180`).setLabel("3時間前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_360`).setLabel("6時間前").setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_720`).setLabel("12時間前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_1440`).setLabel("24時間前").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${p}_${eventId}_${targetId}_2880`).setLabel("48時間前").setStyle(ButtonStyle.Secondary),
  );
  return [row1, row2];
}

function buildNoticeManageComponents(guildId, eventId) {
  const notices = getNoticesForEvent(guildId, eventId);
  const lines = ["📋 **現在の通知設定**"];
  if (notices.length === 0) {
    lines.push("　設定なし");
  } else {
    notices.forEach((n, i) => {
      const mention = n.roleId === "@everyone" || n.roleId === "@here"
        ? n.roleId : n.targetType === "user" ? `<@${n.roleId}>` : `<@&${n.roleId}>`;
      const timeLabel = n.minutesBefore >= 60
        ? `${n.minutesBefore / 60}時間前` : `${n.minutesBefore}分前`;
      lines.push(`　${i + 1}. ${mention}  /  ${timeLabel}`);
    });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`btn_nmgr_add_${eventId}`).setLabel("➕ 追加").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`btn_nmgr_del_${eventId}`).setLabel("🗑️ 削除").setStyle(ButtonStyle.Danger).setDisabled(notices.length === 0),
    new ButtonBuilder().setCustomId(`btn_nmgr_done_${eventId}`).setLabel("✅ 完了").setStyle(ButtonStyle.Primary),
  );
  return { content: lines.join("\n"), components: [row] };
}

module.exports = {
  buildCalendarEmbed, buildCalendarButtons,
  buildStatusEmbed, buildActionButtons, buildSelectMenu,
  buildRoleSelectForNotify, buildNotifyTimeButtons,
  buildNoticeManageComponents,
};
