// Locating an executable on PATH. Shared because two modules need it for the same reason: to
// decide whether to offer the user a command before putting it in front of them.

const { spawnSync } = require("child_process");

// Absolute path to `bin`, or null when it isn't on PATH.
function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8", timeout: 3000 });
  const out = (r.stdout || "").trim();
  return r.status === 0 && out ? out : null;
}

module.exports = { which };
