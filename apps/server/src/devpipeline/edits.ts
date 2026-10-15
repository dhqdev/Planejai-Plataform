/**
 * Partes puras da esteira (sem banco nem rede): ler o JSON do modelo, conferir caminhos e aplicar trocas
 * de trecho nos arquivos. Ficam aqui para os testes cobrirem sem GitHub nem OpenRouter.
 */

/** Primeiro objeto JSON do texto do modelo (aceita cerca ```json e texto antes/depois). */
export function parseModelJson<T = any>(text: string | null | undefined): T | null {
  const s = String(text ?? "").trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : s;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** Nome do branch: esteira/<id>-<título curto sem acento>. */
export function branchName(id: number, title: string) {
  const slug = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `esteira/${id}-${slug || "chamado"}`;
}

/**
 * Onde a esteira pode escrever. Fica de fora o que pode quebrar produção sem passar pelo CI ou o que
 * as regras do projeto proíbem: workflows do GitHub, arquivos .env, lock do npm (só a ferramenta mexe)
 * e migração que já existe (cria-se uma nova, nunca se edita a aplicada).
 */
export function pathProblem(path: string, existing: Set<string>): string | null {
  if (!path || path.length > 300 || path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => p === ".." || p === "." || p === "")) return "caminho inválido";
  if (/^\.github\//.test(path)) return "workflows do GitHub ficam de fora da esteira";
  if (/(^|\/)\.env(\.|$)/.test(path) && !path.endsWith(".env.example")) return "arquivo .env fica de fora";
  if (/(^|\/)package-lock\.json$/.test(path)) return "package-lock.json só muda pelo npm";
  if (/\/db\/migrations\/[^/]+\.sql$/.test(path) && existing.has(path)) return "migração já aplicada não se edita: crie uma nova com o próximo número";
  return null;
}

export interface FileEdit {
  path: string;
  /** "edit": trocas de trecho; "create": arquivo novo inteiro; "delete": apagar */
  action: "edit" | "create" | "delete";
  edits?: { search: string; replace: string }[];
  content?: string;
}

/**
 * Aplica as trocas de trecho em cima do conteúdo atual. Cada `search` precisa aparecer exatamente uma vez
 * (senão a troca é ambígua ou o modelo inventou o trecho): o erro volta ao modelo para ele corrigir.
 */
export function applyEdit(current: string | null, edit: FileEdit): { content: string | null } | { error: string } {
  if (edit.action === "delete") return current == null ? { error: `${edit.path}: não existe para apagar` } : { content: null };
  if (edit.action === "create") {
    if (typeof edit.content !== "string") return { error: `${edit.path}: arquivo novo sem conteúdo` };
    return { content: edit.content };
  }
  if (current == null) return { error: `${edit.path}: arquivo não existe (use action "create")` };
  if (!edit.edits?.length) return { error: `${edit.path}: nenhuma troca` };
  let out = current;
  for (const [i, e] of edit.edits.entries()) {
    if (typeof e?.search !== "string" || typeof e?.replace !== "string" || !e.search) return { error: `${edit.path}: troca ${i + 1} sem search/replace` };
    const first = out.indexOf(e.search);
    if (first < 0) return { error: `${edit.path}: troca ${i + 1}: o trecho de "search" não existe no arquivo (copie igual, com espaços)` };
    if (out.indexOf(e.search, first + 1) >= 0) return { error: `${edit.path}: troca ${i + 1}: o trecho aparece mais de uma vez; inclua mais linhas para ficar único` };
    out = out.slice(0, first) + e.replace + out.slice(first + e.search.length);
  }
  return { content: out };
}

/** Diff simples por linhas (para o revisor e para o painel), sem dependência: mostra só os blocos mudados. */
export function lineDiff(path: string, before: string | null, after: string | null, context = 2): string {
  if (before === after) return "";
  if (before == null) return `+++ ${path} (novo)\n${(after ?? "").split("\n").map((l) => `+${l}`).join("\n")}`;
  if (after == null) return `--- ${path} (apagado)`;
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - context);
  const lines = [`@@ ${path} linha ${start + 1}`];
  for (let i = from; i < start; i++) lines.push(` ${a[i]}`);
  for (let i = start; i <= endA; i++) lines.push(`-${a[i]}`);
  for (let i = start; i <= endB; i++) lines.push(`+${b[i]}`);
  for (let i = endA + 1; i <= Math.min(a.length - 1, endA + context); i++) lines.push(` ${a[i]}`);
  return lines.join("\n");
}

/** Do log do GitHub Actions, só o que explica a falha: linhas de erro com um pouco de contexto, no máximo `max` caracteres. */
export function failureExcerpt(log: string, max = 8000): string {
  const lines = log.split("\n").map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/\u001b\[[0-9;]*m/g, ""));
  const hit = /(error|fail|✗|×|FAIL|Expected|Received|AssertionError|TS\d{4}|ERR!|Cannot find|is not assignable|not defined)/i;
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (hit.test(l)) for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 4); j++) keep.add(j);
  });
  const picked = [...keep].sort((x, y) => x - y).map((i) => lines[i]).join("\n");
  const text = picked || lines.slice(-120).join("\n");
  return text.length > max ? text.slice(-max) : text;
}
