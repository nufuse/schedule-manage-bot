const { getLang, pick } = require("./i18n");

function createAppContext({
  client,
  logger,
  fs,
  path,
  cron,
  Discord,
  calendar,
  embed,
  modals,
  storage,
  notifier,
  guildConfig,
}) {
  return {
    client,
    logger,
    fs,
    path,
    cron,
    Discord,
    calendar,
    embed,
    modals,
    storage,
    notifier,
    guildConfig,
    getLang,
    pick,
  };
}

module.exports = { createAppContext };
