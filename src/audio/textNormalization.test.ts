import { describe, expect, it } from "vitest";
import { normalizePunctuation } from "./textNormalization";

describe("normalizePunctuation", () => {
  it("replaces typographic punctuation with its ASCII equivalent", () => {
    expect(normalizePunctuation("It’s “fine” — really…")).toBe(
      "It's \"fine\" -- really...",
    );
    expect(normalizePunctuation("pages 3–5, 6‐2")).toBe("pages 3-5, 6-2");
  });

  it("turns non-breaking and zero-width spaces into plain ASCII", () => {
    expect(normalizePunctuation("a b c d​e﻿")).toBe("a b c de");
  });

  it("leaves plain ASCII untouched", () => {
    const ascii = "It's \"fine\" -- really... 3-5";
    expect(normalizePunctuation(ascii)).toBe(ascii);
  });

  // Anything without an uncontroversial ASCII spelling must survive intact and reach the
  // clipboard fallback rather than be invented into something else.
  it("leaves scripts, accents and symbols intact", () => {
    const kept = "এটি বাংলা café 20° €5 3×4";
    expect(normalizePunctuation(kept)).toBe(kept);
  });
});
