export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    credentials: "include",
    ...rest,
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401 && !path.startsWith("/api/auth")) {
    window.dispatchEvent(new Event("pj:logout"));
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Erro ${res.status}`, res.status);
  return data as T;
}

export const usd = (v: number | string | null | undefined) => {
  const n = Number(v ?? 0);
  return n < 0.01 && n > 0 ? `$${n.toFixed(5)}` : `$${n.toFixed(2)}`;
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
