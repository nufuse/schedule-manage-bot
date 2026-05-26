/**
 * index.js v5
 * マルチギルド対応
 * - /setup コマンドでギルドごとに設定
 * - per-guild data: data/{guildId}/
 */
require("dotenv").config();
const fs     = require("fs");
const path   = require("path");
const logger = require("./logger");
const {
  Client, GatewayIntentBits, REST, Routes, PermissionFlagsBits, MessageFlags,
  EmbedBuilder, SlashCommandBuilder,
} = require("discord.js");
const cron = require("node-cron");

const { getMonthEvents, addEvent, updateEvent, getEvent, deleteEvent, hashEvents } = require("./calendar");
const { buildCalendarEmbed, buildCalendarButtons, buildStatusEmbed, buildActionButtons, buildSelectMenu, buildRoleSelectForNotify, buildNotifyTimeButtons, buildNoticeManageComponents } = require("./embed");
const { buildAddModal, buildEditModal } = require("./modals");
const { loadState, saveState, getNoticesForEvent, setNoticesForEvent, deleteNoticesForEvent, resetFiredForEvent, deleteNoticeEntry } = require("./storage");
const { checkAndFireNotices } = require("./notifier");
const { loadConfig, saveConfig, deleteConfig, getAllGuildIds } = require("./guildConfig");

const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/5 * * * *";

