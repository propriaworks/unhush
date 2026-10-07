// @vitest-environment node
//
// The rule that tells a copied-files URI list (not restored) from a copied link (restored as text).

import { describe, it, expect } from "vitest";
// @ts-expect-error - plain CommonJS module, no type declarations
import { isFileUriList } from "./clipboardTypes.cjs";

describe("isFileUriList", () => {
  it("recognises local files, with CRLF or LF line ends and RFC 2483 comments", () => {
    expect(isFileUriList("file:///home/me/a.txt\r\nfile:///home/me/b%20c.pdf\r\n")).toBe(true);
    expect(isFileUriList("# from dolphin\nfile:///tmp/x\n")).toBe(true);
  });

  it("treats links, and lists mixing links with files, as text", () => {
    expect(isFileUriList("https://example.com/page\r\n")).toBe(false);
    expect(isFileUriList("file:///tmp/x\r\nhttps://example.com\r\n")).toBe(false);
  });

  it("treats an empty list as not files", () => {
    expect(isFileUriList("")).toBe(false);
    expect(isFileUriList("# only a comment\r\n")).toBe(false);
  });
});
