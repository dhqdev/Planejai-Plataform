/**
 * Tempo real: uma conexão só (SSE em /api/live) para o app inteiro. O servidor manda o nome das tabelas que mudaram
 * (nunca o dado) e quem se inscreveu nelas recarrega pela rota de sempre. Sem conexão (rede, proxy, deslogado),
 * `liveOn()` fica falso e as telas voltam ao polling normal. Com o app em segundo plano a conexão fecha depois de
 * um minuto e reabre ao voltar (as telas já recarregam ao voltar).
 */
type Listener = (tables: string[]) => void;

const listeners = new Set<Listener>();
const status = new Set<(on: boolean, again: boolean) => void>();
let source: EventSource | null = null;
let connected = false;
let ever = false;
let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
let wanted = false;

function setConnected(on: boolean) {
  if (connected === on) return;
  connected = on;
  // "again": voltou depois de cair; quem estava aberto recarrega (pode ter perdido aviso no meio)
  status.forEach((f) => f(on, on && ever));
  if (on) ever = true;
}

function open() {
  if (source || typeof EventSource === "undefined") return;
  const es = new EventSource("/api/live", { withCredentials: true });
  source = es;
  es.addEventListener("ready", () => setConnected(true));
  es.addEventListener("change", (e) => {
    let tables: string[] = [];
    try {
      tables = JSON.parse((e as MessageEvent<string>).data);
    } catch {
      return;
    }
    listeners.forEach((f) => f(tables));
  });
  es.onerror = () => {
    setConnected(false);
    // 401 (saiu) ou servidor sem a rota: o navegador desiste sozinho (CLOSED); aí tenta de novo mais tarde
    if (es.readyState === EventSource.CLOSED) {
      source = null;
      setTimeout(() => wanted && !document.hidden && open(), 30_000);
    }
  };
}

function close() {
  source?.close();
  source = null;
  setConnected(false);
}

function onVisibility() {
  clearTimeout(hiddenTimer);
  if (document.hidden) hiddenTimer = setTimeout(close, 60_000);
  else if (wanted) open();
}

/** Liga (logado) ou desliga (saiu) a conexão do app; trocar de conta reabre (o servidor filtra por conta). */
export function startLive(on: boolean) {
  wanted = on;
  document.removeEventListener("visibilitychange", onVisibility);
  close();
  ever = false;
  if (!on) return;
  document.addEventListener("visibilitychange", onVisibility);
  if (!document.hidden) open();
}

export function liveOn() {
  return connected;
}

export function onLiveStatus(f: (on: boolean, again: boolean) => void) {
  status.add(f);
  return () => void status.delete(f);
}

/** Chama `f` quando alguma das tabelas mudar (vários avisos seguidos viram uma chamada só). */
export function onLive(tables: readonly string[], f: () => void) {
  let t: ReturnType<typeof setTimeout> | undefined;
  const l: Listener = (changed) => {
    if (!changed.some((x) => tables.includes(x))) return;
    clearTimeout(t);
    t = setTimeout(f, 150);
  };
  listeners.add(l);
  return () => {
    clearTimeout(t);
    listeners.delete(l);
  };
}
