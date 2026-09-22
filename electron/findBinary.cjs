// Locating a helper executable the way the session would, rather than trusting PATH alone.
//
// Used by the ydotool resolver, and kept separate from it because this is generic: at login PATH
// frequently is not the session's own (see ydotool.cjs's header for how that bites), so the usual
// install directories are searched as well. Callers must use the absolute path this returns rather
// than the bare name: with ydotool in particular, PATH may well resolve to the other generation.

const os = require("os");
const path = require("path");
const fs = require("fs");

// Directories to look in, in preference order: everything on PATH, then the usual install
// locations in case PATH is not the session's own. Deduplicated by real path, so the
// /bin -> /usr/bin symlink is not probed twice.
function candidateDirs() {
  const seen = new Set();
  const dirs = [];
  const add = (d) => {
    // Relative PATH entries (including "", which means the working directory) are skipped:
    // running a binary that happened to be sitting in our working directory is never right.
    if (!d || !path.isAbsolute(d)) return;
    let real = d;
    try { real = fs.realpathSync(d); } catch (e) {} // doesn't exist: keep it, it simply won't match
    if (seen.has(real)) return;
    seen.add(real);
    dirs.push(d);
  };
  for (const d of (process.env.PATH || "").split(path.delimiter)) add(d);
  for (const d of [path.join(os.homedir(), ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"]) add(d);
  return dirs;
}

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (e) {
    return false;
  }
}

/** First executable of this name in the candidate directories, or null. */
function findBinary(name) {
  for (const dir of candidateDirs()) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

module.exports = { candidateDirs, isExecutableFile, findBinary };
