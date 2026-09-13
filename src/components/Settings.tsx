import { useState, useEffect, useRef } from "react";
import { LLM_DEFAULT_CUSTOM_URL, LLM_DEFAULT_MODELS, LLM_DEFAULT_SYSTEM_PROMPT } from "../audio/llmApi";
import { TRANSCRIPTION_DEFAULT_CUSTOM_URL } from "../audio/transcriptionApi";
import {
  PROVIDER_BASE_URLS,
  getBaseUrl,
  getCachedModels,
  refreshModels,
  formatTranscriptionHint,
  formatLlmHint,
  type ModelInfo,
} from "../audio/customModelService";
import { ModelCombobox } from "./ModelCombobox";

type Provider = "groq" | "openai" | "custom";
type LLMProvider = "none" | "groq" | "openai" | "custom";
type Tab = "transcription" | "llm" | "usability";

const OUTPUT_METHODS: OutputMethod[] = ["paste", "type", "clipboard"];
const isOutputMethod = (v: string | null): v is OutputMethod =>
  OUTPUT_METHODS.includes(v as OutputMethod);

const SHORTCUT_OPTIONS = [
  "Ctrl+Alt+\\",
  "Ctrl+Alt+Space",
  "Ctrl+Shift+Space",
  "Ctrl+Shift+Insert",
  "Alt+F12",
]; // Note: ScrollLock, Super key, and ContextMenu key combos don't work

// Paired with the setup window's overview (see electron/providerSetup.cjs), which deliberately
// shows no per-provider links -- whichever one looks "selected" there is only ever our default,
// not a real choice yet. Here the provider IS an actual selection, so a contextual link to the
// right place makes sense; kept next to the field it's actually for on both the Transcription and
// Formatting tabs.
const GROQ_KEYS_URL = "https://console.groq.com/keys";
const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";
const LOCAL_MODELS_URL = "https://unhush.propriaworks.com/local-models";

function ProviderHelpLink({ provider }: { provider: Provider }) {
  const [label, url] =
    provider === "groq" ? ["Get a free API key — the free tier covers most usage", GROQ_KEYS_URL] :
    provider === "openai" ? ["Get an API key", OPENAI_KEYS_URL] :
    ["Guide: running models locally for privacy", LOCAL_MODELS_URL];
  return (
    <p className="text-white/40 text-xs">
      <a href={url} target="_blank" rel="noopener" className="text-primary-400 hover:underline">
        {label}
      </a>
    </p>
  );
}

