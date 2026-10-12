export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  // o Mochi reage quando algo é salvo (trabalhando, pronto ou erro)
  const loud = !!rest.method && rest.method !== "GET" && !(rest.headers as Record<string, string> | undefined)?.["x-pj-quiet"];
  const mood = (phase: string) => loud && window.dispatchEvent(new CustomEvent("pj:api", { detail: { phase } }));
  mood("start");
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "include",
      ...rest,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (e) {
    mood("error");
    throw e;
  }
  mood(res.ok ? "ok" : "error");
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && !path.startsWith("/api/auth")) {
    window.dispatchEvent(new Event("pj:logout"));
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Erro ${res.status}`, res.status);
  return data as T;
}

/** Custo em dólar, igual ao OpenRouter (o valor já é o custo real que ele devolve em usage.cost). */
export const usd = (v: number | string | null | undefined) => {
  const n = Number(v ?? 0);
  const digits = n < 0.01 && n > 0 ? 5 : 2;
  return `US$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

/** Telefone com DDI para mostrar: 5519999999999 → +55 (19) 99999-9999. Fora do Brasil fica +número. */
export const phoneFmt = (v: string | null | undefined) => {
  const d = String(v ?? "").replace(/\D/g, "");
  if (!d) return "";
  const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : `+${d}`;
};

export const ms = (v: number | null | undefined) => {
  if (v == null) return "–";
  return v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`;
};

export const when = (iso: string | null | undefined) => {
  if (!iso) return "–";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

export const ago = (iso: string | null | undefined) => {
  if (!iso) return "–";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
};

export const brl = (v: number | string | null | undefined) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v ?? 0));

export const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–";
