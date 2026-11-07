"use client";

import { useSyncExternalStore } from "react";
import { Icon } from "./icons";

type Theme = "light" | "dark";

const media = () => matchMedia("(prefers-color-scheme: dark)");

function current(): Theme {
  const t = document.documentElement.dataset.theme;
  if (t === "light" || t === "dark") return t;
  return media().matches ? "dark" : "light";
}

/** The theme follows the stamped choice, or the system setting while there is none. */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = media();
  mq.addEventListener("change", onChange);
  return () => {
    observer.disconnect();
    mq.removeEventListener("change", onChange);
  };
}

/** Switches between light and dark; the choice is remembered on this device. */
export function ThemeToggle() {
  // null on the server: the icon appears once the browser knows the theme.
  const theme = useSyncExternalStore<Theme | null>(subscribe, current, () => null);
  const toggle = () => {
    const next: Theme = current() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("ff-theme", next);
    } catch {
      // storage unavailable: the choice lasts for this page only
    }
  };
  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex size-8 items-center justify-center rounded-[var(--radius-control)] text-muted hover:bg-raised hover:text-ink"
      aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
      title={theme === "dark" ? "Use light theme" : "Use dark theme"}
    >
      {theme === "dark" ? <Icon.sun /> : <Icon.moon />}
    </button>
  );
}
