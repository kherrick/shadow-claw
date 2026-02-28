// @ts-ignore
import { Signal } from "signal-polyfill";

/**
 * @typedef {'light' | 'dark' | 'system'} ThemeChoice
 * @typedef {'light' | 'dark'} ResolvedTheme
 */

/** @type {{ Light: 'light', Dark: 'dark', System: 'system' }} */
export const Themes = {
  Light: "light",
  Dark: "dark",
  System: "system",
};

const THEME_KEY = "shadow-claw-theme";

/**
 * Get the system theme preference
 *
 * @returns {ResolvedTheme}
 */
function getSystemTheme() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Resolve theme choice to actual theme
 *
 * @param {ThemeChoice} choice
 *
 * @returns {ResolvedTheme}
 */
function resolveTheme(choice) {
  return choice === "system" ? getSystemTheme() : choice;
}

/**
 * Apply theme to DOM
 *
 * @param {ResolvedTheme} resolved
 */
function applyTheme(resolved) {
  const root = document.documentElement;
  if (resolved === "dark") {
    root.classList.add("dark-mode");
    root.classList.remove("light-mode");
  } else {
    root.classList.add("light-mode");
    root.classList.remove("dark-mode");
  }

  // Also keep data-theme for compatibility or future use
  root.setAttribute("data-theme", resolved);

  // Apply to shadow-claw element directly for Firefox host-context compatibility
  const shadowClaw = document.querySelector("shadow-claw");
  if (shadowClaw) {
    if (resolved === "dark") {
      shadowClaw.classList.add("dark-mode");
      shadowClaw.classList.remove("light-mode");
    } else {
      shadowClaw.classList.add("light-mode");
      shadowClaw.classList.remove("dark-mode");
    }
  }

  // Dispatch event for other components to respond if needed
  window.dispatchEvent(
    new CustomEvent("shadow-claw-theme-change", {
      detail: { theme: resolved },
    }),
  );
}

const stored = /** @type {ThemeChoice} */ (
  localStorage.getItem(THEME_KEY) || "system"
);

const initialResolved = resolveTheme(stored);
applyTheme(initialResolved);

export class ThemeStore {
  constructor() {
    /** @type {Signal.State<ThemeChoice>} */
    this._theme = new Signal.State(stored);
    /** @type {Signal.State<ResolvedTheme>} */
    this._resolved = new Signal.State(initialResolved);
  }

  get theme() {
    return this._theme.get();
  }
  get resolved() {
    return this._resolved.get();
  }

  /**
   * Set the theme
   *
   * @param {ThemeChoice} theme
   */
  setTheme(theme) {
    const resolved = resolveTheme(theme);
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(resolved);
    this._theme.set(theme);
    this._resolved.set(resolved);
  }

  /**
   * Get current theme info
   *
   * @returns {{theme: ThemeChoice; resolved: ResolvedTheme}}
   */
  getTheme() {
    return { theme: this.theme, resolved: this.resolved };
  }

  /**
   * Initialize listeners - should be called once
   */
  init() {
    // Listen for system theme changes
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    mql.addEventListener("change", () => {
      if (this.theme === "system") {
        const resolved = getSystemTheme();
        applyTheme(resolved);
        this._resolved.set(resolved);
      }
    });

    // Listen for storage changes (tab sync)
    window.addEventListener("storage", (e) => {
      if (e.key === THEME_KEY && e.newValue) {
        this.setTheme(/** @type {ThemeChoice} */ (e.newValue));
      }
    });
  }
}

export const themeStore = new ThemeStore();
themeStore.init();
