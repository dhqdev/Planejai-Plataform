import { useEffect } from "react";

/**
 * Teclado do celular, um jeito só para o app todo (2026-10-19, David: "sobe e desce a barra" e "muito alta com
 * relação ao teclado").
 *
 * - `installKeyboardWatch()` (uma vez, no main.tsx) mede a área visível de verdade (visualViewport) e publica no
 *   <html>: `--vvh` (altura visível), `--vvtop` (quanto o iOS deslocou a tela) e a classe `pj-kb` com o teclado
 *   aberto. Com `pj-kb` a barra de abas some e `--sab` (a folga do risco de baixo do iPhone) vira 0: com o
 *   teclado em cima não existe risco, e somar a folga deixava a caixa de escrever longe do teclado.
 * - `useKeyboardShell(ativo)` é para tela que tem caixa de escrever presa embaixo (Recados, chat do Início,
 *   compromisso da Agenda). A tela usa `top: var(--vvtop); height: var(--vvh)` (classe `.kb-shell` ou o próprio
 *   CSS), então encolhe junto com o teclado em vez de ser empurrada: o topo fica no lugar, a caixa fica colada
 *   no teclado e só a lista rola. Enquanto ela está aberta, arrastar fora de uma lista não move a página por
 *   trás (era o que fazia o iOS deslocar tudo e o topo sumir).
 * - Em qualquer tela, o campo com foco que ficou embaixo do teclado rola para dentro da sua lista.
 */

const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number", ""]);

/** Campo que abre o teclado do sistema (não conta select, data, arquivo, checkbox). */
export function opensKeyboard(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.has(el.type) && !el.readOnly && !el.disabled;
  return false;
}

let shells = 0;
let installed = false;

const scrollableY = (el: HTMLElement) => {
  const o = getComputedStyle(el).overflowY;
  return (o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight + 1;
};
const scrollableX = (el: HTMLElement) => {
  const o = getComputedStyle(el).overflowX;
  return (o === "auto" || o === "scroll") && el.scrollWidth > el.clientWidth + 1;
};

export function installKeyboardWatch() {
  const vv = window.visualViewport;
  if (installed || !vv) return;
  installed = true;
  const root = document.documentElement;
  const touch = window.matchMedia("(pointer: coarse)");
  let raf = 0;
  let last = { h: -1, top: -1, kb: false };
  const timers: number[] = [];

  // no iPhone instalado (PWA) o innerHeight às vezes encolhe junto com o teclado e a conta dá ~0, então campo de
  // texto com foco numa tela de toque também conta como teclado aberto
  const fit = () => {
    raf = 0;
    const h = Math.round(vv.height);
    const top = Math.round(vv.offsetTop);
    const gap = window.innerHeight - vv.height - vv.offsetTop;
    const kb = gap > 120 || (touch.matches && opensKeyboard(document.activeElement));
    if (h !== last.h) root.style.setProperty("--vvh", `${h}px`);
    if (top !== last.top) root.style.setProperty("--vvtop", `${top}px`);
    if (kb !== last.kb) root.classList.toggle("pj-kb", kb);
    last = { h, top, kb };
  };
  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(fit);
  };

  // campo com foco embaixo do teclado: rola a lista dele (não a página) até ele aparecer
  const reveal = () => {
    const a = document.activeElement;
    if (!opensKeyboard(a)) return;
    const f = a.getBoundingClientRect();
    const bottom = vv.offsetTop + vv.height - 12;
    const topLimit = vv.offsetTop + 12;
    for (let p = a.parentElement; p && p !== document.body; p = p.parentElement) {
      if (!scrollableY(p)) continue;
      const b = p.getBoundingClientRect();
      const lo = Math.min(b.bottom, bottom);
      const hi = Math.max(b.top, topLimit);
      if (f.bottom > lo) p.scrollTop += Math.min(f.bottom - lo, f.top - hi);
      else if (f.top < hi) p.scrollTop -= hi - f.top;
      return;
    }
  };
  const later = (fn: () => void, ...ms: number[]) => {
    for (const t of ms) timers.push(window.setTimeout(fn, t));
  };
  const clear = () => {
    while (timers.length) clearTimeout(timers.pop());
  };

  vv.addEventListener("resize", () => {
    schedule();
    clear();
    later(reveal, 60);
  });
  vv.addEventListener("scroll", schedule);
  document.addEventListener("focusin", () => {
    clear();
    fit();
    // o iOS só avisa a altura nova no fim da subida do teclado
    later(schedule, 120, 400);
    later(reveal, 350);
  });
  // ao sair do campo espera um pouco: tocar em Enviar tira o foco por um instante
  document.addEventListener("focusout", () => {
    clear();
    later(schedule, 150, 450);
  });

  // tela com caixa presa e teclado aberto: arrastar onde não há o que rolar não mexe na página por trás
  document.addEventListener(
    "touchmove",
    (e) => {
      if (!shells || !last.kb || e.touches.length > 1) return;
      for (let p = e.target instanceof Element ? e.target : null; p && p !== document.body; p = p.parentElement) {
        if (p instanceof HTMLElement && (scrollableY(p) || scrollableX(p))) return;
      }
      if (e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
  fit();
}

/** Liga o modo "caixa presa" enquanto a tela está aberta (ver comentário do arquivo). */
export function useKeyboardShell(active = true) {
  useEffect(() => {
    if (!active) return;
    shells++;
    document.documentElement.classList.add("pj-shell");
    return () => {
      shells--;
      if (!shells) document.documentElement.classList.remove("pj-shell");
    };
  }, [active]);
}
