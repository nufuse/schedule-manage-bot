/**
 * modals.js v4
 * 通知設定フィールド追加
 * 通知フォーマット例（複数可、カンマ区切り行）:
 *   @ロール名 24時間前
 *   @ロール名 1時間前
 */
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require("discord.js");
const { pick } = require("./i18n");

function buildAddModal(defaultDate = "", lang = "ja") {
  const modal = new ModalBuilder().setCustomId("modal_add").setTitle(pick(lang, "📅 予定を追加", "📅 Add Event"));
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("title").setLabel(pick(lang, "タイトル（必須）", "Title (required)"))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
        .setPlaceholder(pick(lang, "例: 撮影、会議、配信", "e.g. Practice, Match, Meeting"))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("date").setLabel(pick(lang, "日付（必須）YYYY-MM-DD", "Date (required) YYYY-MM-DD"))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10)
        .setPlaceholder(pick(lang, "例: 2026-05-20", "e.g. 2026-05-20")).setValue(defaultDate)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("start_time").setLabel(pick(lang, "開始時刻（任意）HHMM または HH:MM　空欄で終日", "Start time (optional) HHMM or HH:MM, blank for all-day"))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5)
        .setPlaceholder(pick(lang, "例: 2100 / 21:00 / 2500(翌1時)", "e.g. 2100 / 21:00 / 2500(next day 1:00)"))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("end_time").setLabel(pick(lang, "終了時刻（任意）HHMM または HH:MM", "End time (optional) HHMM or HH:MM"))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5)
        .setPlaceholder(pick(lang, "例: 2300 / 23:00 / 2700(翌3時)", "e.g. 2300 / 23:00 / 2700(next day 3:00)"))
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("description").setLabel(pick(lang, "詳細・メモ（任意）", "Description/Notes (optional)"))
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
        .setPlaceholder(pick(lang, "例: 場所、持ち物、備考など", "e.g. Place, items, notes"))
    ),
  );
  return modal;
}

function buildEditModal(event, lang = "ja") {
  const modal = new ModalBuilder().setCustomId(`modal_edit_${event.id}`).setTitle(pick(lang, "✏️ 予定を編集", "✏️ Edit Event"));

  const startRaw  = event.start.dateTime || event.start.date || "";
  const dateStr   = startRaw.substring(0, 10);
  const startTime = event.start.dateTime
    ? new Date(event.start.dateTime).toLocaleTimeString("ja-JP", { hour:"2-digit", minute:"2-digit", hour12:false, timeZone:"Asia/Tokyo" })
    : "";
  const endTime = event.end?.dateTime
    ? new Date(event.end.dateTime).toLocaleTimeString("ja-JP", { hour:"2-digit", minute:"2-digit", hour12:false, timeZone:"Asia/Tokyo" })
    : "";

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("title").setLabel(pick(lang, "タイトル（必須）", "Title (required)"))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)
        .setValue(event.summary || "")
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("date").setLabel(pick(lang, "日付（必須）YYYY-MM-DD", "Date (required) YYYY-MM-DD"))
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10).setValue(dateStr)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("start_time").setLabel(pick(lang, "開始時刻（任意）HHMM または HH:MM　空欄で終日", "Start time (optional) HHMM or HH:MM, blank for all-day"))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5).setValue(startTime)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("end_time").setLabel(pick(lang, "終了時刻（任意）HHMM または HH:MM", "End time (optional) HHMM or HH:MM"))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5).setValue(endTime)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("description").setLabel(pick(lang, "詳細・メモ（任意）", "Description/Notes (optional)"))
        .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
        .setPlaceholder(pick(lang, "例: 場所、持ち物、備考など", "e.g. Place, items, notes"))
        .setValue(event.description || "")
    ),
  );
  return modal;
}

/**
 * 通知テキストをパースして配列に変換
 * 入力例:
 *   "1234567890 24"   → { roleId: "1234567890", minutesBefore: 1440 }
 *   "@everyone 1"     → { roleId: "@everyone",  minutesBefore: 60 }
 */
function parseNotices(text) {
  if (!text?.trim()) return [];
  return text.trim().split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const parts = line.split(/\s+/);
      if (parts.length < 2) return null;
      const roleId  = parts[0];
      const hours   = parseFloat(parts[1]);
      if (isNaN(hours) || hours <= 0) return null;
      return { roleId, minutesBefore: Math.round(hours * 60) };
    })
    .filter(Boolean);
}

module.exports = { buildAddModal, buildEditModal, parseNotices };
