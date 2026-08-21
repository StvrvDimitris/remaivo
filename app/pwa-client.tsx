"use client";

import { useEffect } from "react";

export type RemaivoInstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

declare global {
  interface Window {
    __remaivoInstallPrompt?: RemaivoInstallPrompt;
  }
}

export function getRemaivoInstallPrompt() {
  return typeof window === "undefined" ? undefined : window.__remaivoInstallPrompt;
}

export function clearRemaivoInstallPrompt() {
  if (typeof window !== "undefined") delete window.__remaivoInstallPrompt;
}

export function PwaClient() {
  useEffect(() => {
    navigator.serviceWorker?.register("/sw.js", { scope: "/" }).catch(() => undefined);

    const announce = () => window.dispatchEvent(new Event("remaivo-install-state"));
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      window.__remaivoInstallPrompt = event as RemaivoInstallPrompt;
      announce();
    };
    const onInstalled = () => {
      clearRemaivoInstallPrompt();
      document.documentElement.dataset.remaivoInstalled = "true";
      announce();
    };

    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return null;
}
