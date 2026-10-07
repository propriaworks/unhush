// Clipboard contents that save/restore must leave alone, shared by both clipboard paths
// (clipboardAccess.cjs's Electron/X one and waylandClipboard.cjs). Restoring is skipped rather
// than done approximately: the transcript then stays on the clipboard, which is better than
// silently handing back something that behaves differently from what the user copied.

// Set by password managers (KeePassXC and others; a KDE convention) to keep the entry out of
// clipboard history. Neither path can re-offer it with the restored text, so a clipboard manager
// would record the password -- and we would rather not read the password at all.
const SENSITIVE_HINT = "x-kde-passwordManagerHint";

// Copied files. GTK file managers offer GNOME_FILES ("copy" or "cut", then the URIs); KDE's and
// others' offer text/uri-list. Restoring needs every type at once -- that is what makes a later
// paste copy or move the files -- and neither path can offer more than plain types, so a file
// copy would come back as text, and a cut as a copy at best.
const GNOME_FILES = "x-special/gnome-copied-files";
const URI_LIST = "text/uri-list";

// A text/uri-list holding only local files. A browser may offer one for a copied link, which
// is just text and fine to restore. Lines starting with # are comments (RFC 2483).
function isFileUriList(text) {
  const uris = text.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  return uris.length > 0 && uris.every((u) => u.startsWith("file://"));
}

module.exports = { SENSITIVE_HINT, GNOME_FILES, URI_LIST, isFileUriList };
