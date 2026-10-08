import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { haptic } from "../../touch";

/* Filtros da lista de Execuções: o que a pessoa escolheu, a URL em dia e a consulta para a API. */

export const PERIODS: [string, string][] = [["", "Todo período"], ["1", "Última hora"], ["24", "Últimas 24 h"], ["168", "Últimos 7 dias"], ["720", "Últimos 30 dias"]];
export const STATUSES: [string, string][] = [["", "Todos"], ["success", "OK"], ["partial", "Parcial"], ["error", "Erro"], ["running", "Rodando"]];

export interface Filters { status: string; user: string; agent: string; since: string; trigger: string; search: string }

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useExecutionFilters() {
  const [params, setParams] = useSearchParams();
  const conversation = params.get("conversation");
  const [f, setF] = useState<Filters>(() => ({
    status: params.get("status") ?? "",
    user: params.get("user") ?? "",
    agent: params.get("agent") ?? "",
    since: params.get("since") ?? "",
    trigger: params.get("trigger") ?? "",
    search: params.get("q") ?? "",
  }));
  const { status, user, agent, since, trigger } = f;
  const q = useDebounced(f.search.trim());
  /** Só o que está preenchido entra (na URL do painel e na consulta à API, na mesma ordem). */
  const fill = (target: URLSearchParams) => {
    for (const [k, v] of Object.entries({ status, user, agent, since, trigger, q, conversation: conversation ?? "" })) if (v) target.set(k, v);
    return target;
  };

  // os filtros ficam na URL: voltar do detalhe mantém a mesma lista
  useEffect(() => {
    const next = fill(new URLSearchParams());
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
  }, [status, user, agent, since, trigger, q, conversation, params, setParams]);

  return {
    ...f,
    conversation,
    /** Algum filtro ligado (a busca conta depois da pausa na digitação). */
    active: Boolean(status || user || agent || since || trigger || q || conversation),
    set: (key: keyof Filters, value: string) => setF((p) => (p[key] === value ? p : { ...p, [key]: value })),
    clear: () => {
      haptic(6);
      setF({ status: "", user: "", agent: "", since: "", trigger: "", search: "" });
      if (conversation) setParams(new URLSearchParams(), { replace: true });
    },
    /** Query string para /api/executions. */
    query: (limit: number) => fill(new URLSearchParams({ limit: String(limit) })).toString(),
  };
}
