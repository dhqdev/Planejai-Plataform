import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * Cache em memória das respostas (stale-while-revalidate): ao voltar para uma tela ela aparece na hora
 * com o último dado e se atualiza por trás. Some ao trocar de conta.
 */
const cache = new Map<string, unknown>();
export function clearApiCache() {
  cache.clear();
}
/** Esquenta o cache de uma rota (ex.: telas que a pessoa mais abre), sem travar nada. */
export function prefetchApi(path: string) {
  if (cache.has(path)) return;
  api(path).then((d) => cache.set(path, d), () => {});
}

/** Puxar para atualizar: cada tela aberta recarrega e quem disparou espera todas terminarem. */
export function refreshAll(): Promise<void> {
  const waitFor: Promise<unknown>[] = [];
  window.dispatchEvent(new CustomEvent("pj:refresh", { detail: { waitFor } }));
  return Promise.allSettled(waitFor).then(() => undefined);
}

/** Busca dados de uma rota da API, com recarga manual e polling opcional. */
export function useApi<T = any>(path: string | null, opts: { poll?: number } = {}) {
  const [data, setDataState] = useState<T | null>(() => (path && cache.has(path) ? (cache.get(path) as T) : null));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !(path && cache.has(path)));
  const current = useRef(path);
  current.current = path;

  const setData = useCallback(
    (v: T | null | ((prev: T | null) => T | null)) => {
      setDataState((prev) => {
        const next = typeof v === "function" ? (v as (p: T | null) => T | null)(prev) : v;
        if (path && next != null) cache.set(path, next);
        return next;
      });
    },
    [path],
  );

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      cache.set(path, d);
      if (current.current === path) {
        setDataState(d);
        setError(null);
      }
    } catch (e) {
      if (current.current === path) setError((e as Error).message);
    } finally {
      if (current.current === path) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    // trocou de rota: mostra o que já está no cache (se tiver) enquanto busca de novo
    const hit = path && cache.has(path);
    setDataState(hit ? (cache.get(path!) as T) : null);
    setLoading(!hit);
    void reload();
    const onRefresh = (e: Event) => (e as CustomEvent<{ waitFor: Promise<unknown>[] }>).detail?.waitFor.push(reload());
    window.addEventListener("pj:refresh", onRefresh);
    const onVisible = () => {
      if (!document.hidden) void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    // não gasta bateria/dados com a aba ou o app em segundo plano; atualiza ao voltar
    const t = opts.poll
      ? setInterval(() => {
          if (!document.hidden) void reload();
        }, opts.poll)
      : undefined;
    return () => {
      if (t) clearInterval(t);
      window.removeEventListener("pj:refresh", onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, opts.poll, path]);

  return { data, error, loading, reload, setData };
}
