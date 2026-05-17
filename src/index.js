/**
 * index.js v4
 * - ロール制限（OPERATOR_ROLE_NAME のロール or 管理者のみ操作可）
 * - 通知設定（予定ごとに複数設定可）
 * - メインチャンネルへの投稿は固定2件のみ
 * - 通知は NOTIFY_CHANNEL_ID（別途設定推奨）へ送信
 */
require("dotenv").config();
const logger = require("./logger"); // ログファイル記録（dotenvの直後に配置）
const { Client, GatewayIntentBits, REST, Routes, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require("discord.js");
const cron = require("node-cron");

const { getMonthEvents, addEvent, updateEvent, getEvent, deleteEvent, hashEvents } = require("./calendar");
const { buildCalendarEmbed, buildCalendarButtons, buildStatusEmbed, buildActionButtons, buildSelectMenu, buildRoleSelectForNotify, buildNotifyTimeButtons, buildNoticeManageComponents } = require("./embed");
const { buildAddModal, buildEditModal } = require("./modals");
const { loadState, saveState, getNoticesForEvent, setNoticesForEvent, deleteNoticesForEvent, resetFiredForEvent, deleteNoticeEntry } = require("./storage");
const { checkAndFireNotices } = require("./notifier");

const CRON_SCHEDULE       = process.env.CRON_SCHEDULE       || "*/5 * * * *";
const CHANNEL_ID          = process.env.DISCORD_CHANNEL_ID;
const OPERATOR_ROLE_NAME  = process.env.OPERATOR_ROLE_NAME  || "CalendarOperator";
const LOG_CHANNEL_ID      = process.env.LOG_CHANNEL_ID;  // 操作ログ送信先（未設定ならログなし）
const pendingEditInteractions = new Map(); // 編集選択メニュー削除用
let isRunning = false; // cron多重実行防止フラグ

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ─── 権限チェック ─────────────────────────────────────
function hasPermission(member) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some(r => r.name === OPERATOR_ROLE_NAME);
}

function currentYM() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

// 時刻文字列の正規化: "2100" → "21:00"、"900" → "09:00"、"21:00" → そのまま
function normalizeTime(str) {
  if (!str) return "";
  str = str.trim();
  if (/^\d{2}:\d{2}$/.test(str)) return str;
  const digits = str.replace(/\D/g, "");
  if (/^\d{3,4}$/.test(digits)) {
    const padded = digits.padStart(4, "0");
    return `${padded.slice(0, 2)}:${padded.slice(2)}`;
  }
  return str; // 不正形式はそのまま返してバリデーションでエラーになる
}

// 操作ログ Embed 送信
async function sendAuditLog(action, interaction, { title, dateStr, timeStr, desc }) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID);
    const colorMap = { "追加": 0x57f287, "変更": 0xfee75c, "削除": 0xed4245 };
    const iconMap  = { "追加": "📅", "変更": "✏️", "削除": "🗑️" };
    const memberName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    let body = `**${title}**\n\ud83d\udcc5 ${dateStr}\u3000\`${timeStr}\``;
    if (desc) body += `\n\ud83d\udcdd ${desc}`;
    const embed = new EmbedBuilder()
      .setColor(colorMap[action] ?? 0x5865f2)
      .setTitle(`${iconMap[action]} 予定${action}`)
      .setDescription(body)
      .setFooter({ text: `${memberName} (@${interaction.user.username})`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp();
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error("[AuditLog] 送信失敗:", e.message);
  }
}

// カウントダウン付き自動削除ヘルパー
function fmtCd(content, n) { return `${content}\n-# (${n}秒後に消えます)`; }
function startCountdownDelete(interaction, content, seconds = 5) {
  for (let i = seconds - 1; i >= 1; i--) {
    setTimeout(() => interaction.editReply({ content: fmtCd(content, i) }).catch(() => {}), (seconds - i) * 1000);
  }
  setTimeout(() => interaction.deleteReply().catch(() => {}), seconds * 1000);
}

