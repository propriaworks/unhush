// afterPack hook: remove all Chromium locale files except English.
// Chromium locales cover its own UI strings (context menus, accessibility, etc.);
// they are unrelated to any app-level translations added later.
const fs = require("fs");
const path = require("path");

exports.default = async ({ appOutDir }) => {
  const dir = path.join(appOutDir, "locales");
  const keep = new Set(["en-US.pak", "en.pak"]);
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!keep.has(f)) {
      fs.unlinkSync(path.join(dir, f));
      removed++;
    }
  }
  console.log(`      strip-locales: removed ${removed} locale files, kept ${keep.size}`);
};
