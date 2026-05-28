function getLang(config) {
  return config?.language === "en" ? "en" : "ja";
}

function pick(lang, jaText, enText) {
  return lang === "en" ? enText : jaText;
}

module.exports = { getLang, pick };