// ─── 投稿1（カレンダー）upsert ────────────────────────
async function upsertCalendarMessage(events, year, month) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  const embed   = buildCalendarEmbed(events, year, month);
  const buttons = buildCalendarButtons(year, month);
  const state   = loadState();

  if (state.calendarMessageId) {
    try {
      const msg = await channel.messages.fetch(state.calendarMessageId);
      await msg.edit({ embeds: [embed], components: [buttons] });
      return;
    } catch { console.warn("[Cal] 再作成"); }
  }
  const msg = await channel.send({ embeds: [embed], components: [buttons] });
  saveState({ calendarMessageId: msg.id });
}

// ─── 投稿2（ステータス）upsert ───────────────────────
async function upsertStatusMessage(events) {
  const channel = await client.channels.fetch(CHANNEL_ID);
  const state   = loadState();
  const embed   = buildStatusEmbed(events, state.updatedAt, OPERATOR_ROLE_NAME);
  const buttons = buildActionButtons();

  if (state.statusMessageId) {
    try {
      const msg = await channel.messages.fetch(state.statusMessageId);
      await msg.edit({ embeds: [embed], components: [buttons] });
      return;
    } catch { console.warn("[Status] 再作成"); }
  }
  const msg = await channel.send({ embeds: [embed], components: [buttons] });
  saveState({ statusMessageId: msg.id });
}

async function updateBoth(events, year, month) {
  await upsertCalendarMessage(events, year, month);
  await upsertStatusMessage(events);
}

// ─── メイン処理 ───────────────────────────────────────
async function run(isFirst = false, force = false) {
  if (isRunning && !isFirst) {
    console.warn("[Cron] 前回の実行がまだ完了していないためスキップ");
    return;
  }
  isRunning = true;
  const ts = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  console.log(`[${ts}] チェック開始`);
  try {
    const { year, month } = currentYM();
    const events  = await getMonthEvents(year, month);
    const newHash = hashEvents(events);
    const state   = loadState();

    if (isFirst || !state.lastHash || force || state.lastHash !== newHash) {
      await updateBoth(events, year, month);
      saveState({ lastHash: newHash, updatedAt: new Date().toISOString() });
    } else {
      await upsertStatusMessage(events);
    }
    // 通知チェック（毎回）
    await checkAndFireNotices(client);
  } catch (err) {
    console.error("エラー:", err);
  } finally {
    isRunning = false;
  }
}

// ─── スラッシュコマンド登録なし ─────────────────────────
async function registerCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: [] }).catch(console.error);
}

