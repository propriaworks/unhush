import { describe, expect, it } from "vitest";
import { getLanguageStyle, languageFromText, normalizeLanguageCode } from "./languageDetection";

describe("language detection metadata", () => {
  it("normalizes common provider language codes and locale tags", () => {
    expect(normalizeLanguageCode("eng")).toBe("en");
    expect(normalizeLanguageCode("bn-IN")).toBe("bn");
    expect(normalizeLanguageCode("multi")).toBe("mix");
    expect(normalizeLanguageCode("auto")).toBe("");
  });

  it("recognizes English, Hindi, Bengali, and mixed scripts", () => {
    expect(languageFromText("This is English")).toBe("en");
    expect(languageFromText("यह हिन्दी है")).toBe("hi");
    expect(languageFromText("এটি বাংলা")).toBe("bn");
    expect(languageFromText("English বাংলা")).toBe("mix");
  });

  it("exposes stable labels and colors for the recording indicator", () => {
    expect(getLanguageStyle("hi")).toEqual({ code: "hi", label: "हिन्दी", color: "#f97316" });
    expect(getLanguageStyle("bn").label).toBe("বাংলা");
    expect(getLanguageStyle("unknown-code").color).toMatch(/^#/);
  });
});
