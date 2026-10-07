import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api";
import type { Mood, Outfit } from "./Mochi";

/**
 * Humor e roupinha do Mochi, compartilhados pelo app inteiro.
 * O humor reage ao que acontece: salvando = trabalhando, deu certo = pronto, deu erro = erro,
 * parado muito tempo = dormindo. A roupinha fica salva na conta (e no aparelho, para abrir já vestido).
 */

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const KEY = "pj-mochi";
let outfit: Outfit = read();
let mood: Mood = "idle";
let transient: { mood: Mood; until: number } | null = null;
let pending = 0;
let asleep = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function read(): Outfit {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function recompute() {
  const now = Date.now();
  let next: Mood = asleep ? "sleeping" : "idle";
  if (pending > 0) next = "working";
  if (transient && transient.until > now) next = transient.mood;
  if (next !== mood) {
    mood = next;
    emit();
  }
}

/** Mostra um humor por um tempo (ex.: "finished" por 2 s) e depois volta ao normal. */
export function flashMood(m: Mood, ms = 2200) {
  transient = { mood: m, until: Date.now() + ms };
  asleep = false;
  clearTimeout(timer);
  timer = setTimeout(() => {
    transient = null;
    recompute();
  }, ms);
  recompute();
}

export function useMochiMood() {
  return useSyncExternalStore(subscribe, () => mood);
}

export function useOutfit(): [Outfit, (o: Outfit) => void] {
  const o = useSyncExternalStore(subscribe, () => outfit);
  return [o, setOutfit];
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
export function setOutfit(o: Outfit) {
  outfit = o;
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    /* sem storage */
  }
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void api("/api/me/mascot", { method: "PUT", json: { outfit: o }, headers: { "x-pj-quiet": "1" } }).catch(() => {});
  }, 500);
}

export function openWardrobe() {
  window.dispatchEvent(new Event("pj:mochi-open"));
}

/** Liga o Mochi ao app: chamado uma vez depois do login. */
export function useMochiLife() {
  useEffect(() => {
    void api<{ outfit?: Outfit } | null>("/api/me/mascot")
      .then((r) => {
        if (r?.outfit && JSON.stringify(r.outfit) !== JSON.stringify(outfit)) {
          outfit = r.outfit;
          try {
            localStorage.setItem(KEY, JSON.stringify(outfit));
          } catch {
            /* sem storage */
          }
          emit();
        }
      })
      .catch(() => {});

    const onApi = (e: Event) => {
      const d = (e as CustomEvent<{ phase: "start" | "ok" | "error" }>).detail;
      if (d.phase === "start") pending++;
      else {
        pending = Math.max(0, pending - 1);
        if (d.phase === "ok") flashMood("finished", 1800);
        else flashMood("error", 2600);
      }
      recompute();
    };

    // parado por 3 minutos: ele cochila; ao voltar, dá oi
    let idle: ReturnType<typeof setTimeout>;
    const wake = () => {
      clearTimeout(idle);
      if (asleep) {
        asleep = false;
        flashMood("greeting", 2000);
      }
      idle = setTimeout(() => {
        asleep = true;
        recompute();
      }, 180_000);
    };
    wake();
    flashMood("greeting", 2400);

    window.addEventListener("pj:api", onApi);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearTimeout(idle);
      window.removeEventListener("pj:api", onApi);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);
}
