import { afterEach, describe, expect, it } from "vitest";
import {
  activateKeyboardFocusNav,
  initKeyboardFocusNav,
} from "./keyboardFocus";

const hasKeyboardNavClass = () =>
  document.documentElement.classList.contains("using-keyboard");

describe("keyboard focus navigation scoping", () => {
  afterEach(() => {
    document.documentElement.classList.remove("using-keyboard");
  });

  it("shows keyboard focus styles only while navigating with Tab", () => {
    initKeyboardFocusNav();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(hasKeyboardNavClass()).toBe(true);
  });

  it("does not treat a bare modifier key like Shift as keyboard navigation", () => {
    initKeyboardFocusNav();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    expect(hasKeyboardNavClass()).toBe(false);
  });

  it("lets component-owned keyboard commands reveal moved focus", () => {
    activateKeyboardFocusNav();
    expect(hasKeyboardNavClass()).toBe(true);
  });

  it("hides keyboard focus styles again after a pointer interaction", () => {
    initKeyboardFocusNav();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    window.dispatchEvent(new PointerEvent("pointerdown"));
    expect(hasKeyboardNavClass()).toBe(false);
  });

  it("stays idempotent when initialized more than once", () => {
    initKeyboardFocusNav();
    initKeyboardFocusNav();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(hasKeyboardNavClass()).toBe(true);
  });
});
