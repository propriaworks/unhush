import { useState, useEffect } from "react";
import { LLM_DEFAULT_CUSTOM_URL, LLM_DEFAULT_MODELS, LLM_DEFAULT_SYSTEM_PROMPT } from "../audio/llmApi";

type Provider = "groq" | "openai" | "custom";
type LLMProvider = "none" | "groq" | "openai" | "custom";
type Tab = "transcription" | "llm";

const SHORTCUT_OPTIONS = [
  "Shift+Space",
  "Ctrl+Alt+Space",
  "Ctrl+Shift+Space",
  "Ctrl+Shift+Insert",
  "Alt+F12",
]; // Note: ScrollLock, Super key, and ContextMenu key combos don't work

function Settings() {
  const [tab, setTab] = useState<Tab>("transcription");

  // Transcription settings
  const [groqKey, setGroqKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [provider, setProvider] = useState<Provider>("groq");
  const [shortcut, setShortcut] = useState("Shift+Space");
  const [showPassword, setShowPassword] = useState(false);

  // LLM post-processing settings
  const [llmProvider, setLlmProvider] = useState<LLMProvider>("none");
  const [llmModelGroq, setLlmModelGroq] = useState("");
  const [llmModelOpenai, setLlmModelOpenai] = useState("");
  const [llmModelCustom, setLlmModelCustom] = useState("");
  const [llmCustomUrl, setLlmCustomUrl] = useState("");
  const [llmCustomKey, setLlmCustomKey] = useState("");
  const [llmSystemPrompt, setLlmSystemPrompt] = useState(LLM_DEFAULT_SYSTEM_PROMPT);

  useEffect(() => {
    setGroqKey(localStorage.getItem("wisper_groq_key") || "");
    setOpenaiKey(localStorage.getItem("wisper_openai_key") || "");
    setCustomKey(localStorage.getItem("wisper_custom_key") || "");
    setCustomUrl(localStorage.getItem("wisper_custom_url") || "");
    setCustomModel(localStorage.getItem("wisper_custom_model") || "");
    setProvider((localStorage.getItem("wisper_provider") as Provider) || "groq");
    setShortcut(localStorage.getItem("wisper_shortcut") || "Shift+Space");
    setLlmProvider((localStorage.getItem("wisper_llm_provider") as LLMProvider) || "none");
    setLlmModelGroq(localStorage.getItem("wisper_llm_model_groq") || "");
    setLlmModelOpenai(localStorage.getItem("wisper_llm_model_openai") || "");
    setLlmModelCustom(localStorage.getItem("wisper_llm_model_custom") || "");
    setLlmCustomUrl(localStorage.getItem("wisper_llm_custom_url") || LLM_DEFAULT_CUSTOM_URL);
    setLlmCustomKey(localStorage.getItem("wisper_llm_custom_key") || "");
    setLlmSystemPrompt(localStorage.getItem("wisper_llm_system_prompt") || LLM_DEFAULT_SYSTEM_PROMPT);
  }, []);

  const currentKey = provider === "groq" ? groqKey : provider === "openai" ? openaiKey : customKey;
  const setCurrentKey = provider === "groq" ? setGroqKey : provider === "openai" ? setOpenaiKey : setCustomKey;
  const currentKeyStorageKey = provider === "groq" ? "wisper_groq_key" : provider === "openai" ? "wisper_openai_key" : "wisper_custom_key";

  const currentLlmModel =
    llmProvider === "groq" ? llmModelGroq :
    llmProvider === "openai" ? llmModelOpenai :
    llmProvider === "custom" ? llmModelCustom : "";
  const setCurrentLlmModel =
    llmProvider === "groq" ? setLlmModelGroq :
    llmProvider === "openai" ? setLlmModelOpenai :
    llmProvider === "custom" ? setLlmModelCustom : (() => {});
  const currentLlmModelStorageKey = `wisper_llm_model_${llmProvider}`;

  // Helper: update React state + persist to localStorage in one step
  const persist = (setter: (v: string) => void, key: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setter(e.target.value);
      localStorage.setItem(key, e.target.value);
    };

  const handleProviderChange = (newProvider: Provider) => {
    setProvider(newProvider);
    localStorage.setItem("wisper_provider", newProvider);
  };

  const handleLlmProviderChange = (newProvider: LLMProvider) => {
    setLlmProvider(newProvider);
    localStorage.setItem("wisper_llm_provider", newProvider);
  };

  const handleShortcutChange = (newShortcut: string) => {
    setShortcut(newShortcut);
    localStorage.setItem("wisper_shortcut", newShortcut);
    window.electronAPI?.updateShortcut(newShortcut);
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
            <h1 className="text-base font-semibold">Wisper</h1>
            <p className="text-white/50 text-xs">Voice dictation for Linux</p>
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
                    className={`flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all ${
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
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={currentKey}
                    onChange={persist(setCurrentKey, currentKeyStorageKey)}
                    placeholder={provider === "groq" ? "gsk_..." : provider === "openai" ? "sk-..." : "Bearer token..."}
                    className="w-full bg-white/5 border border-white/10 rounded-lg pl-3 pr-10 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
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
              {provider === "custom" && (
                <>
                  <div>
                    <label className="block text-white/70 text-xs font-medium mb-1">API URL</label>
                    <input
                      type="text"
                      value={customUrl}
                      onChange={persist(setCustomUrl, "wisper_custom_url")}
                      placeholder="https://localhost:8000/v1/audio/transcriptions"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                    />
                  </div>
                  <div>
                    <label className="block text-white/70 text-xs font-medium mb-1">Model name</label>
                    <input
                      type="text"
                      value={customModel}
                      onChange={persist(setCustomModel, "wisper_custom_model")}
                      placeholder="whisper-1"
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="p-3 bg-white/5 rounded-xl border border-white/5">
              <label className="block text-white/70 text-xs font-medium mb-2">
                Shortcut
              </label>
              <select
                value={shortcut}
                onChange={(e) => handleShortcutChange(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-primary-500 appearance-none cursor-pointer"
              >
                {SHORTCUT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt} className="bg-gray-800">
                    {opt}
                  </option>
                ))}
              </select>
            </div>
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
                    className={`flex-1 py-2 px-1 rounded-lg text-xs font-medium transition-all ${
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
                  Uses the API key from the Transcription tab.
                </p>
              )}
              {llmProvider !== "none" && (
                <>
                  <div>
                    <label className="block text-white/70 text-xs font-medium mb-1">Language Model</label>
                    <input
                      type="text"
                      value={currentLlmModel}
                      onChange={persist(setCurrentLlmModel, currentLlmModelStorageKey)}
                      placeholder={
                        llmProvider === "groq" ? LLM_DEFAULT_MODELS.groq :
                        llmProvider === "openai" ? LLM_DEFAULT_MODELS.openai :
                        "model name"
                      }
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                    />
                  </div>
                  {llmProvider === "custom" && (
                    <>
                      <div>
                        <label className="block text-white/70 text-xs font-medium mb-1">API URL</label>
                        <input
                          type="text"
                          value={llmCustomUrl}
                          onChange={persist(setLlmCustomUrl, "wisper_llm_custom_url")}
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                        />
                      </div>
                      <div>
                        <label className="block text-white/70 text-xs font-medium mb-1">API Key <span className="text-white/40">(optional)</span></label>
                        <input
                          type="password"
                          value={llmCustomKey}
                          onChange={persist(setLlmCustomKey, "wisper_llm_custom_key")}
                          placeholder="Bearer token..."
                          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500"
                        />
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
                  onChange={persist(setLlmSystemPrompt, "wisper_llm_system_prompt")}
                  rows={5}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary-500 resize-y"
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
