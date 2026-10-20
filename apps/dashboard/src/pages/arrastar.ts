import type React from "react";
import { haptic } from "../touch";
import type { Ev } from "./Calendar";

/**
 * Arrastar um lembrete para outro dia ou horário (David, 2026-10-20: "não me dá uma pré-visualização").
 * Enquanto arrasta: o dia/coluna de destino acende, um cartão tracejado aparece onde ele vai cair (no horário
 * certo, já encaixado de 15 em 15 minutos, com a duração dele) e uma etiqueta perto do dedo diz o dia e a hora
 * novos. Perto da borda da lista a rolagem anda sozinha. Soltou: o cartão tracejado fica até a agenda recarregar,
 * sem o lembrete voltar para o lugar antigo e pular. Mouse arrasta na hora; dedo depois de segurar um instante.
 */

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const dia = (d: Date) => `${DIAS[d.getDay()]}, ${d.getDate()} ${MESES[d.getMonth()]}`;
const dayOf = (k: string) => {
  const [y, m, d] = k.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

let endedAt = 0;
/** Acabou de soltar um arrasto: o deslizar para trocar de semana/mês não deve disparar junto. */
export const justDragged = () => Date.now() - endedAt < 450;

type Opts = {
  /** "day": só troca o dia (mês); "time": dia e horário (semana/dia) */
  mode: "day" | "time";
  hourPx?: number;
  firstHour?: number;
  /** sem onDrop (agenda só de leitura) não arrasta */
  onDrop?: (ev: Ev, at: Date) => unknown;
};

/** Primeiro ancestral que rola na vertical: é ele que anda quando o dedo chega na borda. */
function scrollParent(el: HTMLElement | null) {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

export function useDrag(o: Opts) {
  return (ev: Ev) => (e: React.PointerEvent) => {
    if (!o.onDrop || ev.kind !== "reminder" || ev.recurring) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const onDrop = o.onDrop;
    const hourPx = o.hourPx ?? 48;
    const first = (o.firstHour ?? 0) * 60;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const touch = e.pointerType !== "mouse";
    const startX = e.clientX;
    const startY = e.clientY;
    const grabX = startX - rect.left;
    const grabY = startY - rect.top;
    const start = new Date(ev.start);
    const dur = ev.end ? Math.max(15, (new Date(ev.end).getTime() - start.getTime()) / 60000) : 60;

    // mouse só vira arrasto depois de andar uns pixels: clique parado abre o detalhe
    let active = false;
    let ghost: HTMLElement | null = null;
    let pill: HTMLElement | null = null;
    let preview: HTMLElement | null = null;
    let hover: HTMLElement | null = null;
    let place: Date | null = null;
    let last = { x: startX, y: startY };
    let box: HTMLElement | null = null;
    let raf = 0;
    const hold = touch ? setTimeout(() => { active = true; haptic(14); begin(); }, 380) : null;

    const begin = () => {
      el.classList.add("dragging");
      document.documentElement.classList.add("cal-dragging");
      ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.remove("dragging");
      ghost.classList.add("cal-ghost");
      // a cópia sai do lugar dela (top/left da semana) e sem a animação de entrada do chip, que prenderia o transform
      Object.assign(ghost.style, { top: "0", left: "0", right: "auto", bottom: "auto", animation: "none", transition: "scale .16s ease-out, opacity .12s" });
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      ghost.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
      document.body.appendChild(ghost);
      // levanta do lugar com um leve aumento (só depois de estar na posição, para não saltar)
      requestAnimationFrame(() => ghost?.classList.add("lift"));
      pill = document.createElement("div");
      pill.className = "cal-drag-pill";
      pill.setAttribute("role", "status");
      document.body.appendChild(pill);
      box = scrollParent(el);
      update(last.x, last.y);
      raf = requestAnimationFrame(tick);
    };

    const target = (x: number, y: number) =>
      document.elementsFromPoint(x, y).find((n) => (n as HTMLElement).dataset?.drop) as HTMLElement | undefined;

    const placeAt = (t: HTMLElement, y: number) => {
      const d = dayOf(t.dataset.drop!);
      if (o.mode === "day") {
        d.setHours(start.getHours(), start.getMinutes(), 0, 0);
        return d;
      }
      // o topo do cartão (não o dedo) marca o horário: pegou no meio, continua pegando no meio
      const top = y - grabY - t.getBoundingClientRect().top;
      const min = Math.min(24 * 60 - 15, Math.max(first, Math.round((top / hourPx) * 4) * 15 + first));
      d.setHours(Math.floor(min / 60), min % 60, 0, 0);
      return d;
    };

    const label = (at: Date) => {
      if (at.getTime() === start.getTime()) return "Mesmo dia e horário";
      if (ev.allDay) return dia(at);
      return o.mode === "time" ? `${dia(at)} · ${hm(at)} a ${hm(new Date(at.getTime() + dur * 60000))}` : `${dia(at)} · ${hm(at)}`;
    };

    const showPreview = (t: HTMLElement, at: Date) => {
      if (!preview || preview.parentElement !== t) {
        preview?.remove();
        preview = document.createElement("div");
        preview.className = o.mode === "time" ? "cal-drop-preview" : "cal-drop-chip";
        preview.setAttribute("aria-hidden", "true");
        preview.innerHTML = `<span class="t"></span><small></small>`;
        preview.querySelector(".t")!.textContent = ev.title;
        if (o.mode === "time") preview.style.height = `${rect.height}px`;
        t.appendChild(preview);
      }
      const small = preview.querySelector("small")!;
      if (o.mode === "time") {
        preview.style.top = `${((at.getHours() * 60 + at.getMinutes() - first) * hourPx) / 60}px`;
        small.textContent = `${hm(at)} a ${hm(new Date(at.getTime() + dur * 60000))}`;
      } else small.textContent = ev.allDay ? "" : hm(at);
    };

    const update = (x: number, y: number) => {
      last = { x, y };
      if (ghost) ghost.style.transform = `translate(${x - grabX}px, ${y - grabY}px)`;
      const t = target(x, y) ?? null;
      if (t !== hover) {
        hover?.classList.remove("drop-hover");
        t?.classList.add("drop-hover");
        hover = t;
      }
      const at = t ? placeAt(t, y) : null;
      if (at?.getTime() !== place?.getTime()) {
        if (at && place) haptic(3);
        place = at;
        if (pill) pill.textContent = at ? label(at) : "Solte num dia";
        pill?.classList.toggle("same", Boolean(at && at.getTime() === start.getTime()));
      }
      if (t && at) showPreview(t, at);
      else {
        preview?.remove();
        preview = null;
      }
      // sobre um dia o cartão tracejado já é o lembrete no lugar novo; a cópia que segue o dedo some para não cobrir
      ghost?.classList.toggle("off", Boolean(t));
      if (pill) {
        const w = pill.offsetWidth;
        const px = touch ? Math.min(innerWidth - w - 8, Math.max(8, x - w / 2)) : Math.min(innerWidth - w - 8, x + 16);
        // no dedo a etiqueta fica acima dele (senão o dedo cobre); no mouse, logo abaixo do cursor
        const py = touch ? Math.max(8, y - 74) : y + 20;
        pill.style.transform = `translate(${px}px, ${py}px)`;
      }
    };

    // perto da borda de cima/baixo da lista, ela rola sozinha (mais rápido quanto mais perto)
    const tick = () => {
      if (box) {
        const r = box.getBoundingClientRect();
        const edge = 56;
        const over = last.y < r.top + edge ? last.y - (r.top + edge) : last.y > r.bottom - edge ? last.y - (r.bottom - edge) : 0;
        if (over) {
          box.scrollTop += Math.max(-18, Math.min(18, over * 0.4));
          update(last.x, last.y);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    const onMove = (m: PointerEvent) => {
      if (!active) {
        if (Math.hypot(m.clientX - startX, m.clientY - startY) > 8) {
          // dedo andou antes de segurar: é rolagem, não arrasto
          if (hold) { clearTimeout(hold); cleanup(); return; }
          active = true;
          begin();
        }
        return;
      }
      m.preventDefault();
      update(m.clientX, m.clientY);
    };

    const onUp = (u: PointerEvent) => {
      if (hold) clearTimeout(hold);
      if (!active) return cleanup();
      update(u.clientX, u.clientY);
      // o clique que vem junto com o soltar não abre o detalhe nem cria lembrete no lugar
      const stop = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener("click", stop, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 60);
      const at = place;
      if (!at || at.getTime() === start.getTime()) return cleanup();
      haptic(10);
      // fica o cartão tracejado no lugar novo até a agenda recarregar
      ghost?.remove();
      ghost = null;
      pill?.remove();
      pill = null;
      preview?.classList.add("settling");
      stopListening();
      void Promise.resolve(onDrop(ev, at)).finally(cleanup);
    };

    const onKey = (k: KeyboardEvent) => k.key === "Escape" && cleanup();
    // segurou e está arrastando: a página não rola e o toque longo não abre menu
    const block = (t: Event) => active && t.cancelable && t.preventDefault();

    const stopListening = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("touchmove", block);
      window.removeEventListener("contextmenu", block);
      window.removeEventListener("keydown", onKey);
    };
    const cleanup = () => {
      if (hold) clearTimeout(hold);
      stopListening();
      if (active) endedAt = Date.now();
      el.classList.remove("dragging");
      document.documentElement.classList.remove("cal-dragging");
      hover?.classList.remove("drop-hover");
      ghost?.remove();
      pill?.remove();
      preview?.remove();
    };

    window.addEventListener("touchmove", block, { passive: false });
    window.addEventListener("contextmenu", block);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("keydown", onKey);
  };
}
