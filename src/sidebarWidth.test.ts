import { describe, expect, it } from "vitest";
import {
  effectiveSidebarMaxWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./sidebarWidth";

describe("effectiveSidebarMaxWidth", () => {
  it("keeps the fixed cap on wide viewports", () => {
    expect(effectiveSidebarMaxWidth(1280)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("never steals chart width", () => {
    expect(effectiveSidebarMaxWidth(900)).toBe(900 - 560);
  });

  it("never drops below the minimum width", () => {
    expect(effectiveSidebarMaxWidth(500)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("keeps the default width within the cap", () => {
    expect(SIDEBAR_DEFAULT_WIDTH).toBeLessThanOrEqual(
      effectiveSidebarMaxWidth(1280),
    );
  });
});