// 起動カウンターを data/.startup_count に保存
function getAndIncrementStartupCount() {
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

const pendingEditInteractions = new Map();
const guildRunning = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("このサーバーでスケジュール管理Botを設定します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption(opt =>
    opt.setName("channel").setDescription("カレンダーを投稿するチャンネル").setRequired(true))
  .addStringOption(opt =>
    opt.setName("calendar_id").setDescription("Google Calendar ID").setRequired(true))
  .addChannelOption(opt =>
    opt.setName("notify_channel").setDescription("通知送信先チャンネル（省略: カレンダーチャンネルと同じ）"))
  .addChannelOption(opt =>
    opt.setName("log_channel").setDescription("操作ログ送信先チャンネル（省略: ログなし）"))
  .addStringOption(opt =>
    opt.setName("operator_role").setDescription("操作を許可するロール名（デフォルト: CalendarOperator）"));

const removeSetupCommand = new SlashCommandBuilder()
  .setName("setup-remove")
  .setDescription("このサーバーのBot設定をすべて削除します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

function hasPermission(member, operatorRoleName) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some(r => r.name === operatorRoleName);
}

function currentYM() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
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

async function sendAuditLog(action, interaction, { title, dateStr, timeStr, desc }, logChannelId) {
  if (!logChannelId) return;
  try {
    const ch = await client.channels.fetch(logChannelId);
    const colorMap = { "追加": 0x57f287, "変更": 0xfee75c, "削除": 0xed4245 };
    const iconMap  = { "追加": "📅", "変更": "✏️", "削除": "🗑️" };
    const memberName = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    let body = `**${title}**\n📅 ${dateStr}\u3000\`${timeStr}\``;
    if (desc) body += `\n📝 ${desc}`;
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

// 全ギルドのログチャンネルにシステム通知を送信
async function sendSystemLog(color, title, description) {
  for (const gid of getAllGuildIds()) {
    const cfg = loadConfig(gid);
    if (!cfg?.logChannelId) continue;
    try {
      const ch = await client.channels.fetch(cfg.logChannelId);
      await ch.send({
        embeds: [new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp()]
      });
    } catch (e) {
      console.error(`[SystemLog][${gid}] 送信失敗: ${e.message}`);
    }
  }
}

function fmtCd(content, n) { return `${content}\n-# (${n}秒後に消えます)`; }
function startCountdownDelete(interaction, content, seconds = 5) {
  for (let i = seconds - 1; i >= 1; i--) {
    setTimeout(() => interaction.editReply({ content: fmtCd(content, i) }).catch(() => {}), (seconds - i) * 1000);
  }
  setTimeout(() => interaction.deleteReply().catch(() => {}), seconds * 1000);
}

async function upsertCalendarMessage(guildId, config, events, year, month) {
  const channel = await client.channels.fetch(config.channelId);
  const embed   = buildCalendarEmbed(guildId, events, year, month);
  const buttons = buildCalendarButtons(year, month);
  const state   = loadState(guildId);
  if (state.calendarMessageId) {
    try {
      const msg = await channel.messages.fetch(state.calendarMessageId);
      await msg.edit({ embeds: [embed], components: [buttons] });
      return;
    } catch { console.warn(`[Cal][${guildId}] 再作成`); }
  }
  const msg = await channel.send({ embeds: [embed], components: [buttons] });
  saveState(guildId, { calendarMessageId: msg.id });
}

async function upsertStatusMessage(guildId, config, events) {
  const channel = await client.channels.fetch(config.channelId);
  const state   = loadState(guildId);
  const embed   = buildStatusEmbed(guildId, events, state.updatedAt, config.operatorRoleName);
  const buttons = buildActionButtons();
  if (state.statusMessageId) {
    try {
      const msg = await channel.messages.fetch(state.statusMessageId);
      await msg.edit({ embeds: [embed], components: [buttons] });
      return;
    } catch { console.warn(`[Status][${guildId}] 再作成`); }
  }
  const msg = await channel.send({ embeds: [embed], components: [buttons] });
  saveState(guildId, { statusMessageId: msg.id });
}

async function updateBoth(guildId, config, events, year, month) {
  await upsertCalendarMessage(guildId, config, events, year, month);
  await upsertStatusMessage(guildId, config, events);
}

async function run(guildId, config, isFirst = false, force = false) {
  if (guildRunning.get(guildId) && !isFirst) {
    console.warn(`[Cron][${guildId}] スキップ`);
    return;
  }
  guildRunning.set(guildId, true);
  const ts = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  console.log(`[${ts}][${guildId}] チェック開始`);
  try {
    const { year, month } = currentYM();
    const events  = await getMonthEvents(config.calendarId, year, month);
    const newHash = hashEvents(events);
    const state   = loadState(guildId);
    if (isFirst || !state.lastHash || force || state.lastHash !== newHash) {
      await updateBoth(guildId, config, events, year, month);
      saveState(guildId, { lastHash: newHash, updatedAt: new Date().toISOString() });
    } else {
      await upsertStatusMessage(guildId, config, events);
    }
    await checkAndFireNotices(client, guildId, config);
  } catch (err) {
    console.error(`[Run][${guildId}] エラー:`, err);
  } finally {
    guildRunning.set(guildId, false);
  }
}

async function registerGlobalCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationCommands(client.user.id),
    { body: [setupCommand.toJSON(), removeSetupCommand.toJSON()] }
  ).catch(console.error);
}

client.on("interactionCreate", async (interaction) => {
  const guildId = interaction.guildId;

  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "setup") {
      await interaction.deferReply({ ephemeral: true });
      const channel       = interaction.options.getChannel("channel");
      const calendarId    = interaction.options.getString("calendar_id");
      const notifyChannel = interaction.options.getChannel("notify_channel");
      const logChannel    = interaction.options.getChannel("log_channel");
      const operatorRole  = interaction.options.getString("operator_role") || "CalendarOperator";
      const config = {
        channelId:        channel.id,
        calendarId,
        notifyChannelId:  notifyChannel?.id || null,
        logChannelId:     logChannel?.id || null,
        operatorRoleName: operatorRole,
      };
      saveConfig(guildId, config);
      try {
        const { year, month } = currentYM();
        const events = await getMonthEvents(calendarId, year, month);
        await updateBoth(guildId, config, events, year, month);
        saveState(guildId, { lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
        const serviceEmail = process.env.GOOGLE_CLIENT_EMAIL || "（未設定）";
        await interaction.editReply({
          content:
            "✅ **セットアップ完了！**\n\n" +
            `📅 カレンダーチャンネル: <#${channel.id}>\n` +
            `📆 Google Calendar ID: \`${calendarId}\`\n` +
            `🔔 通知チャンネル: ${notifyChannel ? `<#${notifyChannel.id}>` : "カレンダーチャンネルと同じ"}\n` +
            `📝 ログチャンネル: ${logChannel ? `<#${logChannel.id}>` : "なし"}\n` +
            `🔐 操作ロール: \`${operatorRole}\`\n\n` +
            "> ⚠️ **Googleカレンダーの共有設定を確認してください**\n" +
            `> \`${serviceEmail}\` を「**編集者**」として共有してください。`,
        });
      } catch (err) {
        await interaction.editReply({
          content: `⚠️ 設定は保存されましたが、カレンダー投稿に失敗しました: \`${err.message}\``,
        });
      }
      return;
    }

    if (interaction.commandName === "setup-remove") {
      const config = loadConfig(guildId);
      if (!config) {
        return interaction.reply({ content: "ℹ️ このサーバーはまだセットアップされていません。", ephemeral: true });
      }
      deleteConfig(guildId);
      return interaction.reply({ content: "✅ このサーバーの設定を削除しました。", ephemeral: true });
    }
    return;
  }

  const config = loadConfig(guildId);
  if (!config) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: "❌ このサーバーはセットアップされていません。管理者に `/setup` の実行を依頼してください。", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === "btn_refresh") {
      await interaction.deferReply({ ephemeral: true });
      try {
        const { year, month } = currentYM();
        const events = await getMonthEvents(config.calendarId, year, month);
        await updateBoth(guildId, config, events, year, month);
        saveState(guildId, { lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
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

    if (id.startsWith("btn_prev_") || id.startsWith("btn_next_")) {
      const parts = id.split("_");
      const year  = parseInt(parts[2]);
      const month = parseInt(parts[3]);
      try {
        const events  = await getMonthEvents(config.calendarId, year, month);
        const embed   = buildCalendarEmbed(guildId, events, year, month);
        const buttons = buildCalendarButtons(year, month);
        if (interaction.message.flags.has(MessageFlags.Ephemeral)) {
          return interaction.update({ embeds: [embed], components: [buttons] });
        } else {
          await interaction.deferReply({ ephemeral: true });
          return interaction.editReply({ embeds: [embed], components: [buttons] });
        }
      } catch (err) {
        if (interaction.deferred || interaction.replied) return interaction.editReply({ content: `❌ 取得失敗: ${err.message}` });
        return interaction.reply({ content: `❌ 取得失敗: ${err.message}`, ephemeral: true });
      }
    }

    if (id.startsWith("btn_notify_everyone_") || id.startsWith("btn_notify_here_")) {
      const isEveryone = id.startsWith("btn_notify_everyone_");
      const roleId     = isEveryone ? "@everyone" : "@here";
      const eventId    = id.slice(isEveryone ? "btn_notify_everyone_".length : "btn_notify_here_".length);
      return interaction.update({ content: `⏰ ${roleId} への通知タイミングを選択してください：`, components: buildNotifyTimeButtons(eventId, roleId) });
    }

    if (id.startsWith("btn_notify_u_")) {
      const wp  = id.slice("btn_notify_u_".length);
      const li  = wp.lastIndexOf("_");
      const min = parseInt(wp.slice(li + 1));
      const r   = wp.slice(0, li);
      const si  = r.lastIndexOf("_");
      const uid = r.slice(si + 1);
      const eid = r.slice(0, si);
      const ex  = getNoticesForEvent(guildId, eid);
      ex.push({ roleId: uid, minutesBefore: min, targetType: "user" });
      setNoticesForEvent(guildId, eid, ex);
      const { content: nc, components: nco } = buildNoticeManageComponents(guildId, eid);
      return interaction.update({ content: nc, components: nco });
    }

    if (id.startsWith("btn_notify_t_")) {
      const wp  = id.slice("btn_notify_t_".length);
      const li  = wp.lastIndexOf("_");
      const min = parseInt(wp.slice(li + 1));
      const r   = wp.slice(0, li);
      const si  = r.lastIndexOf("_");
      const rid = r.slice(si + 1);
      const eid = r.slice(0, si);
      const ex  = getNoticesForEvent(guildId, eid);
      ex.push({ roleId: rid, minutesBefore: min });
      setNoticesForEvent(guildId, eid, ex);
      const { content: nc, components: nco } = buildNoticeManageComponents(guildId, eid);
      return interaction.update({ content: nc, components: nco });
    }

    if (id.startsWith("btn_notify_skip_")) {
      const eid = id.slice("btn_notify_skip_".length);
      const { content: nc, components: nco } = buildNoticeManageComponents(guildId, eid);
      return interaction.update({ content: nc, components: nco });
    }

    if (id.startsWith("btn_notify_done_")) {
      const msg = "✅ 通知設定を完了しました！";
      await interaction.update({ content: fmtCd(msg, 5), components: [] });
      startCountdownDelete(interaction, msg);
      return;
    }

    if (id.startsWith("btn_notify_more_")) {
      const eid = id.slice("btn_notify_more_".length);
      const { content: nc, components: nco } = buildNoticeManageComponents(guildId, eid);
      return interaction.update({ content: nc, components: nco });
    }

    if (id.startsWith("btn_nmgr_add_")) {
      const eid = id.slice("btn_nmgr_add_".length);
      const [roleRow, userRow, skipRow] = buildRoleSelectForNotify(eid);
      return interaction.update({ content: "📣 通知するロールまたはユーザーを選択してください：", components: [roleRow, userRow, skipRow] });
    }

    if (id.startsWith("btn_nmgr_del_")) {
      await interaction.deferUpdate();
      const eid = id.slice("btn_nmgr_del_".length);
      const notices = getNoticesForEvent(guildId, eid);
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
          } catch { targetName = "@" + n.roleId; }
        } else {
          const role = interaction.guild?.roles.cache.get(n.roleId);
          targetName = "@" + (role?.name || n.roleId);
        }
        const tl = n.minutesBefore >= 60 ? `${n.minutesBefore / 60}時間前` : `${n.minutesBefore}分前`;
        options.push({ label: `${i + 1}. ${targetName} / ${tl}`.substring(0, 100), value: String(i) });
      }
      const { ActionRowBuilder: ARB, StringSelectMenuBuilder: SSB } = require("discord.js");
      return interaction.editReply({
        content: "🗑️ 削除する通知を選択してください：",
        components: [new ARB().addComponents(new SSB().setCustomId(`select_nmgr_del_${eid}`).setPlaceholder("削除する通知を選択").addOptions(options))],
      });
    }

    if (id.startsWith("btn_nmgr_done_")) {
      const msg = "✅ 通知設定を完了しました！";
      await interaction.update({ content: fmtCd(msg, 5), components: [] });
      startCountdownDelete(interaction, msg);
      return;
    }

    if (!hasPermission(interaction.member, config.operatorRoleName)) {
      return interaction.reply({ content: `🔐 この操作には \`${config.operatorRoleName}\` ロールまたは管理者権限が必要です。`, ephemeral: true });
    }

    if (id === "btn_add") {
      return interaction.showModal(buildAddModal(new Date().toISOString().substring(0, 10)));
    }

    if (id === "btn_edit_select") {
      const { year, month } = currentYM();
      const events = await getMonthEvents(config.calendarId, year, month);
      const menu   = buildSelectMenu(events, "select_edit_event", "編集する予定を選択");
      if (!menu) return interaction.reply({ content: "編集できる予定がありません。", ephemeral: true });
      await interaction.reply({ content: "✏️ 編集する予定を選んでください：", components: [menu], ephemeral: true });
      pendingEditInteractions.set(interaction.user.id, interaction);
      return;
    }

    if (id === "btn_delete_select") {
      const { year, month } = currentYM();
      const events = await getMonthEvents(config.calendarId, year, month);
      const menu   = buildSelectMenu(events, "select_delete_event", "削除する予定を選択");
      if (!menu) return interaction.reply({ content: "削除できる予定がありません。", ephemeral: true });
      return interaction.reply({ content: "🗑️ 削除する予定を選んでください：", components: [menu], ephemeral: true });
    }

    if (id.startsWith("btn_confirm_delete_")) {
      await interaction.deferUpdate();
      const eventId = id.replace("btn_confirm_delete_", "");
      try {
        let _ai = null;
        try {
          const _ev = await getEvent(config.calendarId, eventId);
          const _f  = formatEventLocal(_ev);
          _ai = { title: _f.title, dateStr: (_ev.start.dateTime || _ev.start.date).substring(0, 10), timeStr: _f.timeStr, desc: _ev.description || "" };
        } catch {}
        await deleteEvent(config.calendarId, eventId);
        deleteNoticesForEvent(guildId, eventId);
        if (_ai) sendAuditLog("削除", interaction, _ai, config.logChannelId);
        const msg = "✅ 削除しました。";
        await interaction.editReply({ content: fmtCd(msg, 5), components: [] });
        startCountdownDelete(interaction, msg);
        const { year, month } = currentYM();
        const events = await getMonthEvents(config.calendarId, year, month);
        await updateBoth(guildId, config, events, year, month);
        saveState(guildId, { lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
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

  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith("select_nmgr_del_")) {
      const eid = interaction.customId.slice("select_nmgr_del_".length);
      deleteNoticeEntry(guildId, eid, parseInt(interaction.values[0]));
      const { content: nc, components: nco } = buildNoticeManageComponents(guildId, eid);
      return interaction.update({ content: nc, components: nco });
    }
    if (!hasPermission(interaction.member, config.operatorRoleName)) {
      return interaction.reply({ content: `🔐 この操作には \`${config.operatorRoleName}\` ロールまたは管理者権限が必要です。`, ephemeral: true });
    }
    if (interaction.customId === "select_edit_event") {
      const eventId = interaction.values[0];
      try {
        const event = await getEvent(config.calendarId, eventId);
        return interaction.showModal(buildEditModal(event));
      } catch (err) {
        return interaction.reply({ content: `❌ 取得失敗: ${err.message}`, ephemeral: true });
      }
    }
    if (interaction.customId === "select_delete_event") {
      await interaction.deferUpdate();
      const eventId = interaction.values[0];
      try {
        const event = await getEvent(config.calendarId, eventId);
        const f     = formatEventLocal(event);
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
        return interaction.editReply({
          content: `⚠️ 本当に削除しますか？\n\n**${f.title}**　${f.d}日(${f.w})　\`${f.timeStr}\``,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`btn_confirm_delete_${eventId}`).setLabel("🗑️ 削除する").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("btn_cancel_delete").setLabel("キャンセル").setStyle(ButtonStyle.Secondary),
          )],
        });
      } catch (err) {
        return interaction.editReply({ content: `❌ 取得失敗: ${err.message}`, components: [] });
      }
    }
  }

  if (interaction.isRoleSelectMenu()) {
    if (interaction.customId.startsWith("select_notify_role_")) {
      const eid  = interaction.customId.slice("select_notify_role_".length);
      const rid  = interaction.values[0];
      return interaction.update({ content: `⏰ <@&${rid}> への通知タイミングを選択してください：`, components: buildNotifyTimeButtons(eid, rid, "role") });
    }
  }

  if (interaction.isUserSelectMenu()) {
    if (interaction.customId.startsWith("select_notify_user_")) {
      const eid = interaction.customId.slice("select_notify_user_".length);
      const uid = interaction.values[0];
      return interaction.update({ content: `⏰ <@${uid}> への通知タイミングを選択してください：`, components: buildNotifyTimeButtons(eid, uid, "user") });
    }
  }

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
      const emsg = "❌ 時刻は `HH:MM` または `HHMM` 形式で入力してください。";
      await interaction.editReply({ content: fmtCd(emsg, 8) });
      startCountdownDelete(interaction, emsg, 8);
      return;
    }

    const timeInfo = startTime ? ` ${startTime}~${endTime || ""}` : " 終日";

    if (interaction.customId === "modal_add") {
      try {
        const event = await addEvent(config.calendarId, { title, dateStr, startTime, endTime, description });
        const { content: nc, components: nco } = buildNoticeManageComponents(guildId, event.id);
        await interaction.editReply({
          content: `✅ 追加しました！\n**${title}**　${dateStr}${timeInfo}${description ? `\n📝 ${description}` : ""}\n\n` + nc,
          components: nco,
        });
        const { year, month } = currentYM();
        const events = await getMonthEvents(config.calendarId, year, month);
        await updateBoth(guildId, config, events, year, month);
        saveState(guildId, { lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
        sendAuditLog("追加", interaction, { title, dateStr, timeStr: startTime ? `${startTime}~${endTime || ""}` : "終日", desc: description }, config.logChannelId);
      } catch (err) {
        const emsg = `❌ 追加失敗: ${err.message}`;
        await interaction.editReply({ content: fmtCd(emsg, 8) });
        startCountdownDelete(interaction, emsg, 8);
      }
    }

    if (interaction.customId.startsWith("modal_edit_")) {
      const prev = pendingEditInteractions.get(interaction.user.id);
      if (prev) { prev.deleteReply().catch(() => {}); pendingEditInteractions.delete(interaction.user.id); }
      const eventId = interaction.customId.replace("modal_edit_", "");
      try {
        await updateEvent(config.calendarId, eventId, { title, dateStr, startTime, endTime, description });
        resetFiredForEvent(guildId, eventId);
        const { content: nc, components: nco } = buildNoticeManageComponents(guildId, eventId);
        await interaction.editReply({
          content: `✅ 更新しました！\n**${title}**　${dateStr}${timeInfo}${description ? `\n📝 ${description}` : ""}\n\n` + nc,
          components: nco,
        });
        const { year, month } = currentYM();
        const events = await getMonthEvents(config.calendarId, year, month);
        await updateBoth(guildId, config, events, year, month);
        saveState(guildId, { lastHash: hashEvents(events), updatedAt: new Date().toISOString() });
        sendAuditLog("変更", interaction, { title, dateStr, timeStr: startTime ? `${startTime}~${endTime || ""}` : "終日", desc: description }, config.logChannelId);
      } catch (err) {
        const emsg = `❌ 更新失敗: ${err.message}`;
        await interaction.editReply({ content: fmtCd(emsg, 8) });
        startCountdownDelete(interaction, emsg, 8);
      }
    }
  }
});

