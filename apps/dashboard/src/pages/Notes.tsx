import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, day, when } from "../api";
import { ErrorBox, Modal } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { onLive } from "../live";
import { haptic } from "../touch";
import { Vazio } from "../Vazio";
import "../styles/anotacoes.css";

/**
 * Anotações: documentos de cada pessoa no estilo do Google Docs. A lista fica à esquerda (no celular, a tela
 * inicial) e o documento abre numa folha branca com barra de formatação. Salva sozinho; o que a Zulmira escreve
 * pelo WhatsApp chega na hora (aviso pj_live da tabela notes) e, se a pessoa estava editando, ela escolhe qual fica.
 */

interface NoteItem { id: string; title: string; preview: string; pinned: boolean; updated_by: "pessoa" | "planejai"; created_by: "pessoa" | "planejai"; updated_at: string }
interface Note { id: string; title: string; html: string; pinned: boolean; updated_by: "pessoa" | "planejai"; updated_at: string }
interface Version { id: string; title: string; reason: string; created_at: string; preview: string }

const UNTITLED = "Anotação sem título";
const isPhone = () => matchMedia("(max-width: 767px)").matches;

/** Modelos do documento vazio (como os atalhos "Ata da reunião" do Google Docs). */
const TEMPLATES: { label: string; icon: string; title: string; html: string }[] = [
  {
    label: "Lista de tarefas",
    icon: "check",
    title: "Lista de tarefas",
    html: '<h2>Para hoje</h2><ul data-check="1"><li></li></ul><h2>Depois</h2><ul data-check="1"><li></li></ul>',
  },
  {
    label: "Ata da reunião",
    icon: "users",
    title: "Ata da reunião",
    html: "<h2>Quem estava</h2><ul><li></li></ul><h2>O que foi falado</h2><ul><li></li></ul><h2>Decisões</h2><ul><li></li></ul><h2>Próximos passos</h2><ul data-check=\"1\"><li></li></ul>",
  },
  {
    label: "Ideias",
    icon: "sparkle",
    title: "Ideias",
    html: "<h2>Ideias</h2><ul><li></li></ul><h2>Para pesquisar</h2><ul><li></li></ul>",
  },
];

const STYLES: { tag: string; label: string }[] = [
  { tag: "p", label: "Texto normal" },
  { tag: "h1", label: "Título" },
  { tag: "h2", label: "Subtítulo" },
  { tag: "h3", label: "Título 3" },
  { tag: "blockquote", label: "Destaque" },
];

