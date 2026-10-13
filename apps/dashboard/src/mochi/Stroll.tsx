import { useEffect, useRef, useState } from "react";
import { Mochi, type Mood } from "./Mochi";
import { useOutfit } from "./state";

/**
 * O Mochi passeando pela tela. Ao abrir o app ele entra pulando pelo canto, acena e volta;
 * de vez em quando atravessa a tela de um lado ao outro, para no meio para olhar e segue.
 * Tocar nele: ele amassa, acena e vai embora. Desliga no guarda-roupa ("Passear pela tela")
 * e com movimento reduzido. Nada de efeito: só andar, pular e acenar.
 */

const PREF = "pj-mochi-passeio";
export function strollEnabled() {
  try {
    return localStorage.getItem(PREF) !== "0";
  } catch {
    return true;
  }
}
export function setStrollEnabled(on: boolean) {
  try {
    localStorage.setItem(PREF, on ? "1" : "0");
  } catch {
    /* sem storage */
  }
  window.dispatchEvent(new Event("pj:mochi-passeio"));
}

/** velocidade de caminhada, px por segundo */
const SPEED = 90;
const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((ok, no) => {
    const t = setTimeout(ok, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), no(new Error("abort"))), { once: true });
  });

export function MochiStroll() {
  const [outfit] = useOutfit();
  const [on, setOn] = useState(strollEnabled);
  const [show, setShow] = useState(false);
  const [mood, setMood] = useState<Mood>("idle");
  const [walking, setWalking] = useState(false);
  const [dir, setDir] = useState<1 | -1>(-1);
  const box = useRef<HTMLDivElement>(null);
  const x = useRef(0);
  const run = useRef<AbortController | null>(null);
  const phone = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
  const size = phone ? 50 : 66;

  useEffect(() => {
    const sync = () => setOn(strollEnabled());
    window.addEventListener("pj:mochi-passeio", sync);
    return () => window.removeEventListener("pj:mochi-passeio", sync);
  }, []);

  useEffect(() => {
    if (!on || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    /** anda até `to` (px a partir da esquerda), pulando */
    const walk = async (to: number, signal: AbortSignal) => {
      const el = box.current;
      if (!el) return;
      const from = x.current;
      const d = to > from ? 1 : -1;
      setDir(d);
      setWalking(true);
      const ms = (Math.abs(to - from) / SPEED) * 1000;
      const a = el.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], { duration: ms, easing: "linear", fill: "forwards" });
      // interrompido (toque): congela onde está e desiste da caminhada
      signal.addEventListener(
        "abort",
        () => {
          x.current = new DOMMatrix(getComputedStyle(el).transform).m41;
          a.pause();
        },
        { once: true },
      );
      await Promise.race([a.finished, wait(ms + 400, signal)]);
      if (signal.aborted) throw new Error("abort");
      x.current = to;
      setWalking(false);
    };

    const busy = () => document.hidden || !!document.querySelector(".modal-bg") || !strollEnabled();
    const width = () => window.innerWidth;
    const out = size + 20;

    /** entra pelo canto, dá oi e volta */
    const visit = async (signal: AbortSignal) => {
      x.current = width() + out * 0.2;
      setMood("idle");
      setShow(true);
      await wait(60, signal);
      await walk(width() - size - (phone ? 18 : 34), signal);
      setDir(-1);
      setMood("greeting");
      await wait(2600, signal);
      setMood("happy");
      await wait(500, signal);
      await walk(width() + out * 0.2, signal);
      setShow(false);
    };

    /** atravessa a tela; no meio para, olha para a pessoa, às vezes acena ou pula, e segue */
    const stroll = async (signal: AbortSignal) => {
      const ltr = Math.random() < 0.5;
      x.current = ltr ? -out : width() + 10;
      setMood("idle");
      setShow(true);
      await wait(60, signal);
      const mid = width() * (0.3 + Math.random() * 0.4);
      await walk(mid, signal);
      setDir(ltr ? 1 : -1);
      const r = Math.random();
      setMood(r < 0.4 ? "greeting" : r < 0.7 ? "curious" : "happy");
      await wait(2200, signal);
      setMood("idle");
      await walk(ltr ? width() + 10 : -out, signal);
      setShow(false);
    };

    let lastActive = Date.now();
    const active = () => {
      lastActive = Date.now();
    };
    window.addEventListener("pointerdown", active);
    window.addEventListener("keydown", active);

    const ctrl = new AbortController();
    /** cada passeio tem o seu controle: o toque cancela só o passeio, a desmontagem cancela tudo */
    const trip = () => {
      const t = new AbortController();
      ctrl.signal.addEventListener("abort", () => t.abort(), { once: true });
      run.current = t;
      return t.signal;
    };
    let timer: ReturnType<typeof setTimeout>;
    const next = (ms: number) => {
      timer = setTimeout(async () => {
        if (busy() || Date.now() - lastActive > 120_000) return next(60_000);
        try {
          await stroll(trip());
        } catch {
          if (ctrl.signal.aborted) return;
        }
        next(7 * 60_000 + Math.random() * 5 * 60_000);
      }, ms);
    };

    (async () => {
      let greeted = false;
      try {
        greeted = sessionStorage.getItem("pj-mochi-oi") === "1";
        sessionStorage.setItem("pj-mochi-oi", "1");
      } catch {
        /* sem storage */
      }
      try {
        if (!greeted) {
          await wait(1400, ctrl.signal);
          if (!busy()) await visit(trip());
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      next(4 * 60_000 + Math.random() * 3 * 60_000);
    })();

    return () => {
      ctrl.abort();
      clearTimeout(timer);
      setShow(false);
      window.removeEventListener("pointerdown", active);
      window.removeEventListener("keydown", active);
    };
  }, [on, size, phone]);

  // tocou nele: acena e vai embora pelo lado mais perto
  const tap = () => {
    const t = run.current;
    if (!t || t.signal.aborted || !box.current) return;
    t.abort();
    setWalking(false);
    setMood("greeting");
    const el = box.current;
    const leave = x.current > window.innerWidth / 2 ? window.innerWidth + 10 : -(size + 20);
    setTimeout(() => {
      setDir(leave > x.current ? 1 : -1);
      setMood("idle");
      setWalking(true);
      const a = el.animate([{ transform: `translateX(${x.current}px)` }, { transform: `translateX(${leave}px)` }], {
        duration: (Math.abs(leave - x.current) / (SPEED * 1.6)) * 1000,
        easing: "linear",
        fill: "forwards",
      });
      void a.finished
        .then(() => {
          x.current = leave;
          setWalking(false);
          setShow(false);
        })
        .catch(() => {});
    }, 1700);
  };

  if (!on || !show) return null;
  return (
    <div className="mochi-stroll" ref={box} style={{ transform: `translateX(${x.current}px)` }} aria-hidden="true">
      <span className="mochi-stroll-body" onPointerDown={tap}>
        <Mochi size={size} outfit={outfit} mood={mood} walking={walking} gaze={walking ? [dir * 0.9, 0.1] : undefined} />
      </span>
    </div>
  );
}
