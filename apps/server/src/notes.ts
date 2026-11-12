import { many, one, query } from "./db/pool.js";

/**
 * Anotações: documentos de cada pessoa no estilo do Google Docs (aba Anotações no painel). A pessoa edita no
 * editor do painel; a Zulmira (agente "anotacoes") escreve pelo WhatsApp em texto simples com marcação leve
 * (# título, - tópico, [ ] tarefa, *negrito*), que vira HTML aqui. Todo HTML que entra passa por cleanNoteHtml,
 * uma lista fechada de tags e atributos, porque o painel mostra o conteúdo como HTML.
 */

export type NoteAuthor = "pessoa" | "planejai";
export const NOTE_MAX_HTML = 200_000;
export const NOTES_PER_PERSON = 300;
const VERSIONS_KEPT = 20;
export const UNTITLED = "Anotação sem título";

// ---------------------------------------------------------------- HTML limpo

/** Tags que ficam (as outras somem e o texto de dentro fica). b/i/strike viram strong/em/s. */
const KEEP: Record<string, string> = {
  p: "p", div: "p", h1: "h1", h2: "h2", h3: "h3", ul: "ul", ol: "ol", li: "li",
  strong: "strong", b: "strong", em: "em", i: "em", u: "u", s: "s", strike: "s", del: "s",
  br: "br", hr: "hr", blockquote: "blockquote", a: "a", mark: "mark",
};
const VOID = new Set(["br", "hr"]);
/** Tags cujo conteúdo inteiro some (código, estilo, objetos). */
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "textarea", "title", "head", "select", "button", "form", "video", "audio", "canvas"]);

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&amp;/g, "&");

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([a-zA-Z_:][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    out[m[1]!.toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return out;
}

/** Link só http(s) e mailto (nada de javascript:, data:, etc.). */
export function safeHref(href: string): string | null {
  const h = href.trim().replace(/[\u0000-\u001f\s]+/g, "");
  return /^(https?:\/\/|mailto:)/i.test(h) ? h : null;
}

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<[!?/][^>]*>|<|[^<]+/g;

/**
 * Limpa o HTML que vem do editor (ou de qualquer lugar): só tags da lista KEEP, atributos só os conhecidos
 * (href seguro no link, data-check na lista de tarefas, data-done no item feito). Texto continua escapado.
 */
export function cleanNoteHtml(html: string): string {
  let out = "";
  const dropping: string[] = [];
  for (const m of String(html ?? "").slice(0, NOTE_MAX_HTML * 2).matchAll(TOKEN)) {
    const tok = m[0];
    const name = m[1]?.toLowerCase();
    const closing = tok.startsWith("</");
    if (dropping.length) {
      if (name && DROP.has(name)) {
        if (closing && dropping[dropping.length - 1] === name) dropping.pop();
        else if (!closing && !/\/>$/.test(tok)) dropping.push(name);
      }
      continue;
    }
    if (!name) {
      if (tok === "<") out += "&lt;";
      else if (!tok.startsWith("<")) out += tok.replace(/>/g, "&gt;");
      continue; // comentário, doctype, CDATA, tag quebrada: some
    }
    if (DROP.has(name)) {
      if (!closing && !/\/>$/.test(tok)) dropping.push(name);
      continue;
    }
    const tag = KEEP[name];
    if (!tag) continue;
    if (closing) {
      if (!VOID.has(tag)) out += `</${tag}>`;
      continue;
    }
    const a = attrs(m[2] ?? "");
    let extra = "";
    if (tag === "a") {
      const href = safeHref(a.href ?? "");
      if (!href) continue; // link sem destino seguro: fica só o texto (o </a> que sobra o navegador ignora)
      extra = ` href="${escAttr(href)}" target="_blank" rel="noopener noreferrer"`;
    }
    if (tag === "ul" && a["data-check"] !== undefined) extra = ' data-check="1"';
    if (tag === "li" && (a["data-done"] === "1" || a["data-done"] === "true")) extra = ' data-done="1"';
    out += `<${tag}${extra}>`;
  }
  // um </a> de link recusado: tira só os fechamentos sobrando de <a>
  let opened = 0;
  out = out.replace(/<a [^>]*>|<\/a>/g, (t) => {
    if (t !== "</a>") return opened++, t;
    if (!opened) return "";
    opened--;
    return t;
  });
  return out.trim();
}

// ---------------------------------------------------------------- texto simples <-> HTML

/** Negrito, itálico, riscado e link dentro de uma linha (texto já sem HTML). */
function inline(text: string): string {
  const links: string[] = [];
  let s = text.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,800})\)/g, (all, t: string, u: string) => {
    const href = safeHref(u);
    if (!href) return all;
    links.push(`<a href="${escAttr(href)}" target="_blank" rel="noopener noreferrer">${escHtml(t)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  s = escHtml(s)
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(“"'])\*([^*\s][^*\n]*?)\*(?=$|[\s.,;:!?)”"'])/g, "$1<strong>$2</strong>")
    .replace(/(^|[\s(“"'])_([^_\s][^_\n]*?)_(?=$|[\s.,;:!?)”"'])/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+?)~~/g, "<s>$1</s>")
    .replace(/(^|[\s(])~([^~\s][^~\n]*?)~(?=$|[\s.,;:!?)])/g, "$1<s>$2</s>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)] ?? "");
}

/**
 * Texto do agente (ou do WhatsApp) para HTML do documento:
 * "# Título", "## Subtítulo", "### Seção"; "- item", "* item", "• item" e "1. item" (recuo de 2 espaços = subtópico);
 * "[ ] tarefa" e "[x] feita"; "> citação"; "---" linha; *negrito*, **negrito**, _itálico_, ~riscado~, [texto](link).
 */
export function textToNoteHtml(text: string): string {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "  ").split("\n");
  let out = "";
  // pilha de listas abertas: tipo e nível de recuo
  const stack: { tag: "ul" | "ol"; check: boolean; indent: number }[] = [];
  let liOpen = false;
  const closeTo = (indent: number) => {
    while (stack.length && stack[stack.length - 1]!.indent > indent) {
      out += `</li></${stack.pop()!.tag}>`;
    }
  };
  const closeAll = () => {
    closeTo(-1);
    liOpen = false;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const item = /^(\s*)([-*•◦▪]|\d{1,3}[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line) ?? /^(\s*)()\[( |x|X)\]\s+(.*)$/.exec(line);
    if (item && !/^\s*[-*_]{3,}\s*$/.test(line)) {
      const indent = Math.floor(item[1]!.length / 2);
      const ordered = /^\d/.test(item[2]!);
      const check = item[3] !== undefined;
      const tag = ordered ? "ol" : "ul";
      const top = stack[stack.length - 1];
      if (top && top.indent > indent) closeTo(indent);
      const cur = stack[stack.length - 1];
      if (!cur || cur.indent < indent) {
        // lista nova (ou subtópico dentro do item aberto)
        if (cur && !liOpen) out += "<li>";
        out += `<${tag}${check ? ' data-check="1"' : ""}>`;
        stack.push({ tag, check, indent: cur ? Math.max(indent, cur.indent + 1) : indent });
      } else {
        out += "</li>";
        if (cur.tag !== tag || cur.check !== check) {
          out += `</${cur.tag}><${tag}${check ? ' data-check="1"' : ""}>`;
          stack[stack.length - 1] = { tag, check, indent: cur.indent };
        }
      }
      out += `<li${item[3] && item[3] !== " " ? ' data-done="1"' : ""}>${inline(item[4]!)}`;
      liOpen = true;
      continue;
    }
    closeAll();
    if (!line.trim()) continue;
    const h = /^\s*(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out += `<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out += "<hr>";
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      out += `<blockquote>${inline(q[1]!)}</blockquote>`;
      continue;
    }
    // título "em negrito sozinho na linha" do WhatsApp (*Mercado*) vira subtítulo
    const bold = /^\s*\*([^*\n]{1,80})\*:?\s*$/.exec(line);
    if (bold) {
      out += `<h3>${inline(bold[1]!)}</h3>`;
      continue;
    }
    out += `<p>${inline(line.trim())}</p>`;
  }
  closeAll();
  return cleanNoteHtml(out);
}

