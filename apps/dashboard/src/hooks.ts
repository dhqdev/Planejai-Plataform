import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** Busca dados de uma rota da API, com recarga manual e polling opcional. */
export function useApi<T = any>(path: string | null, opts: { poll?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(true);
    void reload();
    if (!opts.poll) return;
    const t = setInterval(() => void reload(), opts.poll);
    return () => clearInterval(t);
  }, [reload, opts.poll]);

  return { data, error, loading, reload, setData };
}