function formatEventLocal(event) {
  return require("./calendar").formatEvent(event);
}

client.once("clientReady", async () => {
  const startupCount = getAndIncrementStartupCount();
  const ts           = fmtTimestamp();
  console.log("========================================");
  console.log(`  gcal-discord-bot v5 起動完了（マルチギルド）`);
  console.log(`  ログイン: ${client.user.tag}`);
  console.log(`  スケジュール: ${CRON_SCHEDULE}`);
  console.log(`  起動回数: ${startupCount} 回目 | ${ts}`);
  console.log(`  PID: ${process.pid}`);
  console.log("========================================");
  await registerGlobalCommands();
  const guildIds = getAllGuildIds();
  console.log(`[起動] 設定済みギルド数: ${guildIds.length}`);
  for (const gid of guildIds) {
    const cfg = loadConfig(gid);
    if (cfg) run(gid, cfg, true).catch(console.error);
  }
  cron.schedule(CRON_SCHEDULE, async () => {
    for (const gid of getAllGuildIds()) {
      const cfg = loadConfig(gid);
      if (cfg) run(gid, cfg, false).catch(console.error);
    }
  }, { timezone: "Asia/Tokyo" });
  console.log(`[Cron] 登録完了: "${CRON_SCHEDULE}"`);

  // 起動・再起動をログチャンネルに送信
  const isRestart  = startupCount > 1;
  const logColor   = isRestart ? 0xfee75c : 0x57f287;
  const logTitle   = isRestart ? `🔄 Bot 再起動 (#${startupCount})` : `✅ Bot 起動`;
  const logDesc    = `ログイン: **${client.user.tag}**\n起動時刻: ${ts}\nPID: ${process.pid}`;
  sendSystemLog(logColor, logTitle, logDesc).catch(console.error);
});

