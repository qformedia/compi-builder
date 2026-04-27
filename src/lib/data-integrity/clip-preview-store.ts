import { useSyncExternalStore } from "react";
import type { Clip } from "@/types";

type Listener = () => void;

let activeClip: Clip | null = null;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return activeClip;
}

export function getActivePreview(): Clip | null {
  return activeClip;
}

export function setActivePreview(clip: Clip | null) {
  const unchanged =
    activeClip === null
      ? clip === null
      : clip !== null && clip.id === activeClip.id;
  if (unchanged) return;
  activeClip = clip;
  emit();
}

export function clearActivePreview() {
  if (activeClip === null) return;
  activeClip = null;
  emit();
}

export function useActivePreview(): Clip | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
