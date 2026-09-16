// Language metadata is supplied by the transcription service when available. These helpers
// provide a stable UI vocabulary and a conservative script fallback for services that return
// plain text only (notably useful for Bengali, Hindi, and mixed-script speech).

const LANGUAGE_ALIASES: Record<string, string> = {
  eng: "en", hin: "hi", ben: "bn", asm: "as", guj: "gu", kan: "kn", mal: "ml",
  mar: "mr", nep: "ne", pan: "pa", ori: "or", tam: "ta", tel: "te", urd: "ur",
  ara: "ar", deu: "de", ell: "el", spa: "es", fra: "fr", ita: "it", por: "pt",
  rus: "ru", zho: "zh", jpn: "ja", kor: "ko", vie: "vi", ind: "id", tha: "th",
  fas: "fa", heb: "he", nld: "nl", pol: "pl", ukr: "uk", tur: "tr", swe: "sv",
  dan: "da", fin: "fi", nor: "no", ces: "cs", ron: "ro", hun: "hu", swa: "sw",
  yue: "yue", mul: "mix", multi: "mix",
};

export const LANGUAGE_LABELS: Record<string, string> = {
  af: "Afrikaans", am: "አማርኛ", ar: "العربية", as: "অসমীয়া", az: "Azərbaycan",
  ba: "Башҡортса", be: "Беларуская", bg: "Български", bn: "বাংলা", bo: "བོད་ཡིག",
  br: "Brezhoneg", bs: "Bosanski", ca: "Català", cs: "Čeština", cy: "Cymraeg",
  da: "Dansk", de: "Deutsch", el: "Ελληνικά", en: "English", es: "Español",
  et: "Eesti", eu: "Euskara", fa: "فارسی", fi: "Suomi", fo: "Føroyskt",
  fr: "Français", gl: "Galego", gu: "ગુજરાતી", ha: "Hausa", haw: "ʻŌlelo Hawaiʻi",
  he: "עברית", hi: "हिन्दी", hr: "Hrvatski", ht: "Kreyòl Ayisyen", hu: "Magyar",
  hy: "Հայերեն", id: "Bahasa Indonesia", is: "Íslenska", it: "Italiano", ja: "日本語",
  jv: "Basa Jawa", ka: "ქართული", kk: "Қазақша", km: "ខ្មែរ", kn: "ಕನ್ನಡ",
  ko: "한국어", la: "Latin", lb: "Lëtzebuergesch", ln: "Lingála", lo: "ລາວ",
  lt: "Lietuvių", lv: "Latviešu", mg: "Malagasy", mi: "Māori", mk: "Македонски",
  ml: "മലയാളം", mn: "Монгол", mr: "मराठी", ms: "Melayu", mt: "Malti", my: "မြန်မာ",
  ne: "नेपाली", nl: "Nederlands", nn: "Nynorsk", no: "Norsk", oc: "Occitan",
  or: "ଓଡ଼ିଆ", pa: "ਪੰਜਾਬੀ", pl: "Polski", ps: "پښتو", pt: "Português", ro: "Română",
  ru: "Русский", sa: "संस्कृतम्", sd: "سنڌي", si: "සිංහල", sk: "Slovenčina",
  sl: "Slovenščina", sn: "Shona", so: "Soomaali", sq: "Shqip", sr: "Српски",
  su: "Basa Sunda", sv: "Svenska", sw: "Kiswahili", ta: "தமிழ்", te: "తెలుగు",
  tg: "Тоҷикӣ", th: "ไทย", tk: "Türkmençe", tl: "Filipino", tr: "Türkçe",
  tt: "Татарча", uk: "Українська", ur: "اردو", uz: "Oʻzbekcha", vi: "Tiếng Việt",
  yi: "ייִדיש", yo: "Yorùbá", zh: "中文", zu: "isiZulu", mix: "Mixed",
};

const LANGUAGE_COLORS: Record<string, string> = {
  en: "#38bdf8",
  hi: "#f97316",
  bn: "#22c55e",
  mix: "#c084fc",
  as: "#14b8a6",
  gu: "#eab308",
  kn: "#a855f7",
  ml: "#06b6d4",
  mr: "#f43f5e",
  or: "#fb923c",
  pa: "#818cf8",
  ta: "#84cc16",
  te: "#e879f9",
  ur: "#fb7185",
  ar: "#f59e0b",
  zh: "#ef4444",
  ja: "#60a5fa",
  ko: "#8b5cf6",
  es: "#facc15",
  fr: "#2dd4bf",
  de: "#fb923c",
  pt: "#4ade80",
  ru: "#818cf8",
  vi: "#f472b6",
  th: "#a3e635",
};

