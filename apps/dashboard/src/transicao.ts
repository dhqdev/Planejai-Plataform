import { UNSAFE_createBrowserHistory } from "react-router-dom";

/**
 * Troca de tela com View Transition (CSS em styles/transicao.css). O roteador recebe este histórico: quando o
 * endereço muda (link, navigate ou voltar do navegador), o aviso ao React roda dentro de
 * document.startViewTransition. O navegador tira uma foto da tela antiga, o React desenha a nova (com o código
 * dela já baixado, a antiga fica parada esperando) e as duas fotos animam juntas: a antiga sai enquanto a nova
 * entra, sem quadro vazio no meio. Fica de fora: só mudar ?/# (filtros), replace (redirecionar), "reduzir
 * movimento" e navegador sem a API (esse cai nas animações .route-* da tela nova).
 */
export const appHistory = UNSAFE_createBrowserHistory({ v5Compat: true });

type Vt = { finished: Promise<void> };
const doc = document as Document & { startViewTransition?: (cb: () => Promise<void>) => Vt };

let running = false;
let turn = 0;
let drawn: (() => void) | null = null;

/** A tela nova foi desenhada pelo App (useLayoutEffect): libera a foto da tela nova. */
export function screenDrawn() {
  drawn?.();
  drawn = null;
}

/** Esta troca está acontecendo dentro de uma View Transition (a tela nova não anima por conta própria). */
export const inViewTransition = () => running;

const listen = appHistory.listen.bind(appHistory);
appHistory.listen = (fn) => {
  let last = appHistory.location.pathname;
  return listen((update) => {
    const moved = update.location.pathname !== last;
    last = update.location.pathname;
    if (!moved || update.action === "REPLACE" || !doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return fn(update);
    const root = document.documentElement;
    // html.pj-vt: só enquanto roda o painel e a barra de baixo têm foto própria
    root.classList.add("pj-vt");
    const mine = ++turn;
    const t = doc.startViewTransition(
      () =>
        new Promise<void>((done) => {
          running = true;
          drawn?.();
          drawn = done;
          fn(update);
          // tela que demora para baixar não segura a troca: depois de 1,5 s a foto nova sai como estiver
          setTimeout(done, 1500);
        }),
    );
    // uma troca nova por cima da anterior: só a última desliga
    t.finished.finally(() => {
      if (mine !== turn) return;
      running = false;
      root.classList.remove("pj-vt");
    });
  });
};