export function NotesPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const { data, error, reload, setData } = useApi<{ items: NoteItem[] }>(`/api/anotacoes`, { poll: 60000, live: ["notes"] });
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const all = data?.items ?? [];
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? all.filter((n) => `${n.title} ${n.preview}`.toLowerCase().includes(t)) : all;
  }, [all, q]);

  // notebook: sem id abre a mais recente (como o Docs abre o último documento)
  useEffect(() => {
    if (!id && all.length && !isPhone()) nav(`/anotacoes/${all[0]!.id}`, { replace: true });
  }, [id, all, nav]);

  const create = async (tpl?: (typeof TEMPLATES)[number]) => {
    if (creating) return;
    haptic(10);
    setCreating(true);
    setErr(null);
    try {
      const n = await api<Note>("/api/anotacoes", { method: "POST", json: { title: tpl?.title ?? "", html: tpl?.html ?? "" } });
      setData((d) => ({ items: [{ ...n, preview: "", created_by: "pessoa" }, ...(d?.items ?? [])] }));
      nav(`/anotacoes/${n.id}`, { state: { fresh: !tpl } });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  /** O editor avisa o que mudou (título, começo do texto) e a lista acompanha sem recarregar. */
  const patchItem = useCallback(
    (n: Partial<NoteItem> & { id: string }) => setData((d) => (d ? { items: d.items.map((x) => (x.id === n.id ? { ...x, ...n } : x)) } : d)),
    [setData],
  );

  useEffect(() => {
    const f = () => void reload();
    window.addEventListener("pj:notes-gone", f);
    return () => window.removeEventListener("pj:notes-gone", f);
  }, [reload]);

  const empty = data && !all.length && !id;
  return (
    <div className={`page fit notes-page ${id ? "has-doc" : ""}`}>
      <ErrorBox error={error ?? err} />
      {empty ? (
        <Vazio
          img="memorias"
          title="Suas anotações, do seu jeito"
          text="Listas, ideias, atas e passo a passo em documentos que você edita como no Google Docs. Peça no WhatsApp que a Zulmira escreve em tópicos e organiza para você."
          actions={[{ label: creating ? "Criando…" : "Nova anotação", icon: "plus", onClick: () => void create() }]}
          tip="Ou mande no WhatsApp: “anota em tópicos as ideias da festa”"
        />
      ) : (
        <div className="notes-shell">
          <aside className="notes-side" aria-label="Suas anotações">
            <div className="notes-side-top">
              <input className="input notes-search" placeholder="Buscar nas anotações" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar nas anotações" />
              <button className="btn btn-brand notes-new" disabled={creating} onClick={() => void create()} aria-label="Nova anotação">
                <Icon name="plus" size={16} /> <span>Nova</span>
              </button>
            </div>
            <div className="notes-list scroll-y">
              {items.map((n) => (
                <button key={n.id} className={`notes-item ${n.id === id ? "active" : ""}`} onClick={() => { haptic(4); nav(`/anotacoes/${n.id}`); }}>
                  <span className="notes-item-ico"><Icon name="file" size={17} /></span>
                  <span className="notes-item-text">
                    <strong>{n.title || UNTITLED}</strong>
                    <small>{n.preview || "Vazia"}</small>
                    <em>
                      {n.updated_by === "planejai" ? "Planejai escreveu " : ""}
                      {when(n.updated_at)}
                    </em>
                  </span>
                </button>
              ))}
              {!items.length && data && <p className="muted notes-none">Nada com “{q}”.</p>}
            </div>
          </aside>
          {id ? (
            <Editor key={id} id={id} onChange={patchItem} onGone={() => { void reload(); nav("/anotacoes", { replace: true }); }} />
          ) : (
            <div className="notes-doc notes-doc-empty hide-phone">
              <p className="muted">Escolha uma anotação ou crie uma nova.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- editor

type Save = "saved" | "saving" | "dirty" | "error";

function Editor({ id, onChange, onGone }: {
  id: string;
  onChange: (n: Partial<NoteItem> & { id: string }) => void;
  onGone: () => void;
}) {
  const location = useLocation();
  const ed = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState("");
  const [save, setSave] = useState<Save>("saved");
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Note | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [isEmpty, setIsEmpty] = useState(false);
  const [outline, setOutline] = useState<{ tag: string; text: string; i: number }[]>([]);
  const [state, setState] = useState<{ block: string; bold: boolean; italic: boolean; underline: boolean; strike: boolean; ul: boolean; ol: boolean; check: boolean }>({
    block: "p", bold: false, italic: false, underline: false, strike: false, ul: false, ol: false, check: false,
  });
  const [ask, setAsk] = useState<null | "delete" | "versions" | "link">(null);
  const since = useRef<string | null>(null);
  const dirty = useRef(false);
  const timer = useRef<number>(0);
  const titleRef = useRef("");
  const savedRange = useRef<Range | null>(null);

  const paint = (n: Note) => {
    if (ed.current) ed.current.innerHTML = n.html || "<p><br></p>";
    since.current = n.updated_at;
    titleRef.current = n.title;
    setTitle(n.title);
    refresh();
  };

  // abre a anotação
  useEffect(() => {
    let alive = true;
    api<Note>(`/api/anotacoes/${id}`)
      .then((n) => {
        if (!alive) return;
        setNote(n);
        paint(n);
        const st = location.state as { fresh?: boolean } | null;
        if (st?.fresh && !n.title) document.querySelector<HTMLInputElement>(".notes-title")?.focus();
      })
      .catch((e) => (e instanceof ApiError && e.status === 404 ? onGone() : setErr((e as Error).message)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // o Planejai escreveu (WhatsApp): sem edição pendente, entra na hora; com edição, o salvar mostra a escolha
  useEffect(
    () =>
      onLive(["notes"], async () => {
        if (dirty.current || !since.current) return;
        try {
          const n = await api<Note>(`/api/anotacoes/${id}`);
          if (dirty.current || n.updated_at === since.current) return;
          if (n.html !== ed.current?.innerHTML || n.title !== titleRef.current) {
            const y = ed.current?.closest(".notes-canvas")?.scrollTop ?? 0;
            setNote(n);
            paint(n);
            ed.current?.closest(".notes-canvas")?.scrollTo({ top: y });
            if (n.updated_by === "planejai") setFresh("O Planejai acabou de escrever nesta anotação.");
          } else since.current = n.updated_at;
        } catch {
          /* tenta no próximo aviso */
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id],
  );

  useEffect(() => {
    if (!fresh) return;
    const t = window.setTimeout(() => setFresh(null), 6000);
    return () => clearTimeout(t);
  }, [fresh]);

  const doSave = useCallback(
    async (force = false) => {
      if (!ed.current) return;
      clearTimeout(timer.current);
      const html = ed.current.innerHTML;
      const t = titleRef.current;
      setSave("saving");
      try {
        const n = await api<Note>(`/api/anotacoes/${id}`, { method: "PATCH", json: { html, title: t, since: since.current, force }, headers: { "x-pj-quiet": "1" } });
        since.current = n.updated_at;
        // escreveu de novo enquanto salvava: continua sujo
        if (ed.current.innerHTML === html && titleRef.current === t) {
          dirty.current = false;
          setSave("saved");
        } else schedule();
        onChange({ id, title: n.title, preview: (ed.current.innerText || "").replace(/\s+/g, " ").trim().slice(0, 140), updated_at: n.updated_at, updated_by: "pessoa" });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const cur = await api<Note>(`/api/anotacoes/${id}`).catch(() => null);
          setConflict(cur);
          setSave("dirty");
          return;
        }
        setSave("error");
        setErr((e as Error).message);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, onChange],
  );

  const schedule = () => {
    dirty.current = true;
    setSave("dirty");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void doSave(), 900);
  };

  // sai da tela, troca de anotação ou fecha a aba: salva o que falta
  useEffect(() => {
    const flush = () => {
      if (!dirty.current || !ed.current) return;
      const body = JSON.stringify({ html: ed.current.innerHTML, title: titleRef.current, since: since.current });
      fetch(`/api/anotacoes/${id}`, { method: "PATCH", credentials: "include", keepalive: true, headers: { "Content-Type": "application/json" }, body }).catch(() => {});
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      clearTimeout(timer.current);
      // criou e saiu sem escrever nada: não deixa "Anotação sem título" vazia na lista
      const el = ed.current;
      if (el && !titleRef.current.trim() && !el.innerText.trim() && !el.querySelector("li, hr")) {
        dirty.current = false;
        fetch(`/api/anotacoes/${id}`, { method: "DELETE", credentials: "include", keepalive: true }).then(() => window.dispatchEvent(new Event("pj:notes-gone")), () => {});
        return;
      }
      flush();
    };
  }, [id]);

  /** Estado da barra (negrito ligado, estilo do parágrafo) e tópicos do documento. */
  const refresh = () => {
    const el = ed.current;
    if (!el) return;
    setIsEmpty(!el.innerText.trim() && !el.querySelector("li, h1, h2, h3, hr"));
    setOutline([...el.querySelectorAll("h1, h2, h3")].map((h, i) => ({ tag: h.tagName.toLowerCase(), text: (h.textContent ?? "").trim(), i })).filter((h) => h.text));
    readState();
  };

  const readState = () => {
    const el = ed.current;
    const sel = document.getSelection();
    if (!el || !sel?.rangeCount || !el.contains(sel.anchorNode)) return;
    const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    const block = node?.closest("h1, h2, h3, blockquote, p, li");
    const list = node?.closest("ul, ol");
    const q = (c: string) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    setState({
      block: block && block.tagName !== "LI" ? block.tagName.toLowerCase() : "p",
      bold: q("bold"),
      italic: q("italic"),
      underline: q("underline"),
      strike: q("strikeThrough"),
      ul: list?.tagName === "UL" && !list.hasAttribute("data-check"),
      ol: list?.tagName === "OL",
      check: !!list?.hasAttribute("data-check"),
    });
  };

  useEffect(() => {
    const f = () => readState();
    document.addEventListener("selectionchange", f);
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch {
      /* navegador antigo */
    }
    return () => document.removeEventListener("selectionchange", f);
  }, []);

  const cmd = (c: string, v?: string) => {
    ed.current?.focus();
    document.execCommand(c, false, v);
    afterEdit();
  };
  const afterEdit = () => {
    tidy();
    schedule();
    refresh();
  };

  /** Lista de tarefas: liga/desliga o data-check na lista onde está o cursor (cria a lista se precisar). */
  const toggleCheck = () => {
    ed.current?.focus();
    const sel = document.getSelection();
    const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
    let list = node?.closest("ul, ol");
    if (list && list.hasAttribute("data-check")) {
      list.removeAttribute("data-check");
      return afterEdit();
    }
    if (!list || list.tagName === "OL") {
      if (list?.tagName === "OL") document.execCommand("insertOrderedList");
      document.execCommand("insertUnorderedList");
      const n2 = document.getSelection()?.anchorNode;
      list = (n2 instanceof Element ? n2 : n2?.parentElement)?.closest("ul") ?? null;
    }
    list?.setAttribute("data-check", "1");
    afterEdit();
  };

  /** O Chrome às vezes põe <span style> e <font>; o servidor limpa, mas tiramos já para a tela ficar igual ao salvo. */
  const tidy = () => {
    const el = ed.current;
    if (!el) return;
    el.querySelectorAll("span[style], font").forEach((s) => s.replaceWith(...s.childNodes));
    el.querySelectorAll("[style]").forEach((s) => s.removeAttribute("style"));
  };

  const setBlock = (tag: string) => {
    haptic(4);
    cmd("formatBlock", `<${tag}>`);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const sel = document.getSelection();
    const node = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
    // Tab dentro da lista: vira subtópico (Shift+Tab volta)
    if (e.key === "Tab" && node?.closest("li")) {
      e.preventDefault();
      cmd(e.shiftKey ? "outdent" : "indent");
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openLink();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void doSave();
      return;
    }
    // atalhos de digitação como no Docs: "- " vira tópico, "1. " lista numerada, "# " título, "[] " tarefa
    if (e.key === " " && sel?.isCollapsed && node && !node.closest("li")) {
      const block = node.closest("p, div, h1, h2, h3") ?? null;
      if (!block || block === ed.current) return;
      const before = (block.textContent ?? "").slice(0, sel.anchorOffset);
      if (sel.anchorNode !== block.firstChild && sel.anchorNode !== block) return;
      const map: Record<string, () => void> = {
        "-": () => cmd("insertUnorderedList"),
        "*": () => cmd("insertUnorderedList"),
        "1.": () => cmd("insertOrderedList"),
        "#": () => cmd("formatBlock", "<h1>"),
        "##": () => cmd("formatBlock", "<h2>"),
        "###": () => cmd("formatBlock", "<h3>"),
        ">": () => cmd("formatBlock", "<blockquote>"),
        "[]": toggleCheck,
      };
      const go = map[before];
      if (!go) return;
      e.preventDefault();
      const r = document.createRange();
      r.setStart(sel.anchorNode!, 0);
      r.setEnd(sel.anchorNode!, sel.anchorOffset);
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand("delete");
      go();
    }
  };

  // marcar tarefa: toque na caixinha à esquerda do item
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const li = (e.target as Element).closest?.("ul[data-check] > li");
    if (!li || e.target !== li) return;
    const box = li.getBoundingClientRect();
    if (e.clientX - box.left > 30) return;
    e.preventDefault();
    haptic(6);
    if (li.hasAttribute("data-done")) li.removeAttribute("data-done");
    else li.setAttribute("data-done", "1");
    afterEdit();
  };

  // colar: só texto com quebras (o HTML de outro site traz estilos que não combinam com o documento)
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html && !text) return;
    e.preventDefault();
    if (html) {
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      tmp.querySelectorAll("script, style, meta, link, img, svg, iframe").forEach((x) => x.remove());
      tmp.querySelectorAll("*").forEach((x) => {
        for (const a of [...x.attributes]) if (!(x.tagName === "A" && a.name === "href")) x.removeAttribute(a.name);
      });
      document.execCommand("insertHTML", false, tmp.innerHTML);
    } else document.execCommand("insertText", false, text);
    afterEdit();
  };

  const openLink = () => {
    const sel = document.getSelection();
    savedRange.current = sel?.rangeCount && ed.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    setAsk("link");
  };

  const applyLink = (url: string, text: string) => {
    const href = /^(https?:\/\/|mailto:)/i.test(url) ? url : `https://${url}`;
    ed.current?.focus();
    const sel = document.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    if (sel && !sel.isCollapsed) document.execCommand("createLink", false, href);
    else {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = text || href;
      document.execCommand("insertHTML", false, a.outerHTML + "&nbsp;");
    }
    afterEdit();
  };

  // links abrem com Ctrl/Cmd+clique (como no Docs); no celular, toque longo
  const onAuxLink = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element).closest?.("a");
    if (a && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      window.open(a.getAttribute("href") ?? "", "_blank", "noopener");
    }
  };

  const applyTemplate = (t: (typeof TEMPLATES)[number]) => {
    if (!ed.current) return;
    haptic(8);
    if (!titleRef.current) {
      titleRef.current = t.title;
      setTitle(t.title);
    }
    ed.current.innerHTML = t.html;
    ed.current.focus();
    const first = ed.current.querySelector("li");
    if (first) {
      const r = document.createRange();
      r.setStart(first, 0);
      r.collapse(true);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
    }
    afterEdit();
  };

  const status = save === "saving" ? "Salvando…" : save === "dirty" ? "Alterações não salvas" : save === "error" ? "Não salvou" : "Salvo";

  return (
    <section className="notes-doc" aria-label="Documento">
      <header className="notes-head">
        <span className="notes-doc-ico hide-phone"><Icon name="file" size={22} /></span>
        <div className="notes-head-text">
          <input
            className="notes-title"
            value={title}
            placeholder={UNTITLED}
            aria-label="Título da anotação"
            onChange={(e) => {
              titleRef.current = e.target.value;
              setTitle(e.target.value);
              schedule();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ed.current?.focus();
              }
            }}
          />
          <span className={`notes-status ${save}`} aria-live="polite">
            {save === "saved" ? <Icon name="check" size={13} /> : null} {status}
            {note?.updated_by === "planejai" && save === "saved" ? <span className="hide-phone"> · última edição pelo Planejai</span> : null}
          </span>
        </div>
        <div className="notes-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => { haptic(4); setAsk("versions"); }} title="Versões anteriores">
            <Icon name="clock" size={15} /> <span className="hide-phone">Versões</span>
          </button>
          <button className="btn btn-ghost btn-sm hide-phone" onClick={() => window.print()} title="Imprimir ou salvar em PDF">
            <Icon name="download" size={15} /> <span>PDF</span>
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => { haptic(4); setAsk("delete"); }} title="Apagar anotação" aria-label="Apagar anotação">
            <Icon name="trash" size={15} />
          </button>
        </div>
      </header>

      <div className="notes-toolbar" role="toolbar" aria-label="Formatação" onMouseDown={(e) => (e.target as Element).closest("button") && e.preventDefault()}>
        <Tb label="Desfazer" onClick={() => cmd("undo")}><Svg d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></Tb>
        <Tb label="Refazer" onClick={() => cmd("redo")}><Svg d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></Tb>
        <span className="notes-sep" />
        <select className="notes-style" value={state.block} onChange={(e) => setBlock(e.target.value)} aria-label="Estilo do parágrafo">
          {STYLES.map((s) => <option key={s.tag} value={s.tag}>{s.label}</option>)}
        </select>
        <span className="notes-sep" />
        <Tb label="Negrito (Ctrl+B)" on={state.bold} onClick={() => cmd("bold")}><b className="tb-letter">B</b></Tb>
        <Tb label="Itálico (Ctrl+I)" on={state.italic} onClick={() => cmd("italic")}><i className="tb-letter serif">I</i></Tb>
        <Tb label="Sublinhado (Ctrl+U)" on={state.underline} onClick={() => cmd("underline")}><u className="tb-letter">U</u></Tb>
        <Tb label="Riscado" on={state.strike} onClick={() => cmd("strikeThrough")}><s className="tb-letter">S</s></Tb>
        <Tb label="Link (Ctrl+K)" onClick={openLink}><Icon name="link" size={17} /></Tb>
        <span className="notes-sep" />
        <Tb label="Tópicos" on={state.ul} onClick={() => cmd("insertUnorderedList")}><Svg d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" w={2.4} /></Tb>
        <Tb label="Lista numerada" on={state.ol} onClick={() => cmd("insertOrderedList")}><Svg d="M10 6h10M10 12h10M10 18h10M4 4.5h1.5V9M4 9h3M4 14.5c.4-.6 1-1 1.7-1 .9 0 1.5.6 1.5 1.3 0 1.2-3.2 2.2-3.2 3.7h3.3" /></Tb>
        <Tb label="Lista de tarefas" on={state.check} onClick={toggleCheck}><Svg d="M10 7h10M10 17h10M3.5 5.5h3.5v3.5H3.5zM3.5 15.5l1.5 1.5 2.5-3" /></Tb>
        <Tb label="Diminuir recuo (Shift+Tab)" onClick={() => cmd("outdent")}><Svg d="M11 6h9M11 12h9M4 18h16M4 6h3M7 9.5 4 12l3 2.5" /></Tb>
        <Tb label="Aumentar recuo (Tab)" onClick={() => cmd("indent")}><Svg d="M11 6h9M11 12h9M4 18h16M4 9.5 7 12l-3 2.5" /></Tb>
        <span className="notes-sep" />
        <Tb label="Linha" onClick={() => cmd("insertHorizontalRule")}><Svg d="M4 12h16" /></Tb>
        <Tb label="Limpar formatação" onClick={() => { cmd("removeFormat"); cmd("formatBlock", "<p>"); }}><Svg d="M6 5h12M12 5l-3 14M15 13l5 5M20 13l-5 5" /></Tb>
      </div>

      {fresh && <div className="notes-flash" role="status"><Icon name="sparkle" size={14} /> {fresh}</div>}
      {conflict && (
        <div className="notes-conflict" role="alert">
          <span>O Planejai escreveu nesta anotação enquanto você editava. Qual versão fica?</span>
          <div>
            <button className="btn btn-sm" onClick={() => { haptic(6); setConflict(null); dirty.current = false; setNote(conflict); paint(conflict); setSave("saved"); }}>Ver a do Planejai</button>
            <button className="btn btn-sm btn-primary" onClick={() => { haptic(6); setConflict(null); void doSave(true); }}>Manter a minha</button>
          </div>
        </div>
      )}
      <ErrorBox error={err} />

      <div className="notes-canvas">
        {outline.length > 0 && (
          <nav className="notes-outline" aria-label="Tópicos do documento">
            <h4>Tópicos do documento</h4>
            {outline.map((h) => (
              <button
                key={h.i}
                className={`notes-outline-${h.tag}`}
                onClick={() => ed.current?.querySelectorAll("h1, h2, h3")[h.i]?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                {h.text}
              </button>
            ))}
          </nav>
        )}
        <div className="notes-paper">
          <div
            ref={ed}
            className="notes-editor"
            contentEditable={!!note}
            suppressContentEditableWarning
            spellCheck
            role="textbox"
            aria-multiline="true"
            aria-label="Texto da anotação"
            onInput={() => { tidy(); schedule(); refresh(); }}
            onKeyDown={onKeyDown}
            onKeyUp={readState}
            onMouseUp={readState}
            onClick={(e) => { onClick(e); onAuxLink(e); }}
            onPaste={onPaste}
          />
          {note && isEmpty && (
            <div className="notes-templates">
              <span className="muted">Começar com</span>
              {TEMPLATES.map((t) => (
                <button key={t.label} className="notes-chip" onClick={() => applyTemplate(t)}>
                  <Icon name={t.icon} size={15} /> {t.label}
                </button>
              ))}
            </div>
          )}
          {!note && !err && <div className="notes-loading"><span /><span /><span /></div>}
        </div>
      </div>

      {ask === "delete" && note && (
        <Modal
          title="Apagar anotação"
          alert
          onClose={() => setAsk(null)}
          footer={(close) => (
            <>
              <button className="btn" onClick={close}>Cancelar</button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  haptic(12);
                  dirty.current = false;
                  await api(`/api/anotacoes/${id}`, { method: "DELETE" }).catch((e) => setErr((e as Error).message));
                  setAsk(null);
                  onGone();
                }}
              >
                Apagar
              </button>
            </>
          )}
        >
          <p>“{title || UNTITLED}” some de vez, do painel e do assistente.</p>
        </Modal>
      )}
      {ask === "versions" && (
        <Versions
          id={id}
          onClose={() => setAsk(null)}
          onRestored={(n) => {
            dirty.current = false;
            setNote(n);
            paint(n);
            setSave("saved");
            onChange({ id, title: n.title, updated_at: n.updated_at, updated_by: "pessoa" });
          }}
          beforeRestore={() => (dirty.current ? doSave(true) : Promise.resolve())}
        />
      )}
      {ask === "link" && <LinkModal initialText={savedRange.current?.toString() ?? ""} onClose={() => setAsk(null)} onSave={applyLink} />}
    </section>
  );
}

function Tb({ label, on, onClick, children }: { label: string; on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`notes-tb ${on ? "on" : ""}`} title={label} aria-label={label} aria-pressed={on ?? undefined} onClick={() => { haptic(3); onClick(); }}>
      {children}
    </button>
  );
}

function Svg({ d, w = 1.8 }: { d: string; w?: number }) {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function LinkModal({ initialText, onClose, onSave }: { initialText: string; onClose: () => void; onSave: (url: string, text: string) => void }) {
  const [url, setUrl] = useState("");
  const [text, setText] = useState(initialText);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const t = window.setTimeout(() => input.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  const ok = /\S+\.\S+|^mailto:/i.test(url.trim());
  return (
    <Modal
      title="Inserir link"
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="btn" onClick={close}>Cancelar</button>
          <button className="btn btn-brand" disabled={!ok} onClick={() => { onSave(url.trim(), text.trim()); close(); }}>Aplicar</button>
        </>
      )}
    >
      <div className="notes-link-form">
        {!initialText && (
          <label>
            <span className="label-sm">Texto</span>
            <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="O que aparece no documento" />
          </label>
        )}
        <label>
          <span className="label-sm">Endereço</span>
          <input ref={input} className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" onKeyDown={(e) => e.key === "Enter" && ok && (onSave(url.trim(), text.trim()), onClose())} />
        </label>
      </div>
    </Modal>
  );
}

function Versions({ id, onClose, onRestored, beforeRestore }: { id: string; onClose: () => void; onRestored: (n: Note) => void; beforeRestore: () => Promise<void> }) {
  const { data, error } = useApi<{ items: Version[] }>(`/api/anotacoes/${id}/versoes`);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Modal title="Versões anteriores" onClose={onClose} wide>
      {(close) => (
        <div className="notes-versions">
          <p className="muted">Antes de o Planejai mexer numa anotação, a versão anterior fica guardada aqui. Restaurar não apaga a atual: ela vira uma versão também.</p>
          <ErrorBox error={error ?? err} />
          {data && !data.items.length && <p className="muted notes-none">Nenhuma versão anterior ainda.</p>}
          {data?.items.map((v) => (
            <div key={v.id} className="notes-version">
              <div>
                <strong>{day(v.created_at)} · {new Date(v.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</strong>
                <small>{reasonLabel(v.reason)}{v.title ? ` · ${v.title}` : ""}</small>
                <p>{v.preview || "Vazia"}</p>
              </div>
              <button
                className="btn btn-sm"
                disabled={!!busy}
                onClick={async () => {
                  haptic(8);
                  setBusy(v.id);
                  try {
                    await beforeRestore();
                    const n = await api<Note>(`/api/anotacoes/${id}/versoes/${v.id}/restaurar`, { method: "POST" });
                    onRestored(n);
                    close();
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === v.id ? "Restaurando…" : "Restaurar"}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

const reasonLabel = (r: string) =>
  ({
    "antes de acrescentar": "Antes do Planejai acrescentar",
    "antes de reescrever": "Antes do Planejai reorganizar",
    "antes de renomear": "Antes do Planejai renomear",
    "antes de restaurar": "Antes de restaurar",
    "o que o Planejai escreveu": "O que o Planejai tinha escrito",
  })[r] ?? "Versão guardada";
