// Turns the renderer's provider-config status (see RecordingBar.checkConfigWarnings and
// preload.cjs's setProviderStatus) into cards for the first-run setup window, in the same shape
// as ydotool.cjs's preflight problems and waylandShortcut.cjs's shortcutProblem
// ({code, title, detail, commands?, note?}), extended with an `actions` row: this module is
// referral-only and never lets the setup window edit provider settings itself.
//
// No `electron` import here (mirrors the other two setup-card modules) -- keeps this testable
// without mocking IPC, and keeps main.cjs the only place that talks to ipcMain/shell.

// Deliberately no per-provider links (console.groq.com/keys, platform.openai.com/api-keys, the
// local-models doc) here -- those live in Settings now, next to the field they're actually for
// (see Settings.tsx's ProviderHelpLink). Whichever provider looks "selected" at this point is
// only ever our arbitrary default (unhush_provider defaults to "groq"), never a real choice the
// user made -- a single link tied to that default would look like a recommendation it isn't.
// This is a plain-language overview of the *options* instead, so a fresh install shows what's on
// the menu before Settings shows how to fill in whichever one gets picked.
const PROVIDER_OVERVIEW =
  "Groq and OpenAI are commercial cloud providers -- Groq (not to be confused with Grok) has a " +
  "generous free tier that covers most usage. Other OpenAI-compatible servers, including a fully " +
  "local one, work through the Custom option; for privacy, that's what we'd recommend.";

// reason -> {title, detail} pairs, one set per concern. Custom-provider wording differs from
// cloud wording ("unset" vs "no key") because the two validators (validateTranscriptionConfig /
// validateLLMConfig) fail on different fields: cloud providers need only an API key, custom
// providers need a model name and a well-formed URL.
function transcriptionCard(status) {
  const { provider, reason } = status.transcription || {};
  if (!reason) return null;
  const isCustom = provider === "custom";
  const title = isCustom
    ? "Finish setting up your transcription server"
    : "Choose a transcription provider";
  const detail =
    reason === "badurl"
      ? "The custom transcription server URL isn't valid. Fix it in Settings."
      : isCustom
      ? "Unhush needs a model name (and a running server) to transcribe your voice."
      : "Unhush needs an API key before it can transcribe anything.";
  return {
    code: "transcription-provider",
    kind: "provider",
    title,
    detail,
    note: PROVIDER_OVERVIEW,
    actions: [{ label: "Open Transcription settings", tab: "transcription" }],
  };
}

function formatterCard(status) {
  const { provider, reason } = status.formatter || {};
  if (reason) {
    const isCustom = provider === "custom";
    const title = isCustom
      ? "Finish setting up your LLM server"
      : "Finish setting up LLM formatting";
    const detail =
      reason === "badurl"
        ? "The custom LLM server URL isn't valid. Fix it in Settings."
        : isCustom
        ? "The custom LLM needs a model name (and a running server) to clean up transcripts."
        : "The selected LLM provider needs an API key.";
    // groq/openai formatting reuses the key entered on the Transcription tab (see Settings.tsx's
    // "Uses the API key from the Transcription tab" hint) -- easy to miss from here, so it's
    // prepended ahead of the general overview rather than replacing it.
    const note = isCustom
      ? PROVIDER_OVERVIEW
      : `Uses the same API key as the Transcription tab, once you've set one there. ${PROVIDER_OVERVIEW}`;
    return {
      code: "formatter-provider",
      kind: "provider",
      title,
      detail,
      note,
      actions: [{ label: "Open Formatting settings", tab: "llm" }],
    };
  }
  if (provider === "none") {
    // Advice, not a fault: optional means this card may ride along when the window is already
    // open for another reason, but must never open the window by itself (see setupPreflight()).
    return {
      code: "formatter-off",
      kind: "provider",
      title: "Optional: clean up transcripts with an LLM",
      detail:
        "Unhush can run your dictation through an LLM to fix punctuation and remove filler " +
        "words. Though recommended, it's off by default -- turn it on any time in Settings.",
      note: PROVIDER_OVERVIEW,
      actions: [{ label: "Open Formatting settings", tab: "llm" }],
      optional: true,
    };
  }
  return null;
}

// status: null (never reported yet) or
//   { transcription: { provider: "groq"|"openai"|"custom", reason: null|"config"|"badurl" },
//     formatter:     { provider: "none"|"groq"|"openai"|"custom", reason: null|"config"|"badurl" } }
// Returns [] on null status rather than guessing nothing is configured -- a crashed or
// not-yet-mounted renderer must never manufacture a false problem.
function problems(status) {
  if (!status) return [];
  const out = [];
  const t = transcriptionCard(status);
  if (t) out.push(t);
  const f = formatterCard(status);
  if (f) out.push(f);
  return out;
}

module.exports = { problems };