client.on("guildDelete", (guild) => {
  deleteConfig(guild.id);
  console.log(`[GuildDelete] 設定削除: ${guild.id}`);
});

// Discord 接続状態のログ
client.on("shardDisconnect", (event, shardId) => {
  const ts = fmtTimestamp();
  console.warn(`[Discord] 接続切断 (shard:${shardId}, code:${event.code}) ${ts}`);
  sendSystemLog(0xed4245, `⚠️ Discord 接続切断`, `shard: ${shardId} | code: ${event.code}\n時刻: ${ts}`).catch(() => {});
});
client.on("shardReconnecting", (shardId) => {
  const ts = fmtTimestamp();
  console.log(`[Discord] 再接続中... (shard:${shardId}) ${ts}`);
  sendSystemLog(0x5865f2, `🔄 Discord 再接続中…`, `shard: ${shardId}\n時刻: ${ts}`).catch(() => {});
});
client.on("shardResume", (shardId, replayed) => {
  const ts = fmtTimestamp();
  console.log(`[Discord] 接続再開 (shard:${shardId}, replayed:${replayed}) ${ts}`);
  sendSystemLog(0x57f287, `✅ Discord 接続再開`, `shard: ${shardId} | replayed: ${replayed}\n時刻: ${ts}`).catch(() => {});
});
client.on("error", (err) => {
  const ts = fmtTimestamp();
  console.error(`[Discord] エラー: ${err.message} ${ts}`);
  sendSystemLog(0xed4245, `❌ Discord エラー`, `${err.message}\n時刻: ${ts}`).catch(() => {});
});

