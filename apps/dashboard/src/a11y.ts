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