const LANGUAGE_PALETTE = [
  "#38bdf8", "#f97316", "#22c55e", "#c084fc", "#14b8a6", "#eab308",
  "#a855f7", "#ef4444", "#4ade80", "#60a5fa", "#f472b6", "#facc15",
];

export interface LanguageStyle {
  code: string;
  label: string;
  color: string;
}

export function normalizeLanguageCode(value: unknown): string {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return "";
  const base = raw.split("-", 1)[0];
  if (["auto", "unknown", "und", "none"].includes(base)) return "";
  return LANGUAGE_ALIASES[base] ?? base;
}

// This is intentionally script-based rather than a language guesser. It only claims a language
// when at least two letters from a script are visible, and reports mixed when multiple scripts
// occur. Provider metadata remains authoritative for languages sharing a script.
export function languageFromText(text: string): string {
  const counts: Record<string, number> = {
    pa: 0, bn: 0, hi: 0, gu: 0, or: 0, ta: 0, te: 0, kn: 0, ml: 0, si: 0,
    ar: 0, he: 0, el: 0, ru: 0, ka: 0, th: 0, lo: 0, my: 0, am: 0,
    zh: 0, ja: 0, ko: 0, en: 0,
  };
  for (const character of String(text ?? "")) {
    const point = character.codePointAt(0)!;
    if (point >= 0x0a00 && point <= 0x0a7f) counts.pa++;
    else if (point >= 0x0980 && point <= 0x09ff) counts.bn++;
    else if (point >= 0x0900 && point <= 0x097f) counts.hi++;
    else if (point >= 0x0a80 && point <= 0x0aff) counts.gu++;
    else if (point >= 0x0b00 && point <= 0x0b7f) counts.or++;
    else if (point >= 0x0b80 && point <= 0x0bff) counts.ta++;
    else if (point >= 0x0c00 && point <= 0x0c7f) counts.te++;
    else if (point >= 0x0c80 && point <= 0x0cff) counts.kn++;
    else if (point >= 0x0d00 && point <= 0x0d7f) counts.ml++;
    else if (point >= 0x0d80 && point <= 0x0dff) counts.si++;
    else if (point >= 0x0600 && point <= 0x06ff) counts.ar++;
    else if (point >= 0x0590 && point <= 0x05ff) counts.he++;
    else if (point >= 0x0370 && point <= 0x03ff) counts.el++;
    else if (point >= 0x0400 && point <= 0x04ff) counts.ru++;
    else if (point >= 0x10a0 && point <= 0x10ff) counts.ka++;
    else if (point >= 0x0e00 && point <= 0x0e7f) counts.th++;
    else if (point >= 0x0e80 && point <= 0x0eff) counts.lo++;
    else if (point >= 0x1000 && point <= 0x109f) counts.my++;
    else if (point >= 0x1200 && point <= 0x137f) counts.am++;
    else if (point >= 0x3040 && point <= 0x30ff) counts.ja++;
    else if (point >= 0xac00 && point <= 0xd7af) counts.ko++;
    else if (point >= 0x4e00 && point <= 0x9fff) counts.zh++;
    else if (point >= 0x0041 && point <= 0x007a) counts.en++;
  }
  // Japanese commonly contains kanji as well as kana; kana disambiguates it from Chinese.
  if (counts.ja >= 2) counts.zh = 0;
  const present = Object.entries(counts)
    .filter(([, count]) => count >= 2)
    .map(([language]) => language);
  return present.length > 1 ? "mix" : present[0] ?? "";
}

export function getLanguageStyle(value: string | null | undefined): LanguageStyle {
  const code = normalizeLanguageCode(value);
  if (!code) return { code: "", label: "Detecting", color: "#2e5bff" };
  let hash = 0;
  for (const character of code) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return {
    code,
    label: LANGUAGE_LABELS[code] ?? code.toUpperCase(),
    color: LANGUAGE_COLORS[code] ?? LANGUAGE_PALETTE[hash % LANGUAGE_PALETTE.length],
  };
}