/** HTML do documento para texto simples com a mesma marcação (o agente lê assim; gasta pouco token). */
export function noteHtmlToText(html: string): string {
  let out = "";
  const lists: { ordered: boolean; check: boolean; n: number }[] = [];
  let inline: string[] = [];
  let lineStart = "";
  let href = "";
  const flush = () => {
    const t = inline.join("").replace(/[  ]+/g, " ").trim();
    if (t || lineStart.trim().startsWith("[")) out += `${lineStart}${t}\n`;
    inline = [];
    lineStart = "";
  };
  for (const m of String(html ?? "").matchAll(TOKEN)) {
    const tok = m[0];
    const name = m[1]?.toLowerCase();
    if (!name) {
      if (!tok.startsWith("<")) inline.push(decode(tok).replace(/\n/g, " "));
      continue;
    }
    const closing = tok.startsWith("</");
    const a = closing ? {} : attrs(m[2] ?? "");
    switch (name) {
      case "h1":
      case "h2":
      case "h3":
        flush();
        if (!closing) lineStart = `${"#".repeat(Number(name[1]))} `;
        break;
      case "p":
      case "div":
      case "blockquote":
        flush();
        if (!closing && name === "blockquote") lineStart = "> ";
        break;
      case "br":
        flush();
        break;
      case "hr":
        flush();
        out += "---\n";
        break;
      case "ul":
      case "ol":
        flush();
        if (!closing) lists.push({ ordered: name === "ol", check: (a as Record<string, string>)["data-check"] !== undefined, n: 0 });
        else lists.pop();
        break;
      case "li": {
        flush();
        if (closing) break;
        const l = lists[lists.length - 1];
        const pad = "  ".repeat(Math.max(0, lists.length - 1));
        if (!l) lineStart = "- ";
        else if (l.check) lineStart = `${pad}[${(a as Record<string, string>)["data-done"] ? "x" : " "}] `;
        else if (l.ordered) lineStart = `${pad}${++l.n}. `;
        else lineStart = `${pad}- `;
        break;
      }
      case "strong":
      case "b":
        inline.push("*");
        break;
      case "em":
      case "i":
        inline.push("_");
        break;
      case "s":
      case "strike":
      case "del":
        inline.push("~");
        break;
      case "a":
        if (!closing) href = (a as Record<string, string>).href ?? "";
        else if (href) {
          inline.push(` (${href})`);
          href = "";
        }
        break;
    }
  }
  flush();
  return out.replace(/\*\*/g, "").replace(/__/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Resumo de uma linha para a lista (sem marcação). */
export function notePreview(html: string, max = 140) {
  return noteHtmlToText(html)
    .replace(/^#+ |^\s*(- |\d+\. |\[[ x]\] |> )/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Coloca `addition` logo depois da seção cujo título bate com `heading` (antes do próximo título do mesmo nível ou
 * maior). Sem a seção, cria o título no fim e põe o conteúdo embaixo.
 */
export function insertUnderHeading(html: string, heading: string, addition: string): string {
  const want = norm(heading);
  const re = /<h([1-3])>([\s\S]*?)<\/h\1>/g;
  let found: { level: number; end: number } | null = null;
  for (const m of html.matchAll(re)) {
    if (!found) {
      if (norm(noteHtmlToText(m[2]!)) === want) found = { level: Number(m[1]), end: m.index! + m[0].length };
      continue;
    }
    if (Number(m[1]) <= found.level) return html.slice(0, m.index!) + addition + html.slice(m.index!);
  }
  if (found) return html + addition;
  return `${html}<h2>${escHtml(heading.trim().slice(0, 120))}</h2>${addition}`;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[*_~#:]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// ---------------------------------------------------------------- banco

export interface NoteRow {
  id: string;
  title: string;
  html: string;
  pinned: boolean;
  updated_by: NoteAuthor;
  created_by: NoteAuthor;
  created_at: string;
  updated_at: string;
}

const cleanTitle = (t: unknown) => String(t ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

export async function listNotes(userId: string, q = "") {
  const rows = await many<NoteRow>(
    `SELECT id, title, html, pinned, updated_by, created_by, created_at, updated_at FROM notes
      WHERE user_id = $1 AND ($2 = '' OR title ILIKE '%' || $2 || '%' OR html ILIKE '%' || $2 || '%')
      ORDER BY pinned DESC, updated_at DESC LIMIT 400`,
    [userId, q.replace(/[%_\\]/g, "").slice(0, 80)],
  );
  return rows.map(({ html, ...r }) => ({ ...r, title: r.title || UNTITLED, preview: notePreview(html) }));
}

export async function getNote(userId: string, id: string) {
  return one<NoteRow>("SELECT id, title, html, pinned, updated_by, created_by, created_at, updated_at FROM notes WHERE user_id = $1 AND id = $2", [userId, id]);
}

/** Anotação pelo nome (igual, sem acento e maiúscula; senão a que contém o texto, a mais nova). */
export async function findNote(userId: string, title: string) {
  const want = norm(title);
  if (!want) return null;
  const rows = await many<{ id: string; title: string }>("SELECT id, title FROM notes WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 400", [userId]);
  const hit = rows.find((r) => norm(r.title) === want) ?? rows.find((r) => norm(r.title).includes(want) || (want.length >= 4 && want.includes(norm(r.title)) && norm(r.title).length >= 4));
  return hit ? getNote(userId, hit.id) : null;
}

export async function createNote(userId: string, data: { title?: string; html?: string }, by: NoteAuthor) {
  const count = await one<{ n: number }>("SELECT count(*)::int AS n FROM notes WHERE user_id = $1", [userId]);
  if ((count?.n ?? 0) >= NOTES_PER_PERSON) throw new Error(`Limite de ${NOTES_PER_PERSON} anotações. Apague alguma antes de criar outra.`);
  const html = cleanNoteHtml(data.html ?? "");
  if (html.length > NOTE_MAX_HTML) throw new Error("Anotação grande demais.");
  return (await one<NoteRow>(
    `INSERT INTO notes (user_id, title, html, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)
     RETURNING id, title, html, pinned, updated_by, created_by, created_at, updated_at`,
    [userId, cleanTitle(data.title), html, by],
  ))!;
}

async function saveVersion(note: NoteRow, reason: string) {
  if (!note.html && !note.title) return;
  await query("INSERT INTO note_versions (note_id, title, html, reason) VALUES ($1, $2, $3, $4)", [note.id, note.title, note.html, reason]);
  await query(
    `DELETE FROM note_versions WHERE note_id = $1 AND id NOT IN (SELECT id FROM note_versions WHERE note_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${VERSIONS_KEPT})`,
    [note.id],
  );
}

/**
 * Atualiza título/conteúdo. Quem escreve é o Planejai: guarda a versão anterior antes (a pessoa pode voltar).
 * `since` (painel): se o Planejai escreveu depois da versão que a pessoa abriu, devolve conflict sem gravar.
 */
export async function updateNote(
  userId: string,
  id: string,
  data: { title?: string; html?: string; pinned?: boolean; since?: string | null; force?: boolean },
  by: NoteAuthor,
  reason = "",
) {
  const cur = await getNote(userId, id);
  if (!cur) return null;
  if (by === "pessoa" && data.since && !data.force && cur.updated_by === "planejai" && new Date(cur.updated_at).getTime() > new Date(data.since).getTime() + 500) {
    return { conflict: true as const, note: cur };
  }
  const html = data.html !== undefined ? cleanNoteHtml(data.html) : cur.html;
  if (html.length > NOTE_MAX_HTML) throw new Error("Anotação grande demais.");
  const title = data.title !== undefined ? cleanTitle(data.title) : cur.title;
  if (by === "planejai" && (html !== cur.html || title !== cur.title)) await saveVersion(cur, reason || "antes do Planejai mexer");
  // a pessoa escolheu manter a dela por cima do que o Planejai tinha escrito: o texto dele fica nas versões
  if (by === "pessoa" && data.force && cur.updated_by === "planejai" && html !== cur.html) await saveVersion(cur, "o que o Planejai escreveu");
  const touched = html !== cur.html || title !== cur.title;
  const row = await one<NoteRow>(
    `UPDATE notes SET title = $3, html = $4, pinned = $5, updated_by = CASE WHEN $7 THEN $6 ELSE updated_by END, updated_at = CASE WHEN $7 THEN now() ELSE updated_at END
      WHERE user_id = $1 AND id = $2
      RETURNING id, title, html, pinned, updated_by, created_by, created_at, updated_at`,
    [userId, id, title, html, data.pinned ?? cur.pinned, by, touched],
  );
  return { conflict: false as const, note: row! };
}

export async function deleteNote(userId: string, id: string) {
  return ((await query("DELETE FROM notes WHERE user_id = $1 AND id = $2", [userId, id])).rowCount ?? 0) > 0;
}

export async function noteVersions(userId: string, id: string) {
  return many<{ id: string; title: string; reason: string; created_at: string; preview: string }>(
    `SELECT v.id::text, v.title, v.reason, v.created_at, left(v.html, 4000) AS preview FROM note_versions v JOIN notes n ON n.id = v.note_id
      WHERE n.user_id = $1 AND v.note_id = $2 ORDER BY v.created_at DESC, v.id DESC LIMIT ${VERSIONS_KEPT}`,
    [userId, id],
  ).then((rows) => rows.map((r) => ({ ...r, preview: notePreview(r.preview, 200) })));
}

export async function noteVersion(userId: string, id: string, versionId: string) {
  if (!/^\d{1,18}$/.test(versionId)) return null;
  return one<{ title: string; html: string }>(
    "SELECT v.title, v.html FROM note_versions v JOIN notes n ON n.id = v.note_id WHERE n.user_id = $1 AND v.note_id = $2 AND v.id = $3",
    [userId, id, versionId],
  );
}

/** Volta para uma versão; a atual vira versão também (dá para desfazer a volta). */
export async function restoreNoteVersion(userId: string, id: string, versionId: string) {
  const cur = await getNote(userId, id);
  const v = await noteVersion(userId, id, versionId);
  if (!cur || !v) return null;
  await saveVersion(cur, "antes de restaurar");
  return one<NoteRow>(
    `UPDATE notes SET title = $3, html = $4, updated_by = 'pessoa', updated_at = now() WHERE user_id = $1 AND id = $2
     RETURNING id, title, html, pinned, updated_by, created_by, created_at, updated_at`,
    [userId, id, v.title, v.html],
  );
}