// ─── インタラクション ─────────────────────────────────
client.on("interactionCreate", async (interaction) => {

  // ── ボタン ──────────────────────────────────────────
  if (interaction.isButton()) {
    const id = interaction.customId;

    // 🔄 更新（権限不要）
    if (id === "btn_refresh") {
      await interaction.deferReply({ ephemeral: true });
      try {
        const { year, month } = currentYM();
        const events = await getMonthEvents(year, month);
        await updateBoth(events, year, month);
        saveState({ lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
        const msg = "✅ カレンダーとステータスを更新しました！";
        await interaction.editReply({ content: fmtCd(msg, 5) });
        startCountdownDelete(interaction, msg);
        return;
      } catch (err) {
        const msg = `❌ 更新失敗: ${err.message}`;
        await interaction.editReply({ content: fmtCd(msg, 8) });
        startCountdownDelete(interaction, msg, 8);
        return;
      }
    }

    // ◄先月 / 次月►（権限不要）
    if (id.startsWith("btn_prev_") || id.startsWith("btn_next_")) {
      const parts = id.split("_");
      const year  = parseInt(parts[2]);
      const month = parseInt(parts[3]);
      try {
        const events  = await getMonthEvents(year, month);
        const embed   = buildCalendarEmbed(events, year, month);
        const buttons = buildCalendarButtons(year, month);
        // ephemeralメッセージからのクリックは上書き（置き換え）、それ以外は新規返信
        if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
          return interaction.update({ embeds: [embed], components: [buttons] });
        } else {
          await interaction.deferReply({ ephemeral: true });
          return interaction.editReply({ embeds: [embed], components: [buttons] });
        }
      } catch (err) {
        if (interaction.deferred || interaction.replied) {
          return interaction.editReply({ content: `❌ 取得失敗: ${err.message}` });
        }
        return interaction.reply({ content: `❌ 取得失敗: ${err.message}`, ephemeral: true });
      }
    }

    // ── 以下は権限チェック必須 ────────────────
    // ─── 通知設定ボタン（ephemeral後続・権限チェック不要）──────────

    // @everyone / @here ボタン
    if (id.startsWith("btn_notify_everyone_") || id.startsWith("btn_notify_here_")) {
      const isEveryone = id.startsWith("btn_notify_everyone_");
      const roleId     = isEveryone ? "@everyone" : "@here";
      const eventId    = id.slice(isEveryone ? "btn_notify_everyone_".length : "btn_notify_here_".length);
      const timeRows   = buildNotifyTimeButtons(eventId, roleId);
      return interaction.update({
        content: `⏰ ${roleId} への通知タイミングを選択してください：`,
        components: timeRows,
      });
    }

    // ユーザー時間選択ボタン (btn_notify_u_)
    if (id.startsWith("btn_notify_u_")) {
      const withoutPrefix = id.slice("btn_notify_u_".length);
      const lastUnd       = withoutPrefix.lastIndexOf("_");
      const minutes       = parseInt(withoutPrefix.slice(lastUnd + 1));
      const rest          = withoutPrefix.slice(0, lastUnd);
      const secondLastUnd = rest.lastIndexOf("_");
      const userId        = rest.slice(secondLastUnd + 1);
      const eventId       = rest.slice(0, secondLastUnd);

      const existing = getNoticesForEvent(eventId);
      existing.push({ roleId: userId, minutesBefore: minutes, targetType: "user" });
      setNoticesForEvent(eventId, existing);

      const hoursText = minutes >= 60 ? `${minutes / 60}時間前` : `${minutes}分前`;
      const { content: nmgrContent, components: nmgrComponents } = buildNoticeManageComponents(eventId);
      return interaction.update({ content: nmgrContent, components: nmgrComponents });
    }

    // 時間選択ボタン
    if (id.startsWith("btn_notify_t_")) {
      // customId: btn_notify_t_{eventId}_{roleId}_{minutes} → 右からパース
      const withoutPrefix = id.slice("btn_notify_t_".length);
      const lastUnd       = withoutPrefix.lastIndexOf("_");
      const minutes       = parseInt(withoutPrefix.slice(lastUnd + 1));
      const rest          = withoutPrefix.slice(0, lastUnd);
      const secondLastUnd = rest.lastIndexOf("_");
      const roleId        = rest.slice(secondLastUnd + 1);
      const eventId       = rest.slice(0, secondLastUnd);

      const existing = getNoticesForEvent(eventId);
      existing.push({ roleId, minutesBefore: minutes });
      setNoticesForEvent(eventId, existing);

      const hoursText   = minutes >= 60 ? `${minutes / 60}時間前` : `${minutes}分前`;
      const { content: nmgrContent, components: nmgrComponents } = buildNoticeManageComponents(eventId);
      return interaction.update({ content: nmgrContent, components: nmgrComponents });
    }

    // 通知スキップ → 通知管理ビューへ
    if (id.startsWith("btn_notify_skip_")) {
      const eventId = id.slice("btn_notify_skip_".length);
      const { content: nmgrContent, components: nmgrComponents } = buildNoticeManageComponents(eventId);
      return interaction.update({ content: nmgrContent, components: nmgrComponents });
    }

    // 通知設定完了
    if (id.startsWith("btn_notify_done_")) {
      const msg = "✅ 通知設定を完了しました！";
      await interaction.update({ content: fmtCd(msg, 5), components: [] });
      startCountdownDelete(interaction, msg);
      return;
    }

    // もと1つ追加 → 通知管理ビューへリダイレクト
    if (id.startsWith("btn_notify_more_")) {
      const eventId = id.slice("btn_notify_more_".length);
      const { content: nmgrContent, components: nmgrComponents } = buildNoticeManageComponents(eventId);
      return interaction.update({ content: nmgrContent, components: nmgrComponents });
    }

    // 通知管理ボタン群（権限チェック不要）
    if (id.startsWith("btn_nmgr_add_")) {
      const eventId = id.slice("btn_nmgr_add_".length);
      const [roleRow, userRow, skipRow] = buildRoleSelectForNotify(eventId);
      return interaction.update({
        content: "📣 通知するロールまたはユーザーを選択してください：",
        components: [roleRow, userRow, skipRow],
      });
    }

    if (id.startsWith("btn_nmgr_del_")) {
      await interaction.deferUpdate();
      const eventId = id.slice("btn_nmgr_del_".length);
      const notices = getNoticesForEvent(eventId);
      const options = [];
      for (let i = 0; i < notices.length; i++) {
        const n = notices[i];
        let targetName;
        if (n.roleId === "@everyone" || n.roleId === "@here") {
          targetName = n.roleId;
        } else if (n.targetType === "user") {
          try {
            const member = await interaction.guild?.members.fetch(n.roleId);
            targetName = "@" + (member?.displayName || member?.user.username || n.roleId);
          } catch {
            targetName = "@" + n.roleId;
          }
        } else {
          const role = interaction.guild?.roles.cache.get(n.roleId);
          targetName = "@" + (role?.name || n.roleId);
        }
        const timeLabel = n.minutesBefore >= 60 ? `${n.minutesBefore / 60}時間前` : `${n.minutesBefore}分前`;
        options.push({ label: `${i + 1}. ${targetName} / ${timeLabel}`.substring(0, 100), value: String(i) });
      }
      const { ActionRowBuilder: ARBD, StringSelectMenuBuilder: SSBD } = require("discord.js");
      const delRow = new ARBD().addComponents(
        new SSBD().setCustomId(`select_nmgr_del_${eventId}`).setPlaceholder("削除する通知を選択").addOptions(options)
      );
      return interaction.editReply({ content: "🗑️ 削除する通知を選択してください：", components: [delRow] });
    }

    if (id.startsWith("btn_nmgr_done_")) {
      const msg = "✅ 通知設定を完了しました！";
      await interaction.update({ content: fmtCd(msg, 5), components: [] });
      startCountdownDelete(interaction, msg);
      return;
    }

    // ── 以下は権限チェック必須 ────────────────────────
    if (!hasPermission(interaction.member)) {
      return interaction.reply({
        content: `🔐 この操作には \`${OPERATOR_ROLE_NAME}\` ロールまたは管理者権限が必要です。`,
        ephemeral: true,
      });
    }

    // ➕ 追加
    if (id === "btn_add") {
      const today = new Date().toISOString().substring(0, 10);
      return interaction.showModal(buildAddModal(today));
    }

    // ✏️ 編集
    if (id === "btn_edit_select") {
      const { year, month } = currentYM();
      const events = await getMonthEvents(year, month);
      const menu   = buildSelectMenu(events, "select_edit_event", "編集する予定を選択");
      if (!menu) return interaction.reply({ content: "編集できる予定がありません。", ephemeral: true });
      await interaction.reply({ content: "✏️ 編集する予定を選んでください：", components: [menu], ephemeral: true });
      pendingEditInteractions.set(interaction.user.id, interaction);
      return;
    }

    // 🗑️ 削除
    if (id === "btn_delete_select") {
      const { year, month } = currentYM();
      const events = await getMonthEvents(year, month);
      const menu   = buildSelectMenu(events, "select_delete_event", "削除する予定を選択");
      if (!menu) return interaction.reply({ content: "削除できる予定がありません。", ephemeral: true });
      return interaction.reply({ content: "🗑️ 削除する予定を選んでください：", components: [menu], ephemeral: true });
    }

    // 削除確認
    if (id.startsWith("btn_confirm_delete_")) {
      await interaction.deferUpdate();
      const eventId = id.replace("btn_confirm_delete_", "");
      try {
        let _auditInfo = null;
        try {
          const _ev = await getEvent(eventId);
          const _f  = formatEventLocal(_ev);
          _auditInfo = {
            title:   _f.title,
            dateStr: (_ev.start.dateTime || _ev.start.date).substring(0, 10),
            timeStr: _f.timeStr,
            desc:    _ev.description || "",
          };
        } catch {}
        await deleteEvent(eventId);
        deleteNoticesForEvent(eventId);
        if (_auditInfo) sendAuditLog("削除", interaction, _auditInfo);
        const msg = "✅ 削除しました。";
        await interaction.editReply({ content: fmtCd(msg, 5), components: [] });
        startCountdownDelete(interaction, msg);
        const { year, month } = currentYM();
        const events = await getMonthEvents(year, month);
        await updateBoth(events, year, month);
        saveState({ lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
      } catch (err) {
        const emsg = `❌ 削除失敗: ${err.message}`;
        await interaction.editReply({ content: fmtCd(emsg, 8), components: [] });
        startCountdownDelete(interaction, emsg, 8);
      }
    }

    if (id === "btn_cancel_delete") {
      const msg = "キャンセルしました。";
      await interaction.update({ content: fmtCd(msg, 5), components: [] });
      startCountdownDelete(interaction, msg);
      return;
    }
  }

  // ── セレクトメニュー ────────────────────────────────
  if (interaction.isStringSelectMenu()) {

    // 通知削除対象選択（権限チェック不要）
    if (interaction.customId.startsWith("select_nmgr_del_")) {
      const eventId = interaction.customId.slice("select_nmgr_del_".length);
      const index   = parseInt(interaction.values[0]);
      deleteNoticeEntry(eventId, index);
      const { content: nmgrContent, components: nmgrComponents } = buildNoticeManageComponents(eventId);
      return interaction.update({ content: nmgrContent, components: nmgrComponents });
    }

    if (!hasPermission(interaction.member)) {
      return interaction.reply({
        content: `🔐 この操作には \`${OPERATOR_ROLE_NAME}\` ロールまたは管理者権限が必要です。`,
        ephemeral: true,
      });
    }

    // 編集対象選択
    if (interaction.customId === "select_edit_event") {
      const eventId = interaction.values[0];
      try {
        const event = await getEvent(eventId);
        return interaction.showModal(buildEditModal(event));
      } catch (err) {
        return interaction.reply({ content: `❌ 取得失敗: ${err.message}`, ephemeral: true });
      }
    }

    // 削除対象選択 → 確認
    if (interaction.customId === "select_delete_event") {
      await interaction.deferUpdate();
      const eventId = interaction.values[0];
      try {
        const event = await getEvent(eventId);
        const f     = formatEventLocal(event);
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`btn_confirm_delete_${eventId}`).setLabel("🗑️ 削除する").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("btn_cancel_delete").setLabel("キャンセル").setStyle(ButtonStyle.Secondary),
        );
        return interaction.editReply({
          content: `⚠️ 本当に削除しますか？\n\n**${f.title}**　${f.d}日(${f.w})　\`${f.timeStr}\``,
          components: [row],
        });
      } catch (err) {
        return interaction.editReply({ content: `❌ 取得失敗: ${err.message}`, components: [] });
      }
    }
  }

  // ── ロールセレクトメニュー（通知ロール選択）───────────────────
  if (interaction.isRoleSelectMenu()) {
    if (interaction.customId.startsWith("select_notify_role_")) {
      const eventId  = interaction.customId.slice("select_notify_role_".length);
      const roleId   = interaction.values[0];
      const timeRows = buildNotifyTimeButtons(eventId, roleId, "role");
      return interaction.update({
        content: `⏰ <@&${roleId}> への通知タイミングを選択してください：`,
        components: timeRows,
      });
    }
  }

  // ── ユーザーセレクトメニュー（通知ユーザー選択）───────────────
  if (interaction.isUserSelectMenu()) {
    if (interaction.customId.startsWith("select_notify_user_")) {
      const eventId  = interaction.customId.slice("select_notify_user_".length);
      const userId   = interaction.values[0];
      const timeRows = buildNotifyTimeButtons(eventId, userId, "user");
      return interaction.update({
        content: `⏰ <@${userId}> への通知タイミングを選択してください：`,
        components: timeRows,
      });
    }
  }

  // ── モーダル送信 ──────────────────────────────────────
  if (interaction.isModalSubmit()) {
    await interaction.deferReply({ ephemeral: true });

    const title       = interaction.fields.getTextInputValue("title");
    const dateStr     = interaction.fields.getTextInputValue("date");
    const startTime   = normalizeTime(interaction.fields.getTextInputValue("start_time"));
    const endTime     = normalizeTime(interaction.fields.getTextInputValue("end_time"));
    const description = interaction.fields.getTextInputValue("description").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const emsg = "❌ 日付は `YYYY-MM-DD` 形式で。例: `2026-05-20`";
      await interaction.editReply({ content: fmtCd(emsg, 8) });
      startCountdownDelete(interaction, emsg, 8);
      return;
    }
    if (startTime && !/^\d{2}:\d{2}$/.test(startTime)) {
      const emsg = "❌ 時刻は `HH:MM` または `HHMM` 形式で入力してください。例: `18:00` / `2700`";
      await interaction.editReply({ content: fmtCd(emsg, 8) });
      startCountdownDelete(interaction, emsg, 8);
      return;
    }

    const timeInfo    = startTime ? ` ${startTime}～${endTime || ""}` : " 終日";

    // 追加
    if (interaction.customId === "modal_add") {
      try {
        const event = await addEvent({ title, dateStr, startTime, endTime, description });
        const { content: nmgrContent, components: nmgrComponents } = buildNoticeManageComponents(event.id);
        await interaction.editReply({
          content: `✅ 追加しました！\n**${title}**　${dateStr}${timeInfo}${description ? `\n📝 ${description}` : ""}\n\n` + nmgrContent,
          components: nmgrComponents,
        });
        const { year, month } = currentYM();
        const events = await getMonthEvents(year, month);
        await updateBoth(events, year, month);
        saveState({ lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
        sendAuditLog("追加", interaction, { title, dateStr, timeStr: startTime ? `${startTime}\uff5e${endTime || ""}` : "終日", desc: description });
      } catch (err) {
        const emsg = `❌ 追加失敗: ${err.message}`;
        await interaction.editReply({ content: fmtCd(emsg, 8) });
        startCountdownDelete(interaction, emsg, 8);
      }
    }

    // 編集
    if (interaction.customId.startsWith("modal_edit_")) {
      const _prevEdit = pendingEditInteractions.get(interaction.user.id);
      if (_prevEdit) {
        _prevEdit.deleteReply().catch(() => {});
        pendingEditInteractions.delete(interaction.user.id);
      }
      const eventId = interaction.customId.replace("modal_edit_", "");
      try {
        await updateEvent(eventId, { title, dateStr, startTime, endTime, description });
        resetFiredForEvent(eventId); // 日時変更のためfiredAtをリセット
        const { content: nmgrContent, components: nmgrComponents } = buildNoticeManageComponents(eventId);
        await interaction.editReply({
          content: `✅ 更新しました！\n**${title}**　${dateStr}${timeInfo}${description ? `\n📝 ${description}` : ""}\n\n` + nmgrContent,
          components: nmgrComponents,
        });
        const { year, month } = currentYM();
        const events = await getMonthEvents(year, month);
        await updateBoth(events, year, month);
        saveState({ lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
        sendAuditLog("変更", interaction, { title, dateStr, timeStr: startTime ? `${startTime}\uff5e${endTime || ""}` : "終日", desc: description });
      } catch (err) {
        const emsg = `❌ 更新失敗: ${err.message}`;
        await interaction.editReply({ content: fmtCd(emsg, 8) });
        startCountdownDelete(interaction, emsg, 8);
      }
    }
  }
});

// ローカル用formatEvent（calendar.jsをrequireせずに使えるよう）
function formatEventLocal(event) {
  const { formatEvent } = require("./calendar");
  return formatEvent(event);
}

// ─── Bot起動 ─────────────────────────────────────────
client.once("clientReady", async () => {
  console.log("========================================");
  console.log(`  gcal-discord-bot v4 起動完了`);
  console.log(`  ログイン: ${client.user.tag}`);
  console.log(`  チャンネル: ${CHANNEL_ID}`);
  console.log(`  操作ロール: ${OPERATOR_ROLE_NAME}`);
  console.log(`  スケジュール: ${CRON_SCHEDULE}`);
  console.log("========================================");

  const channel = await client.channels.fetch(CHANNEL_ID);
  await registerCommands(channel.guild.id);
  await run(true);

  cron.schedule(CRON_SCHEDULE, () => run(false), { timezone: "Asia/Tokyo" });
  console.log(`[Cron] 登録完了: "${CRON_SCHEDULE}"`);
});

client.login(process.env.DISCORD_TOKEN);

// ─── グレースフルシャットダウン ─────────────────────
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[${signal}] シャットダウン開始...`);

  // 10秒以内に完了しない場合は強制終了（Discord APIが詰まった場合の保険）
  const timer = setTimeout(() => {
    console.error("[Shutdown] タイムアウト - 強制終了します");
    process.exit(1);
  }, 10000);

  try {
    const state = loadState();
    console.log("[Shutdown] state:", JSON.stringify({ statusMessageId: state.statusMessageId, calendarMessageId: state.calendarMessageId }));

    const channel = CHANNEL_ID ? await client.channels.fetch(CHANNEL_ID) : null;
    if (!channel) {
      console.error("[Shutdown] チャンネルが取得できませんでした (CHANNEL_ID:", CHANNEL_ID, ")");
    } else {
      // ステータスメッセージを停止中に更新（ボタン削除）
      if (state.statusMessageId) {
        try {
          const msg   = await channel.messages.fetch(state.statusMessageId);
          const embed = buildStatusEmbed([], state.updatedAt, OPERATOR_ROLE_NAME, false);
          await msg.edit({ embeds: [embed], components: [] });
          console.log("[Shutdown] ステータスを停止中に更新しました");
        } catch (e) { console.error("[Shutdown] ステータス更新エラー:", e.message); }
      }
      // カレンダーメッセージの先月・翌月・更新ボタンを非表示
      if (state.calendarMessageId) {
        try {
          const msg = await channel.messages.fetch(state.calendarMessageId);
          await msg.edit({ components: [] });
          console.log("[Shutdown] カレンダーボタンを非表示にしました");
        } catch (e) { console.error("[Shutdown] カレンダー更新エラー:", e.message); }
      }
    }
  } catch (err) {
    console.error("[Shutdown] シャットダウン処理エラー:", err.message);
  }

  clearTimeout(timer);
  client.destroy();
  await logger.close();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM").catch(err => { console.error("[SIGTERM]", err); process.exit(1); }));
process.on("SIGINT",  () => gracefulShutdown("SIGINT").catch(err =>  { console.error("[SIGINT]",  err); process.exit(1); }));
process.on("SIGHUP",  () => gracefulShutdown("SIGHUP").catch(err =>  { console.error("[SIGHUP]",  err); process.exit(1); }));

// ─── 予期しないエラーで落ちない保護 ─────────────────
process.on("unhandledRejection", (reason) => {
  console.error("[UnhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err);
});
