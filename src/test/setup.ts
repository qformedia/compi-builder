import "@testing-library/jest-dom";
import { vi } from "vitest";

// Stub CSS imports (vidstack loads CSS at module level)
vi.mock("@vidstack/react/player/styles/default/theme.css", () => ({}));
vi.mock("@vidstack/react/player/styles/default/layouts/video.css", () => ({}));

// jsdom doesn't implement IntersectionObserver (used in ClipCard lazy-loading)
globalThis.IntersectionObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(_cb: any, _opts?: any) {}
} as any;

// jsdom localStorage polyfill (some vitest environments disable it)
if (typeof localStorage === "undefined" || typeof localStorage.setItem === "undefined") {
  const storage: Record<string, string> = {};
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      setItem: (k: string, v: string) => { storage[k] = v; },
      getItem: (k: string) => storage[k] ?? null,
      removeItem: (k: string) => { delete storage[k]; },
      clear: () => { Object.keys(storage).forEach((k) => delete storage[k]); },
    },
    writable: true,
  });
}

// Mock Tauri APIs — not available in jsdom
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `localfile://localhost/${path}`),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

// Stub window.__TAURI_INTERNALS__ so Tauri env checks don't throw
Object.defineProperty(window, "__TAURI_INTERNALS__", {
  value: {},
  writable: true,
});

// jsdom doesn't implement HTMLMediaElement methods
window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
window.HTMLMediaElement.prototype.pause = vi.fn();
window.HTMLMediaElement.prototype.load = vi.fn();
