// @vitest-environment node
//
// providerSetup.cjs is pure (no electron import, no IPC) -- see its header comment -- so it's
// exercised directly against the status shape RecordingBar.checkConfigWarnings() reports.

import { describe, it, expect } from "vitest";
const providerSetup = require("./providerSetup.cjs");

const ok = (provider: string) => ({ provider, reason: null });
const bad = (provider: string, reason: "config" | "badurl") => ({ provider, reason });

describe("providerSetup.problems", () => {
  it("reports nothing when status hasn't been reported yet", () => {
    expect(providerSetup.problems(null)).toEqual([]);
  });

  it("reports nothing when both providers are fully healthy (formatting on)", () => {
    const status = { transcription: ok("groq"), formatter: ok("groq") };
    expect(providerSetup.problems(status)).toEqual([]);
  });

  // Filtering an all-optional result down to "ok" is main.cjs's job (setupPreflight), not this
  // module's -- providerSetup always reports what it sees, optional or not.
  it("still reports the optional 'formatting is off' card when transcription is healthy", () => {
    const status = { transcription: ok("groq"), formatter: { provider: "none", reason: null } };
    const problems = providerSetup.problems(status);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ code: "formatter-off", optional: true });
  });

  it("flags a missing cloud transcription API key, pointing at the transcription tab", () => {
    const status = { transcription: bad("groq", "config"), formatter: { provider: "none", reason: null } };
    const [t, f] = providerSetup.problems(status);
    expect(t).toMatchObject({
      code: "transcription-provider",
      kind: "provider",
      actions: [{ label: "Open Transcription settings", tab: "transcription" }],
    });
    expect(t.title.toLowerCase()).toContain("choose a transcription provider");
    // No per-provider links here -- those live in Settings now (see Settings.tsx); the setup
    // window gets a provider-agnostic overview instead, since "groq" here is only ever our
    // arbitrary default, not a real choice the user made.
    expect(t.links).toBeUndefined();
    expect(t.note).toMatch(/groq and openai are commercial/i);
    // formatting is off and not misconfigured -> only the optional "off" card follows
    expect(f).toMatchObject({ code: "formatter-off", optional: true });
  });

  it("distinguishes a custom transcription server's unset model from a malformed URL", () => {
    const config = providerSetup.problems({
      transcription: bad("custom", "config"),
      formatter: { provider: "none", reason: null },
    })[0];
    const badurl = providerSetup.problems({
      transcription: bad("custom", "badurl"),
      formatter: { provider: "none", reason: null },
    })[0];
    expect(config.detail).not.toEqual(badurl.detail);
    expect(badurl.detail.toLowerCase()).toContain("url");
    expect(config.links).toBeUndefined();
  });

  it("flags a misconfigured cloud LLM formatter with the shared-key note, on the llm tab", () => {
    const status = { transcription: ok("groq"), formatter: bad("openai", "config") };
    const problems = providerSetup.problems(status);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      code: "formatter-provider",
      kind: "provider",
      actions: [{ label: "Open Formatting settings", tab: "llm" }],
    });
    expect(problems[0].note).toMatch(/same api key/i);
    expect(problems[0].optional).toBeUndefined();
  });

  it("flags a misconfigured custom LLM formatter without the shared-key note", () => {
    const status = { transcription: ok("groq"), formatter: bad("custom", "badurl") };
    const [problem] = providerSetup.problems(status);
    expect(problem.code).toBe("formatter-provider");
    // Still carries the general overview note -- just not the shared-key caveat, which only
    // applies to groq/openai formatting (custom has its own, separate API key field).
    expect(problem.note).not.toMatch(/same api key/i);
    expect(problem.note).toMatch(/groq and openai are commercial/i);
  });

  it("marks 'formatting is off' as optional advice, never a fault", () => {
    const status = { transcription: ok("groq"), formatter: { provider: "none", reason: null } };
    const [problem] = providerSetup.problems(status);
    expect(problem).toMatchObject({ code: "formatter-off", optional: true });
  });

  it("reports both cards when both providers are broken", () => {
    const status = { transcription: bad("openai", "config"), formatter: bad("groq", "config") };
    const problems = providerSetup.problems(status);
    expect(problems.map((p: any) => p.code)).toEqual(["transcription-provider", "formatter-provider"]);
  });
});
