/**
 * notifier.js
 * cronから定期的に呼ばれ、通知タイミングを過ぎたものを送信する
 * 送信先チャンネルは NOTIFY_CHANNEL_ID（未設定なら DISCORD_CHANNEL_ID）
 * 2投稿ルール：通知はDMまたは別チャンネルへ送る（メインチャンネルには投稿しない）
 */
const { EmbedBuilder } = require("discord.js");
const { getMonthEvents, formatEvent } = require("./calendar");
const { loadNotices, markNoticeFired, deleteNoticesForEvent } = require("./storage");

// 通知送信先（.envで別チャンネル指定可能、未設定なら同チャンネル）
const getNotifyChannelId = () =>
  process.env.NOTIFY_CHANNEL_ID || process.env.DISCORD_CHANNEL_ID;

/**
 * @param {Client} client - Discordクライアント
 */
async function checkAndFireNotices(client) {
  const notices = loadNotices(); // { eventId: [{roleId, minutesBefore, firedAt?}] }
  if (Object.keys(notices).length === 0) return;

  const now  = new Date();
  const year = now.getFullYear();

  // 今月・来月のイベントを取得
  const thisMonth = await getMonthEvents(year, now.getMonth() + 1).catch(() => []);
  const nextMonth = await getMonthEvents(year, now.getMonth() + 2).catch(() => []);
  const allEvents = [...thisMonth, ...nextMonth];
  const eventMap  = Object.fromEntries(allEvents.map(e => [e.id, e]));

  const channelId = getNotifyChannelId();
  const channel   = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  for (const [eventId, settings] of Object.entries(notices)) {
    const event = eventMap[eventId];
    if (!event) continue; // 削除済みイベントはスキップ

    const startMs = new Date(event.start.dateTime || event.start.date).getTime();

    // 同じ minutesBefore でまとめて1メッセージに通知
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

      const embed = new EmbedBuilder()
        .setColor(0xfee75c)
        .setTitle(`⏰ 予定のお知らせ（${hoursText}）`)
        .setDescription(
          `**${f.title}**\n` +
          `📅 ${f.d}日(${f.w})　\`${f.timeStr}\`` +
          (f.desc ? `\n📝 ${f.desc.replace(/^\n　/, "")}` : "")
        )
        .setTimestamp();

      try {
        await channel.send({ content: mentions, embeds: [embed] });
        for (const i of indices) markNoticeFired(eventId, i);
        console.log(`[Notify] 送信: ${f.title} → ${mentions} (${hoursText})`);
      } catch (err) {
        console.error(`[Notify] 送信失敗: ${err.message}`);
      }
    }
  }

  // 1日経過した通知を自動削除
  for (const [eventId] of Object.entries(notices)) {
    const event = eventMap[eventId];
    const startMs = event
      ? new Date(event.start.dateTime || event.start.date).getTime()
      : 0;
    if (!event || now.getTime() > startMs + 24 * 60 * 60 * 1000) {
      deleteNoticesForEvent(eventId);
      console.log(`[Notify] 期限切れ通知削除: ${eventId}`);
    }
  }
}

module.exports = { checkAndFireNotices };