function Settings() {
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "transcription" || t === "llm" || t === "usability" ? t : "transcription";
  });

  // Transcription settings
  const [groqKey, setGroqKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [provider, setProvider] = useState<Provider>("groq");
  const [shortcut, setShortcut] = useState("Ctrl+Alt+Space");
  // native: Unhush holds the key grab (X11). portal: the desktop holds it for us and only its own
  // editor can change it. manual: no GlobalShortcuts portal here, so the user binds toggleCommand.
  const [shortcutMode, setShortcutMode] = useState<"native" | "portal" | "manual">("native");
  // The portal's description of the live key, e.g. "Ctrl+Alt+Space". "" means every trigger has
  // been unchecked in the desktop's editor, which leaves the shortcut silently dead.
  const [portalTrigger, setPortalTrigger] = useState<string | null>(null);
  // The command a desktop-environment shortcut should run to toggle recording (see
  // electron/commandFifo.cjs). Offered on every platform: it can bind keys this dropdown doesn't
  // list, and it's the only mechanism that works on Wayland.
  const [toggleCommand, setToggleCommand] = useState("");
  // One transient status line shared by the buttons under the toggle command ("Copied ✓",
  // "Opening…"): each action needs the same acknowledgement, and only one can be the most
  // recent. The timer is held so a second click restarts it rather than inheriting the
  // first click's remaining time.
  const [shortcutFlash, setShortcutFlash] = useState("");
  const shortcutFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [shortcutError, setShortcutError] = useState("");
  const [outputMethod, setOutputMethod] = useState<OutputMethod>("paste");
  const [duckingAmount, setDuckingAmount] = useState(40);
  const [chimesEnabled, setChimesEnabled] = useState(true);
  const [keepMicWarm, setKeepMicWarm] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // "Start at login" -- unsupported (card hidden) on AppImage/dev, where no systemd unit is
  // shipped. Read from systemd itself, never locally cached: see get-autostart-status.
  const [autostartSupported, setAutostartSupported] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartError, setAutostartError] = useState("");

  // LLM post-processing settings
  const [llmProvider, setLlmProvider] = useState<LLMProvider>("none");
  const [llmModelGroq, setLlmModelGroq] = useState("");
  const [llmModelOpenai, setLlmModelOpenai] = useState("");
  const [llmModelCustom, setLlmModelCustom] = useState("");
  const [llmCustomUrl, setLlmCustomUrl] = useState("");
  const [llmCustomKey, setLlmCustomKey] = useState("");
  const [llmSystemPrompt, setLlmSystemPrompt] = useState(LLM_DEFAULT_SYSTEM_PROMPT);
  const [customStartCmd, setCustomStartCmd] = useState("");
  const [llmCustomStartCmd, setLlmCustomStartCmd] = useState("");
  const [transcriptionModels, setTranscriptionModels] = useState<ModelInfo[]>([]);
  const [llmModels, setLlmModels] = useState<ModelInfo[]>([]);

  useEffect(() => {
    setGroqKey(localStorage.getItem("unhush_groq_key") || "");
    setOpenaiKey(localStorage.getItem("unhush_openai_key") || "");
    setCustomKey(localStorage.getItem("unhush_custom_key") || "");
    setCustomUrl(localStorage.getItem("unhush_custom_url") || TRANSCRIPTION_DEFAULT_CUSTOM_URL);
    setCustomModel(localStorage.getItem("unhush_custom_model") || "");
    setProvider((localStorage.getItem("unhush_provider") as Provider) || "groq");
    setShortcut(localStorage.getItem("unhush_shortcut") || "Ctrl+Alt+Space");
    setOutputMethod((localStorage.getItem("unhush_output_method") as OutputMethod) || "paste");
    setDuckingAmount(parseInt(localStorage.getItem("unhush_ducking_amount") ?? "40", 10));
    setChimesEnabled(localStorage.getItem("unhush_chimes_enabled") !== "false");
    setKeepMicWarm(localStorage.getItem("unhush_keep_mic_warm") === "true");
    setLlmProvider((localStorage.getItem("unhush_llm_provider") as LLMProvider) || "none");
    setLlmModelGroq(localStorage.getItem("unhush_llm_model_groq") || LLM_DEFAULT_MODELS.groq);
    setLlmModelOpenai(localStorage.getItem("unhush_llm_model_openai") || LLM_DEFAULT_MODELS.openai);
    setLlmModelCustom(localStorage.getItem("unhush_llm_model_custom") || "");
    setLlmCustomUrl(localStorage.getItem("unhush_llm_custom_url") || LLM_DEFAULT_CUSTOM_URL);
    setLlmCustomKey(localStorage.getItem("unhush_llm_custom_key") || "");
    setLlmSystemPrompt(localStorage.getItem("unhush_llm_system_prompt") || LLM_DEFAULT_SYSTEM_PROMPT);
    setCustomStartCmd(localStorage.getItem("unhush_custom_start_cmd") || "");
    setLlmCustomStartCmd(localStorage.getItem("unhush_llm_custom_start_cmd") || "");

    // Hydrate model lists from cache (populated by ensureCustomServices on first recording)
    const cachedT = getCachedModels(getBaseUrl(localStorage.getItem("unhush_custom_url") || ""));
    if (cachedT) setTranscriptionModels(cachedT);
    const cachedL = getCachedModels(getBaseUrl(localStorage.getItem("unhush_llm_custom_url") || ""));
    if (cachedL) setLlmModels(cachedL);

    const loadShortcutInfo = () => {
      window.electronAPI?.getShortcutInfo().then((info) => {
        setShortcutMode(info.mode);
        setToggleCommand(info.command);
        setPortalTrigger(info.trigger);
      });
    };
    loadShortcutInfo();
    // Also whenever this window comes back to the front. On the portal path the key is edited in
    // the desktop's own editor -- which is where "Change shortcut…" sends you -- so returning to
    // Settings is exactly when the displayed key is most likely to be out of date.
    window.addEventListener("focus", loadShortcutInfo);

    const handleNavigateTab = (_event: unknown, newTab: string) => {
      if (newTab === "transcription" || newTab === "llm" || newTab === "usability") {
        setTab(newTab);
      }
    };
    window.electronAPI?.onNavigateTab(handleNavigateTab);
    return () => {
      window.removeEventListener("focus", loadShortcutInfo);
      window.electronAPI?.removeAllListeners("navigate-tab");
    };
  }, []);

  const currentKey = provider === "groq" ? groqKey : provider === "openai" ? openaiKey : customKey;
  const setCurrentKey = provider === "groq" ? setGroqKey : provider === "openai" ? setOpenaiKey : setCustomKey;
  const currentKeyStorageKey = provider === "groq" ? "unhush_groq_key" : provider === "openai" ? "unhush_openai_key" : "unhush_custom_key";

  const currentLlmModel =
    llmProvider === "groq" ? llmModelGroq :
    llmProvider === "openai" ? llmModelOpenai :
    llmProvider === "custom" ? llmModelCustom : "";
  const setCurrentLlmModel =
    llmProvider === "groq" ? setLlmModelGroq :
    llmProvider === "openai" ? setLlmModelOpenai :
    llmProvider === "custom" ? setLlmModelCustom : (() => {});
  const currentLlmModelStorageKey = `unhush_llm_model_${llmProvider}`;

  const llmBaseUrl =
    llmProvider === "groq" ? PROVIDER_BASE_URLS.groq :
    llmProvider === "openai" ? PROVIDER_BASE_URLS.openai :
    getBaseUrl(llmCustomUrl);

  const llmApiKey =
    llmProvider === "groq" ? groqKey :
    llmProvider === "openai" ? openaiKey :
    llmCustomKey;

  // Clear stale model list when the user switches LLM provider
  useEffect(() => { setLlmModels([]); }, [llmProvider]);

  // Helper: update React state + persist to localStorage in one step
  const persist = (setter: (v: string) => void, key: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setter(e.target.value);
      localStorage.setItem(key, e.target.value);
    };

  const handleProviderChange = (newProvider: Provider) => {
    setProvider(newProvider);
    localStorage.setItem("unhush_provider", newProvider);
  };

  const handleLlmProviderChange = (newProvider: LLMProvider) => {
    setLlmProvider(newProvider);
    localStorage.setItem("unhush_llm_provider", newProvider);
  };

  const handleOutputMethodChange = (method: OutputMethod) => {
    setOutputMethod(method);
    localStorage.setItem("unhush_output_method", method);
    window.electronAPI?.setOutputMethod(method);
  };

  // Briefly highlights whichever output button was just selected *for* the user (as opposed to
  // one they clicked themselves, which is already visibly selected the instant they touch it).
  // Cleared on a timer rather than an animationend listener so a second external change while one
  // is still fading restarts the clock instead of leaving it stuck (or racing a stale un-set).
  const [justSetOutput, setJustSetOutput] = useState<OutputMethod | null>(null);
  const justSetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const applyExternalOutputMethod = (method: OutputMethod) => {
    handleOutputMethodChange(method);
    clearTimeout(justSetTimer.current);
    setJustSetOutput(null);
    // Restart from "no highlight" on the next frame so a repeat of the same method still restarts
    // the CSS animation (an unchanged class name otherwise wouldn't replay it).
    requestAnimationFrame(() => setJustSetOutput(method));
    justSetTimer.current = setTimeout(() => setJustSetOutput(null), 5000);
  };

  // The setup dialog's "Use Clipboard mode instead" doesn't just navigate here -- it asks for the
  // mode to be selected. Routed through the click handler so it persists and tells main exactly as
  // a click would. Declared after the hydrating effect above, so it wins the initial render.
  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("output");
    if (isOutputMethod(fromQuery)) applyExternalOutputMethod(fromQuery);

    window.electronAPI?.onSetOutputMethodUiSetting((_event, method) => {
      if (isOutputMethod(method)) applyExternalOutputMethod(method);
    });
    return () => {
      window.electronAPI?.removeAllListeners("set-output-method-ui-setting");
      clearTimeout(justSetTimer.current);
    };
  }, []);

  // Own effect, not folded into the hydrating one above: this reads from systemd, not
  // localStorage, and can drift independently (e.g. the user runs `systemctl --user
  // enable/disable` by hand) -- so it's re-checked on focus the same way shortcut info is.
  useEffect(() => {
    const loadAutostartStatus = () => {
      window.electronAPI?.getAutostartStatus().then((status) => {
        setAutostartSupported(status.supported);
        setAutostartEnabled(status.enabled);
      });
    };
    loadAutostartStatus();
    window.addEventListener("focus", loadAutostartStatus);
    return () => window.removeEventListener("focus", loadAutostartStatus);
  }, []);

  const handleShortcutChange = (newShortcut: string) => {
    setShortcut(newShortcut);
    localStorage.setItem("unhush_shortcut", newShortcut);
    window.electronAPI?.updateShortcut(newShortcut);
  };

  const flashShortcutStatus = (message: string, ms = 2000) => {
    clearTimeout(shortcutFlashTimer.current);
    setShortcutFlash(message);
    shortcutFlashTimer.current = setTimeout(() => setShortcutFlash(""), ms);
  };
  useEffect(() => () => clearTimeout(shortcutFlashTimer.current), []);

  const copyToggleCommand = async () => {
    await window.electronAPI?.copyToClipboard(toggleCommand);
    flashShortcutStatus("Copied ✓");
  };

  // ConfigureShortcuts opens the desktop's own shortcut editor, focused on Unhush's entry. This is
  // the only way a portal-bound key can be changed -- the portal honours our preferred trigger on
  // the first bind and never again. The editor can take seconds to appear, and an unacknowledged
  // button reads as a broken one; "Opening" rather than "Opened" because the call only tells us the
  // request was accepted, not that a window was drawn.
  const openShortcutEditor = async () => {
    setShortcutError("");
    flashShortcutStatus("Opening…", 5000);
    const r = await window.electronAPI?.configureShortcut();
    if (r && !r.ok) {
      flashShortcutStatus("");
      setShortcutError(r.error || "Could not open your desktop's shortcut editor.");
    }
  };

  const handleDuckingAmountChange = (newAmount: number) => {
    setDuckingAmount(newAmount);
    localStorage.setItem("unhush_ducking_amount", String(newAmount));
    window.electronAPI?.setDuckingConfig({ amount: newAmount });
  };

  const handleChimesEnabledChange = (enabled: boolean) => {
    setChimesEnabled(enabled);
    localStorage.setItem("unhush_chimes_enabled", String(enabled));
  };

  const handleKeepMicWarmChange = (enabled: boolean) => {
    setKeepMicWarm(enabled);
    localStorage.setItem("unhush_keep_mic_warm", String(enabled));
  };

  // Optimistic UI update, reverted on failure -- mirrors openShortcutEditor's async/inline-error
  // shape above. State lives in systemd, not localStorage, so on error we re-read it rather than
  // guess: main's set-autostart may have partially applied (e.g. enable succeeded, the desktop
  // override write failed), and get-autostart-status reports what's actually true either way.
  const handleAutostartChange = async (enabled: boolean) => {
    setAutostartEnabled(enabled);
    setAutostartError("");
    const r = await window.electronAPI?.setAutostart(enabled);
    if (r && !r.ok) {
      setAutostartError(r.error || "Could not change the autostart setting.");
      window.electronAPI?.getAutostartStatus().then((status) => setAutostartEnabled(status.enabled));
    }
  };

  return (
    <div className="min-h-screen bg-dark-400 text-white p-4">
      <div className="max-w-sm mx-auto">
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-full bg-primary-500 flex items-center justify-center shadow-lg shadow-primary-500/20">
            <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="text-left">
            <h1 className="text-base font-semibold">Unhush</h1>
            <p className="text-white/50 text-xs">Voice input for Linux</p>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex gap-1 mb-3 p-1 bg-white/5 rounded-xl">
          <button
            type="button"
            onClick={() => setTab("transcription")}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
              tab === "transcription"
                ? "bg-white/10 text-white"
                : "text-white/50 hover:text-white/70"
            }`}
          >
            Transcription
          </button>
          <button
            type="button"
            onClick={() => setTab("llm")}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
              tab === "llm"
                ? "bg-white/10 text-white"
                : "text-white/50 hover:text-white/70"
            }`}
          >
            Formatting
          </button>
          <button
            type="button"
            onClick={() => setTab("usability")}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
              tab === "usability"
                ? "bg-white/10 text-white"
                : "text-white/50 hover:text-white/70"
            }`}
          >
            Usability
          </button>
        </div>

        {/* Transcription tab */}
        {tab === "transcription" && (
          <div className="space-y-3">
            <div className="p-3 bg-white/5 rounded-xl border border-white/5 space-y-2">
              <label className="block text-white/70 text-xs font-medium">
                Provider
              </label>
              <div className="flex gap-2">
                {(["groq", "openai", "custom"] as Provider[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handleProviderChange(p)}
                    className={`flex-1 py-1 px-3 rounded-lg text-sm font-medium transition-all ${
                      provider === p
                        ? "bg-primary-500 text-white"
                        : "bg-white/5 text-white/60 hover:bg-white/10"
                    }`}
                  >
                    {p === "openai" ? "OpenAI" : p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-white/70 text-xs font-medium mb-1">
                  API Key <span className="text-white/40">{provider === "custom" ? "(optional)" : ""}</span>
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={currentKey}
                    onChange={persist(setCurrentKey, currentKeyStorageKey)}
                    placeholder={provider === "groq" ? "gsk_..." : provider === "openai" ? "sk-..." : "Bearer token (if required)"}
                    className="w-full bg-white/5 border border-white/10 rounded-lg pl-3 pr-10 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/70"
                  >
                    {showPassword ? (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <ProviderHelpLink provider={provider} />
              {provider === "custom" && (
                <>
                  <div>
                    <label className="block text-white/70 text-xs font-medium mb-1">Server URL</label>
                    <input
                      type="text"
                      value={customUrl}
                      onChange={persist(setCustomUrl, "unhush_custom_url")}
                      placeholder="http://localhost:8000"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                    />
                  </div>
                  <div>
                    <label className="block text-white/70 text-xs font-medium mb-1">Model name</label>
                    <ModelCombobox
                      value={customModel}
                      onChange={(v) => { setCustomModel(v); localStorage.setItem("unhush_custom_model", v); }}
                      models={transcriptionModels}
                      formatHint={formatTranscriptionHint}
                      onFocus={async () => {
                        const fresh = await refreshModels(getBaseUrl(customUrl), customKey);
                        if (fresh) setTranscriptionModels(fresh);
                      }}
                      placeholder="Systran/faster-whisper-large-v3"
                    />
                  </div>
                  <div>
                    <label className="block text-white/70 text-xs font-medium mb-1">
                      Start Command <span className="text-white/40">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={customStartCmd}
                      onChange={persist(setCustomStartCmd, "unhush_custom_start_cmd")}
                      placeholder="docker compose -f speaches-compose.yaml up --detach"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                    />
                    <p className="text-white/40 text-xs mt-1">Shell command to start this service if it&apos;s not running; may re-run every couple of minutes while it&apos;s down, so avoid one that launches a duplicate (e.g. &quot;docker compose up&quot;, not &quot;docker run&quot;).</p>
                  </div>
                </>
              )}
            </div>

          </div>
        )}

        {/* Usability tab */}
        {tab === "usability" && (
          <div className="space-y-3">
            <div className="p-3 bg-white/5 rounded-xl border border-white/5 space-y-2">
              <label className="block text-white/70 text-xs font-medium">
                Output
              </label>
              <div className="flex gap-2">
                {OUTPUT_METHODS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => handleOutputMethodChange(m)}
                    className={`flex-1 py-1 px-3 rounded-lg text-sm font-medium transition-all ${
                      outputMethod === m
                        ? "bg-primary-500 text-white"
                        : "bg-white/5 text-white/60 hover:bg-white/10"
                    } ${justSetOutput === m ? "animate-halo" : ""}`}
                  >
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
              <p className="text-white/40 text-xs">
                {outputMethod === "paste" && "Text is pasted instantly via the clipboard. Works in terminals and GUI apps. Avoids unexpected results."}
                {outputMethod === "type" && "Characters typed one-by-one. Slower, but you can read the text as it appears."}
                {outputMethod === "clipboard" && "Text is copied to clipboard. You paste manually."}
              </p>
            </div>

            <div className="p-3 bg-white/5 rounded-xl border border-white/5">
              <label className="block text-white/70 text-xs font-medium mb-2">
                Shortcut
              </label>
              {/* Only the native path can offer a list: on the portal path the desktop owns the
                  key and hands back its own description of it, and in manual mode there is no key
                  to show until the user binds one. */}
              {shortcutMode === "native" && (
                <select
                  value={shortcut}
                  onChange={(e) => handleShortcutChange(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-primary-500 appearance-none cursor-pointer"
                >
                  {SHORTCUT_OPTIONS.map((opt) => (
                    <option key={opt} value={opt} className="bg-gray-800">
                      {opt}
                    </option>
                  ))}
                </select>
              )}
              {shortcutMode === "portal" && (
                <>
                  <div className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white">
                    {portalTrigger || "None — every shortcut is disabled"}
                  </div>
                  <p className="text-white/40 text-xs mt-1">
                    {portalTrigger
                      ? "On Wayland your desktop owns this key. Unhush can suggest one the first " +
                        "time it runs, but only your desktop's own editor can change it afterwards."
                      : "Your desktop has this shortcut registered but every key for it is " +
                        "switched off, so nothing will happen when you press one. Open the editor " +
                        "to enable a key, or use the tray icon."}
                  </p>
                </>
              )}
              {shortcutMode === "manual" && (
                <p className="text-white/40 text-xs">
                  This desktop couldn't register a shortcut key for Unhush, so you need to set
                  one for yourself: add one that runs the command below.
                </p>
              )}

              {/* Works on every session type, so it's always offered: it's how you bind a key this
                  list doesn't include, and how scripts can start and stop dictation. */}
              <p className="text-white/40 text-xs mt-2">
                {shortcutMode === "manual"
                  ? "Command to run:"
                  : "Alternatively, you can run this command to toggle recording (bound to a system shortcut key, e.g.):"}
              </p>
              <pre className="mt-1 px-2 py-1.5 bg-black/30 border border-white/10 rounded-lg text-white/70 text-[11px] font-mono whitespace-pre-wrap break-all select-text">
                {toggleCommand}
              </pre>
              <div className="flex items-center gap-2 mt-1.5">
                <button
                  onClick={copyToggleCommand}
                  className="px-2 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/70 text-xs"
                >
                  Copy
                </button>
                {shortcutMode === "portal" && (
                  <button
                    onClick={openShortcutEditor}
                    className="px-2 py-1 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-white/70 text-xs"
                  >
                    Change shortcut…
                  </button>
                )}
                {shortcutFlash && <span className="text-green-400 text-xs">{shortcutFlash}</span>}
              </div>
              {shortcutError && (
                <p className="text-red-400 text-xs mt-1">{shortcutError}</p>
              )}
            </div>

            <div className="p-3 bg-white/5 rounded-xl border border-white/5 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-white/70 text-xs font-medium">
                  Chimes
                </label>
                <div className="flex gap-2">
                  {([true, false] as const).map((enabled) => (
                    <button
                      key={String(enabled)}
                      type="button"
                      onClick={() => handleChimesEnabledChange(enabled)}
                      className={`py-1 px-4 rounded-lg text-sm font-medium transition-all ${
                        chimesEnabled === enabled
                          ? "bg-primary-500 text-white"
                          : "bg-white/5 text-white/60 hover:bg-white/10"
                      }`}
                    >
                      {enabled ? "On" : "Off"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-white/40 text-xs">
                Play a short chime when recording starts and stops.
              </p>
            </div>

            <div className="p-3 bg-white/5 rounded-xl border border-white/5 space-y-2">
              <label className="block text-white/70 text-xs font-medium">
                Attenuate other audio while recording
              </label>
              <div className="flex gap-2">
                {([0, 40, 60, 100] as const).map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => handleDuckingAmountChange(preset)}
                    className={`flex-1 py-1 px-3 rounded-lg text-sm font-medium transition-all ${
                      duckingAmount === preset
                        ? "bg-primary-500 text-white"
                        : "bg-white/5 text-white/60 hover:bg-white/10"
                    }`}
                  >
                    {preset === 0 ? "Off" : preset === 100 ? "Mute" : `${preset}%`}
                  </button>
                ))}
              </div>
              <p className="text-white/40 text-xs">
                {duckingAmount === 0 && "Other apps play at their normal volume while you record."}
                {duckingAmount > 0 && duckingAmount < 100 &&
                  `Other apps ramp down by ${duckingAmount}% while you record, then back up.`}
                {duckingAmount === 100 && "Other apps are muted while you record, then ramp back up."}
              </p>
            </div>

            <div className="p-3 bg-white/5 rounded-xl border border-white/5 space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-white/70 text-xs font-medium">
                  Keep microphone warm
                </label>
                <div className="flex gap-2">
                  {([true, false] as const).map((enabled) => (
                    <button
                      key={String(enabled)}
                      type="button"
                      onClick={() => handleKeepMicWarmChange(enabled)}
                      className={`py-1 px-4 rounded-lg text-sm font-medium transition-all ${
                        keepMicWarm === enabled
                          ? "bg-primary-500 text-white"
                          : "bg-white/5 text-white/60 hover:bg-white/10"
                      }`}
                    >
                      {enabled ? "On" : "Off"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-white/40 text-xs">
                {keepMicWarm
                  ? "The microphone stays open between recordings so the next one starts instantly. Your system's mic-in-use indicator stays on."
                  : "The microphone is released after each recording. Some mics (especially USB) can take a second or more to wake back up."}
              </p>
            </div>

            {autostartSupported && (
              <div className="p-3 bg-white/5 rounded-xl border border-white/5 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-white/70 text-xs font-medium">
                    Start at login
                  </label>
                  <div className="flex gap-2">
                    {([true, false] as const).map((enabled) => (
                      <button
                        key={String(enabled)}
                        type="button"
                        onClick={() => handleAutostartChange(enabled)}
                        className={`py-1 px-4 rounded-lg text-sm font-medium transition-all ${
                          autostartEnabled === enabled
                            ? "bg-primary-500 text-white"
                            : "bg-white/5 text-white/60 hover:bg-white/10"
                        }`}
                      >
                        {enabled ? "On" : "Off"}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-white/40 text-xs">
                  {autostartEnabled
                    ? "Unhush launches automatically when you log in."
                    : "Unhush only runs when you launch it yourself."}
                </p>
                {autostartError && (
                  <p className="text-red-400 text-xs">{autostartError}</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* LLM tab */}
        {tab === "llm" && (
          <div className="space-y-3">
            <div className="p-3 bg-white/5 rounded-xl border border-white/5 space-y-2">
              <label className="block text-white/70 text-xs font-medium">
                Provider
              </label>
              <div className="flex gap-2">
                {(["none", "groq", "openai", "custom"] as LLMProvider[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => handleLlmProviderChange(p)}
                    className={`flex-1 py-1 px-1 rounded-lg text-xs font-medium transition-all ${
                      llmProvider === p
                        ? "bg-primary-500 text-white"
                        : "bg-white/5 text-white/60 hover:bg-white/10"
                    }`}
                  >
                    {p === "none" ? "Off" : p === "openai" ? "OpenAI" : p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
              {(llmProvider === "groq" || llmProvider === "openai") && (
                <p className="text-white/40 text-xs">
                  Uses the API key from the Transcription tab, even if not selected
                </p>
              )}
              {llmProvider === "none" && (
                <p className="text-white/40 text-xs">
                  Off: transcripts are returned exactly as transcribed, with no punctuation,
                  grammar, or filler-word cleanup.
                </p>
              )}
              {llmProvider !== "none" && <ProviderHelpLink provider={llmProvider} />}
              {llmProvider !== "none" && (
                <>
                  <div>
                    <label className="block text-white/70 text-xs font-medium mb-1">
                      Language Model{llmProvider === "custom" && <span className="text-white/40 font-normal"> (fetched from the server)</span>}
                    </label>
                    <ModelCombobox
                      value={currentLlmModel}
                      onChange={(v) => { setCurrentLlmModel(v); localStorage.setItem(currentLlmModelStorageKey, v); }}
                      models={llmModels}
                      formatHint={formatLlmHint}
                      onFocus={async () => {
                        const fresh = await refreshModels(llmBaseUrl, llmApiKey);
                        if (fresh) setLlmModels(fresh);
                      }}
                      placeholder={
                        llmProvider === "groq" ? LLM_DEFAULT_MODELS.groq :
                        llmProvider === "openai" ? LLM_DEFAULT_MODELS.openai :
                        "model name"
                      }
                    />
                  </div>
                  {llmProvider === "custom" && (
                    <>
                      <div>
                        <label className="block text-white/70 text-xs font-medium mb-1">Server URL</label>
                        <input
                          type="text"
                          value={llmCustomUrl}
                          onChange={persist(setLlmCustomUrl, "unhush_llm_custom_url")}
                          placeholder="http://localhost:11434"
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                        />
                      </div>
                      <div>
                        <label className="block text-white/70 text-xs font-medium mb-1">API Key <span className="text-white/40">(optional)</span></label>
                        <input
                          type="password"
                          value={llmCustomKey}
                          onChange={persist(setLlmCustomKey, "unhush_llm_custom_key")}
                          placeholder="Bearer token (if required)"
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                        />
                      </div>
                      <div>
                        <label className="block text-white/70 text-xs font-medium mb-1">
                          Start Command <span className="text-white/40">(optional)</span>
                        </label>
                        <input
                          type="text"
                          value={llmCustomStartCmd}
                          onChange={persist(setLlmCustomStartCmd, "unhush_llm_custom_start_cmd")}
                          placeholder="ollama serve"
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                        />
                        <p className="text-white/40 text-xs mt-1">Shell command to start this service if it&apos;s not running; may re-run every couple of minutes while it&apos;s down, so avoid one that launches a duplicate (e.g. &quot;docker compose up&quot;, not &quot;docker run&quot;).</p>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {llmProvider !== "none" && (
              <div className="p-3 bg-white/5 rounded-xl border border-white/5">
                <label className="block text-white/70 text-xs font-medium mb-2">System Prompt</label>
                <textarea
                  value={llmSystemPrompt}
                  onChange={persist(setLlmSystemPrompt, "unhush_llm_system_prompt")}
                  rows={3}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500 resize-y"
                />
              </div>
            )}
          </div>
        )}

        <p className="mt-4 text-center text-white/25 text-xs">v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}

export default Settings;
