/**
 * Scopes :focus-visible styles to real keyboard navigation.
 *
 * Chromium treats any keydown (including a bare modifier like Shift) as a
 * keyboard interaction, so :focus-visible matches even when the element was
 * focused by a mouse click and the user merely holds Shift afterwards. That
 * draws unexpected focus rings around clicked buttons. Only navigation that
 * deliberately moves focus (Tab, or a component-owned keyboard command)
 * should reveal the ring, so this module toggles a `using-keyboard` class on
 * <html> that the stylesheet keys off of.
 */
const KEYBOARD_NAV_CLASS = "using-keyboard";

let initialized = false;
let keyboardNavActive = false;

export function activateKeyboardFocusNav(): void {
  keyboardNavActive = true;
  document.documentElement.classList.add(KEYBOARD_NAV_CLASS);
}

function clearKeyboardNav(): void {
  if (!keyboardNavActive) return;
  keyboardNavActive = false;
  document.documentElement.classList.remove(KEYBOARD_NAV_CLASS);
}

export function initKeyboardFocusNav(): void {
  if (initialized) return;
  initialized = true;

  window.addEventListener("keydown", (event) => {
    if (event.key === "Tab") activateKeyboardFocusNav();
  });
  window.addEventListener("pointerdown", clearKeyboardNav);
}
