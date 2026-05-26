/**
 * notifier.js v5
 * per-guild 通知チェック・送信
 */
const { EmbedBuilder } = require("discord.js");
const { getMonthEvents, formatEvent } = require("./calendar");
const { loadNotices, markNoticeFired, deleteNoticesForEvent } = require("./storage");

/**
 * @param {Client} client
 * @param {string} guildId
 * @param {{ calendarId, notifyChannelId, channelId }} config
 */
async function checkAndFireNotices(client, guildId, config) {
  const notices = loadNotices(guildId);
  if (Object.keys(notices).length === 0) return;

  const now  = new Date();
  const year = now.getFullYear();

  const thisMonth = await getMonthEvents(config.calendarId, year, now.getMonth() + 1).catch(() => []);
  const nextMonth = await getMonthEvents(config.calendarId, year, now.getMonth() + 2).catch(() => []);
  const allEvents = [...thisMonth, ...nextMonth];
  const eventMap  = Object.fromEntries(allEvents.map(e => [e.id, e]));

  const hasNotifyChannel = !!config.notifyChannelId;
  const channelId = config.notifyChannelId || config.channelId;
  const channel   = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // 通知チャンネルあり → 7日、なし（カレンダーチャンネル）→ 1日
  const deleteAfterMs = hasNotifyChannel
    ? 7 * 24 * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;

  for (const [eventId, settings] of Object.entries(notices)) {
    const event = eventMap[eventId];
    if (!event) continue;

    const startMs = new Date(event.start.dateTime || event.start.date).getTime();

    const groups = new Map(); // minutesBefore → index[]
    for (let i = 0; i < settings.length; i++) {
      const s = settings[i];
      if (s.firedAt) continue;
      const notifyAt = startMs - s.minutesBefore * 60 * 1000;
      if (now.getTime() < notifyAt) continue;
      if (!groups.has(s.minutesBefore)) groups.set(s.minutesBefore, []);
      groups.get(s.minutesBefore).push(i);
    }

    const f = formatEvent(event);
    for (const [minutesBefore, indices] of groups) {
      const hoursText = minutesBefore >= 60
        ? `${minutesBefore / 60}時間前`
        : `${minutesBefore}分前`;

      const mentions = indices.map(i => {
        const s = settings[i];
        if (s.roleId === "@everyone" || s.roleId === "@here") return s.roleId;
        return s.targetType === "user" ? `<@${s.roleId}>` : `<@&${s.roleId}>`;
      }).join(" ");

      // 削除予定時刻の計算とフッター文字列
      const deleteAt    = new Date(now.getTime() + deleteAfterMs);
      const mm          = String(deleteAt.getMonth() + 1).padStart(2, "0");
      const dd          = String(deleteAt.getDate()).padStart(2, "0");
      const hh          = String(deleteAt.getHours()).padStart(2, "0");
      const mi          = String(deleteAt.getMinutes()).padStart(2, "0");
      const footerText  = hasNotifyChannel
        ? `🗑️ あと7日で削除（${mm}/${dd} ${hh}:${mi}）`
        : `🗑️ あと24時間で削除（${mm}/${dd} ${hh}:${mi}）`;

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`⏰ 予定のお知らせ（${hoursText}）`)
        .setDescription(
          `**${f.title}**\n` +
          `📅 ${f.d}日(${f.w})　\`${f.timeStr}\`` +
          (f.desc ? `\n📝 ${f.desc.replace(/^\n　/, "")}` : "")
        )
        .setFooter({ text: footerText })
        .setTimestamp();

      try {
        const msg = await channel.send({ content: mentions, embeds: [embed] });
        setTimeout(() => msg.delete().catch(() => {}), deleteAfterMs);
        for (const i of indices) markNoticeFired(guildId, eventId, i);
        console.log(`[Notify][${guildId}] 送信: ${f.title} → ${mentions} (${hoursText})`);
      } catch (err) {
        console.error(`[Notify][${guildId}] 送信失敗: ${err.message}`);
      }
    }
  }

  // 24時間経過した通知を自動削除
  for (const [eventId] of Object.entries(notices)) {
    const event   = eventMap[eventId];
    const startMs = event ? new Date(event.start.dateTime || event.start.date).getTime() : 0;
    if (!event || now.getTime() > startMs + 24 * 60 * 60 * 1000) {
      deleteNoticesForEvent(guildId, eventId);
      console.log(`[Notify][${guildId}] 期限切れ通知削除: ${eventId}`);
    }
  }
}

module.exports = { checkAndFireNotices };