client.login(process.env.DISCORD_TOKEN);

let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  const ts = fmtTimestamp();
  console.log(`[${signal}] シャットダウン開始...`);
  const timer = setTimeout(() => { console.error("[Shutdown] タイムアウト"); process.exit(1); }, 10000);
  try {
    // 停止通知をログチャンネルに送信
    await sendSystemLog(0xed4245, `🛑 Bot 停止`, `シグナル: ${signal}\n時刻: ${ts}`).catch(() => {});
    for (const gid of getAllGuildIds()) {
      const cfg = loadConfig(gid);
      if (!cfg) continue;
      const state   = loadState(gid);
      const channel = await client.channels.fetch(cfg.channelId).catch(() => null);
      if (!channel) continue;
      if (state.statusMessageId) {
        try {
          const msg = await channel.messages.fetch(state.statusMessageId);
          await msg.edit({ embeds: [buildStatusEmbed(gid, [], state.updatedAt, cfg.operatorRoleName, false)], components: [] });
        } catch (e) { console.error(`[Shutdown][${gid}]`, e.message); }
      }
      if (state.calendarMessageId) {
        try {
          const msg = await channel.messages.fetch(state.calendarMessageId);
          await msg.edit({ components: [] });
        } catch (e) { console.error(`[Shutdown][${gid}]`, e.message); }
      }
    }
  } catch (err) { console.error("[Shutdown] エラー:", err.message); }
  clearTimeout(timer);
  client.destroy();
  await logger.close();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM").catch(() => process.exit(1)));
process.on("SIGINT",  () => gracefulShutdown("SIGINT").catch(() =>  process.exit(1)));
process.on("SIGHUP",  () => gracefulShutdown("SIGHUP").catch(() =>  process.exit(1)));
process.on("unhandledRejection", (r) => console.error("[UnhandledRejection]", r));
process.on("uncaughtException",  (e) => console.error("[UncaughtException]",  e));