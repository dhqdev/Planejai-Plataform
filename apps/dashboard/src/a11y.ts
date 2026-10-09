/**
 * Acessibilidade de graça para as telas: o padrão do painel é <div class="field"><label>Nome</label><input/></div>,
 * sem htmlFor. Aqui cada rótulo assim é ligado ao campo dele (leitor de tela anuncia o nome; clicar no rótulo foca o campo).
 */
let seq = 0;

function linkFields(root: ParentNode) {
  for (const label of root.querySelectorAll<HTMLLabelElement>(".field > label:not([for])")) {
    // rótulo que já embrulha o campo (checkbox) não precisa
    if (label.querySelector("input, select, textarea")) continue;
    const field = label.parentElement?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea");
    if (!field) continue;
    if (!field.id) field.id = `pj-f${++seq}`;
    label.htmlFor = field.id;
  }
}

/**
 * Teclado para o que não é <button>/<a>:
 * - qualquer role="button" (div/span) ativa com Enter e Espaço, como um botão de verdade
 *   (quem já trata a tecla chama preventDefault e não dispara duas vezes);
 * - dentro de role="tablist", setas (esquerda/direita, cima/baixo), Home e End movem para a aba vizinha e a ativam.
 */
export function installKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    if ((e.key === "Enter" || e.key === " ") && t.getAttribute("role") === "button" && t.tagName !== "BUTTON" && t.tagName !== "A") {
      e.preventDefault();
      t.click();
      return;
    }

    if (t.getAttribute("role") !== "tab") return;
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const list = t.closest<HTMLElement>('[role="tablist"]');
    if (!list) return;
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')].filter(
      (x) => x.closest('[role="tablist"]') === list && !(x as HTMLButtonElement).disabled,
    );
    const at = tabs.indexOf(t);
    if (at < 0 || tabs.length < 2) return;
    let to: number;
    if (e.key === "Home") to = 0;
    else if (e.key === "End") to = tabs.length - 1;
    else to = (at + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + tabs.length) % tabs.length;
    e.preventDefault();
    tabs[to]!.focus();
    tabs[to]!.click();
  });
}

export function installFieldLabels() {
  linkFields(document);
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      linkFields(document);
    });
  }).observe(document.body, { childList: true, subtree: true });
}
