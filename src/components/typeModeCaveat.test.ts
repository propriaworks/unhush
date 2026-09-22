import { describe, expect, it } from "vitest";
import { typeModeCaveat, type TypeModeInfo } from "./Settings";

// Which caveat Settings shows under Type. Asserted by what each message must and must not
// mention rather than by its exact prose, so tuning the wording does not fail the test.
const NON_ASCII = "Text with accents or non-Latin scripts is pasted instead.";

const layoutIndependent: TypeModeInfo = { layoutPinned: true };
// ydotool 0.x, or Wayland outside sway/Hyprland, or the pin failed: US-QWERTY only.
const qwertyOnly: TypeModeInfo = { layoutPinned: false };

describe("typeModeCaveat", () => {
  it("always ends with the non-ASCII note, which holds in every session", () => {
    for (const info of [layoutIndependent, qwertyOnly, null]) {
      expect(typeModeCaveat(info).endsWith(NON_ASCII)).toBe(true);
    }
  });

  it("says nothing about layouts once the virtual keyboard carries a us layout", () => {
    expect(typeModeCaveat(layoutIndependent)).toBe(NON_ASCII);
  });

  it("warns that only QWERTY works when the layout could not be pinned", () => {
    expect(typeModeCaveat(qwertyOnly)).toMatch(/QWERTY/);
  });

  // Before the main process answers, only what is true everywhere may be shown -- otherwise the
  // text visibly changes from wrong to right as the window opens.
  it("claims nothing about layouts until the session is known", () => {
    expect(typeModeCaveat(null)).toBe(NON_ASCII);
  });
});
