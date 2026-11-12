import { config } from "../../config.js";
import {
  createNote,
  deleteNote,
  findNote,
  getNote,
  insertUnderHeading,
  listNotes,
  noteHtmlToText,
  textToNoteHtml,
  UNTITLED,
  updateNote,
  type NoteRow,
} from "../../notes.js";
import { CONFIRM_PARAM, defineTool, obj, requireConfirmation, type ToolContext } from "./types.js";

/**
 * Anotações da pessoa (aba Anotações do painel, estilo Google Docs). A Zulmira escreve em texto com marcação leve e
 * o servidor monta o documento (notes.ts). Antes de mexer numa anotação, a versão anterior fica guardada no painel.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const link = (id: string) => `${config.PUBLIC_URL.replace(/\/$/, "")}/anotacoes/${id}`;

async function pick(ctx: ToolContext, noteId?: string, title?: string): Promise<NoteRow | null | undefined> {
  if (noteId && UUID.test(noteId)) return getNote(ctx.user.id, noteId);
  if (noteId && !title) title = noteId; // o modelo às vezes manda o nome no lugar do id
  return title ? findNote(ctx.user.id, title) : null;
}

export const noteList = defineTool<{ search?: string }>({
  name: "note_list",
  description: "Lista as anotações da pessoa (id, título, começo do texto), as mais novas primeiro. search filtra por palavra.",
  parameters: obj({ search: { type: "string" } }),
  async run(args, ctx) {
    const rows = await listNotes(ctx.user.id, String(args.search ?? "").trim());
    return {
      ok: true,
      notes: rows.slice(0, 25).map((r) => ({ id: r.id, title: r.title, updated: String(r.updated_at).slice(0, 10), start: r.preview.slice(0, 90) })),
      total: rows.length,
    };
  },
});

export const noteRead = defineTool<{ note_id?: string; title?: string }>({
  name: "note_read",
  description: "Lê uma anotação inteira (por note_id ou pelo título) em texto com a mesma marcação do note_write.",
  parameters: obj({ note_id: { type: "string" }, title: { type: "string" } }),
  async run(args, ctx) {
    const n = await pick(ctx, args.note_id, args.title);
    if (!n) return { ok: false, error: "Anotação não encontrada. Use note_list para ver os títulos." };
    const text = noteHtmlToText(n.html);
    return { ok: true, id: n.id, title: n.title || UNTITLED, text: text.slice(0, 8000), cut: text.length > 8000, link: link(n.id) };
  },
});

export const noteWrite = defineTool<{ note_id?: string; title?: string; content: string; mode?: "append" | "replace" | "new"; under?: string }>({
  name: "note_write",
  description:
    "Escreve numa anotação da pessoa (vira um documento no painel). content em texto: '# Título', '## Seção', '- tópico' (2 espaços antes = subtópico), " +
    "'1. passo', '[ ] tarefa', '[x] feita', '> destaque', *negrito*, _itálico_. Sem note_id/título que exista, cria uma nova. " +
    "mode: append (padrão: acrescenta no fim, ou dentro da seção under), replace (reescreve tudo, para reorganizar), new (cria outra mesmo com o mesmo nome).",
  parameters: obj(
    {
      note_id: { type: "string" },
      title: { type: "string", description: "nome da anotação (ex.: 'Lista de mercado', 'Ideias do casamento')" },
      content: { type: "string" },
      mode: { type: "string", enum: ["append", "replace", "new"] },
      under: { type: "string", description: "título da seção onde entra o conteúdo (append)" },
    },
    ["content"],
  ),
  async run(args, ctx) {
    const content = String(args.content ?? "").trim();
    if (!content) return { ok: false, error: "Conteúdo vazio." };
    if (content.length > 30000) return { ok: false, error: "Conteúdo grande demais para uma vez; divida em partes." };
    const mode = args.mode ?? "append";
    const html = textToNoteHtml(content);
    const existing = mode === "new" ? null : await pick(ctx, args.note_id, args.title);
    if (args.note_id && UUID.test(args.note_id) && !existing) return { ok: false, error: "Anotação não encontrada. Use note_list." };
    try {
      if (!existing) {
        const title = String(args.title ?? "").trim() || firstLine(content) || UNTITLED;
        const n = await createNote(ctx.user.id, { title, html }, "planejai");
        return { ok: true, created: true, id: n.id, title: n.title, link: link(n.id) };
      }
      let next: string;
      if (mode === "replace") next = html;
      else if (args.under?.trim()) next = insertUnderHeading(existing.html, args.under, html);
      else next = existing.html + html;
      const title = mode === "replace" && args.title?.trim() ? args.title : undefined;
      const r = await updateNote(ctx.user.id, existing.id, { html: next, title }, "planejai", mode === "replace" ? "antes de reescrever" : "antes de acrescentar");
      if (!r) return { ok: false, error: "Anotação não encontrada." };
      return { ok: true, updated: true, mode, id: existing.id, title: r.note.title || UNTITLED, link: link(existing.id) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
});

export const noteRename = defineTool<{ note_id?: string; title?: string; new_title: string }>({
  name: "note_rename",
  description: "Muda o título de uma anotação.",
  parameters: obj({ note_id: { type: "string" }, title: { type: "string" }, new_title: { type: "string" } }, ["new_title"]),
  async run(args, ctx) {
    const n = await pick(ctx, args.note_id, args.title);
    if (!n) return { ok: false, error: "Anotação não encontrada." };
    const r = await updateNote(ctx.user.id, n.id, { title: args.new_title }, "planejai", "antes de renomear");
    return r ? { ok: true, id: n.id, title: r.note.title, link: link(n.id) } : { ok: false, error: "Anotação não encontrada." };
  },
});

export const noteDelete = defineTool<{ note_id?: string; title?: string; confirmed_by_user?: boolean }>({
  name: "note_delete",
  description: 'Apaga uma anotação inteira. Pede o "sim" da pessoa (o sistema confirma sozinho).',
  parameters: obj({ note_id: { type: "string" }, title: { type: "string" }, ...CONFIRM_PARAM }),
  async run(args, ctx) {
    const n = await pick(ctx, args.note_id, args.title);
    if (!n) return { ok: false, error: "Anotação não encontrada." };
    const blocked = await requireConfirmation(args, `apagar a anotação "${n.title || UNTITLED}"`, ctx);
    if (blocked) return blocked;
    await deleteNote(ctx.user.id, n.id);
    return { ok: true, deleted: n.title || UNTITLED };
  },
});

function firstLine(content: string) {
  const l = content.split("\n").find((x) => x.trim()) ?? "";
  return l.replace(/^\s*(#+|[-*•]|\d+[.)]|\[[ xX]\]|>)\s*/, "").replace(/[*_~]/g, "").trim().slice(0, 80);
}

export const NOTE_TOOLS = [noteWrite, noteList, noteRead, noteRename, noteDelete];
