import { useRef, useState } from "react";
import { api, brl } from "../api";
import { ErrorBox, Modal } from "../components";
import { Icon } from "../icons";
import { SelectField } from "../pickers";
import { haptic } from "../touch";
import { useCategories } from "./FinanceCategories";

type Row = {
  ref: string;
  date: string;
  kind: "expense" | "income";
  amount: number;
  description: string;
  merchant: string | null;
  category: string;
  how: string;
  imported: boolean;
  similar: { id: string; description: string; date: string } | null;
  skip: string | null;
};
type NewCat = { name: string; kind: string; color: string; keywords?: string[] };
type Preview = {
  bank: string | null;
  account: string | null;
  credit_card: boolean;
  start: string | null;
  end: string | null;
  totals: { expenses: number; income: number; count: number; imported: number };
  suggested: NewCat[];
  cards: { id: string; name: string; color: string; last4: string | null }[];
  rows: Row[];
};

const PALETTE = ["#FF7A1A", "#FF4458", "#E23382", "#B830C8", "#8B2BE2", "#5B45E8", "#2F7BEA", "#16A3A3", "#2E9E5B", "#C9A227", "#8D6E63", "#9AA0A6"];
const MON = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const day = (d: string) => `${Number(d.slice(8))} ${MON[Number(d.slice(5, 7)) - 1]}`;
const plain = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
const keyOf = (r: Row) => plain(r.merchant ?? r.description).replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();

/** Arquivo para base64 em pedaços (um extrato de 3 MB estoura a pilha do String.fromCharCode de uma vez). */
async function toBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Importar extrato OFX (server/src/ofx-import.ts): escolhe o arquivo, confere a prévia com a categoria de cada
 * linha já sugerida (o que ela já corrigiu, palavras, histórico e regras, sem IA), troca o que quiser, aceita
 * as categorias novas e importa. Repetido (mesmo arquivo de novo) nunca entra duas vezes.
 */
export function ImportModal({ onClose }: { onClose: (month: string | null) => void }) {
  const categories = useCategories();
  const input = useRef<HTMLInputElement>(null);
  const file = useRef<string>("");
  const [stage, setStage] = useState<"pick" | "reading" | "review" | "saving" | "done">("pick");
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [p, setP] = useState<Preview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<NewCat[]>([]);
  const [card, setCard] = useState("");
  const [filter, setFilter] = useState<"all" | "check" | "off">("all");
  const [picking, setPicking] = useState<Row | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; created: string[] } | null>(null);

  const read = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    if (!/\.ofx$/i.test(f.name) && !/ofx/i.test(f.type)) return setError("Escolha o arquivo .ofx que o banco exporta.");
    if (f.size > 3 * 1024 * 1024) return setError("Arquivo grande demais (até 3 MB). Exporte um período menor no banco.");
    setStage("reading");
    try {
      file.current = await toBase64(f);
      const r = await api<Preview>("/api/finance/ofx/preview", { method: "POST", json: { file: file.current }, headers: { "x-pj-quiet": "1" } });
      haptic(10);
      setP(r);
      setRows(r.rows);
      setFresh(r.suggested);
      setOn(new Set(r.rows.filter((x) => !x.imported && !x.skip && !x.similar).map((x) => x.ref)));
      setCard(r.cards.length === 1 ? r.cards[0]!.id : "");
      setStage("review");
    } catch (e) {
      setStage("pick");
      setError((e as Error).message);
    }
  };

  const known = new Set(categories.list.map((c) => c.name));
  const colorOf = (name: string) => categories.list.find((c) => c.name === name)?.color ?? fresh.find((c) => c.name === name)?.color ?? "#9AA0A6";
  const isNew = (name: string) => !known.has(name);
  const chosen = rows.filter((r) => on.has(r.ref));
  const sum = (k: string) => chosen.filter((r) => r.kind === k).reduce((s, r) => s + Math.round(r.amount * 100), 0) / 100;
  const needsLook = (r: Row) => !r.imported && (r.category === "Outros" || Boolean(r.similar));
  const shown = rows.filter((r) => (filter === "check" ? needsLook(r) : filter === "off" ? !on.has(r.ref) : true));

  const toggle = (r: Row) => {
    if (r.imported) return;
    haptic(4);
    setOn((s) => {
      const n = new Set(s);
      if (n.has(r.ref)) n.delete(r.ref);
      else n.add(r.ref);
      return n;
    });
  };

  // trocar a categoria leva junto os parecidos (mesmo lugar) que ela ainda não mexeu
  const pick = (r: Row, category: string) => {
    haptic(6);
    const k = keyOf(r);
    let also = 0;
    setRows((list) =>
      list.map((x) => {
        if (x.ref === r.ref) return { ...x, category, how: "escolhido" };
        if (k && x.kind === r.kind && !touched.has(x.ref) && !x.imported && keyOf(x) === k && x.category !== category) {
          also++;
          return { ...x, category, how: "escolhido" };
        }
        return x;
      }),
    );
    setTouched((s) => new Set(s).add(r.ref));
    setPicking(null);
    setTimeout(() => setNote(also ? `Mudei também ${also} ${also === 1 ? "parecido" : "parecidos"} para ${category}.` : null), 0);
  };

  const create = (name: string) => {
    const n = name.replace(/\s+/g, " ").trim().slice(0, 30);
    if (!n || !picking) return;
    const same = [...categories.list.map((c) => c.name), ...fresh.map((c) => c.name)].find((c) => plain(c) === plain(n));
    if (!same) setFresh((f) => [...f, { name: n, kind: picking.kind, color: PALETTE[(categories.list.length + f.length) % PALETTE.length]! }]);
    pick(picking, same ?? n);
  };

  const save = async () => {
    if (!p || !chosen.length) return;
    setStage("saving");
    setError(null);
    try {
      const used = new Set(chosen.map((r) => r.category));
      const original = new Map(p.rows.map((r) => [r.ref, r.category]));
      const r = await api<{ imported: number; skipped: number; created: string[] }>("/api/finance/ofx/import", {
        method: "POST",
        json: {
          file: file.current,
          card_id: card || null,
          create: fresh.filter((c) => used.has(c.name) && isNew(c.name)),
          rows: chosen.map((x) => ({ ref: x.ref, category: x.category, changed: original.get(x.ref) !== x.category && x.how === "escolhido" })),
        },
      });
      haptic(14);
      setResult(r);
      setStage("done");
    } catch (e) {
      setStage("review");
      setError((e as Error).message);
    }
  };

  const lastMonth = rows.length ? [...chosen.map((r) => r.date)].sort().pop()?.slice(0, 7) ?? null : null;

  // ---------- escolher categoria (troca o conteúdo da folha, uma por vez) ----------
  if (picking) {
    const list = categories.list.filter((c) => c.kind === "both" || c.kind === picking.kind);
    const extra = fresh.filter((c) => !known.has(c.name));
    return (
      <Modal key="pick" title="Categoria" icon={<Icon name="hash" />} onClose={() => setPicking(null)} className="ofx-modal">
        <p className="muted ofx-pick-for ellipsis">{picking.description} · {brl(picking.amount)}</p>
        <div className="ofx-pick">
          {[...list.map((c) => ({ name: c.name, color: c.color, nova: false })), ...extra.map((c) => ({ name: c.name, color: c.color, nova: true }))].map((c) => (
            <button key={c.name} className={`ofx-pill${c.name === picking.category ? " on" : ""}${c.nova ? " nova" : ""}`} style={{ ["--c" as any]: c.color }} aria-pressed={c.name === picking.category} onClick={() => pick(picking, c.name)}>
              <i />
              <span className="ellipsis">{c.name}</span>
              {c.nova && <small>nova</small>}
            </button>
          ))}
        </div>
        <form className="ofx-create" onSubmit={(e) => { e.preventDefault(); create(String(new FormData(e.currentTarget).get("n") ?? "")); }}>
          <input name="n" className="input" placeholder="Criar categoria, ex.: Pets" maxLength={30} autoComplete="off" />
          <button className="btn btn-brand" type="submit"><Icon name="plus" size={15} /> Criar</button>
        </form>
      </Modal>
    );
  }

  // ---------- pronto ----------
  if (stage === "done" && result) {
    return (
      <Modal key="done" title="Importar extrato" icon={<Icon name="upload" />} onClose={() => onClose(lastMonth)} className="ofx-modal">
        <div className="ofx-done">
          <span className="ofx-done-check"><Icon name="check" size={28} /></span>
          <strong>{result.imported} {result.imported === 1 ? "lançamento importado" : "lançamentos importados"}</strong>
          <p className="muted">
            {result.created.length ? `Criei ${result.created.length === 1 ? "a categoria" : "as categorias"} ${result.created.join(", ")}. ` : ""}
            As categorias que você trocou valem para os próximos extratos e para o que mandar no WhatsApp.
          </p>
          <button className="btn btn-primary rep-btn" onClick={() => onClose(lastMonth)}>Ver em Finanças</button>
        </div>
      </Modal>
    );
  }

  // ---------- escolher arquivo ----------
  if (stage === "pick" || stage === "reading" || !p) {
    return (
      <Modal key="file" title="Importar extrato" icon={<Icon name="upload" />} onClose={() => onClose(null)} className="ofx-modal">
        <button
          className={`ofx-drop${drag ? " drag" : ""}${stage === "reading" ? " busy" : ""}`}
          disabled={stage === "reading"}
          onClick={() => { haptic(6); input.current?.click(); }}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void read(e.dataTransfer.files[0]); }}
        >
          <span className="ofx-sheet" aria-hidden="true">
            <i /><i className="out" /><i /><i className="in" /><i className="out" />
            <em>OFX</em>
          </span>
          <strong>{stage === "reading" ? "Lendo o extrato…" : "Escolher o arquivo .ofx"}</strong>
          <span className="muted">{stage === "reading" ? "Separando entradas, saídas e categorias" : "Ou arraste o arquivo para cá"}</span>
        </button>
        <input ref={input} type="file" accept=".ofx,.OFX,application/x-ofx,application/ofx" hidden onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} />
        <ErrorBox error={error} />
        <ol className="ofx-how">
          <li>No app ou site do banco, abra o extrato da conta ou a fatura do cartão.</li>
          <li>Toque em exportar e escolha <b>OFX</b> (às vezes aparece como Money).</li>
          <li>Você confere tudo antes: nada é salvo sem o seu ok, e importar de novo não repete.</li>
        </ol>
      </Modal>
    );
  }

  // ---------- conferir ----------
  const toCheck = rows.filter(needsLook).length;
  const offCount = rows.filter((r) => !on.has(r.ref)).length;
  const usedNew = fresh.filter((c) => isNew(c.name) && chosen.some((r) => r.category === c.name));
  return (
    <Modal
      key="review"
      title="Conferir extrato"
      icon={<Icon name="upload" />}
      onClose={() => onClose(null)}
      wide
      className="ofx-modal ofx-review"
      footer={(close) => (
        <>
          <button className="btn" onClick={close}>Cancelar</button>
          <button className="btn btn-primary ofx-go" disabled={!chosen.length || stage === "saving"} onClick={save}>
            {stage === "saving" ? <span className="rep-spin" aria-hidden="true" /> : <Icon name="check" size={16} />}
            <span>{stage === "saving" ? "Importando…" : `Importar ${chosen.length}`}</span>
          </button>
        </>
      )}
    >
      <div className="ofx-head">
        <div className="ofx-bank">
          <strong>{p.bank ?? "Extrato"}{p.credit_card ? " · cartão" : ""}</strong>
          <small className="muted">{[p.account, p.start && p.end ? `${day(p.start)} a ${day(p.end)}` : null].filter(Boolean).join(" · ")}</small>
        </div>
        <div className="ofx-stats">
          <span><small>Saídas</small><b className="mono">−{brl(sum("expense"))}</b></span>
          <span><small>Entradas</small><b className="mono amount-in">+{brl(sum("income"))}</b></span>
        </div>
      </div>

      {p.credit_card && p.cards.length > 0 && (
        <div className="ofx-card">
          <label htmlFor="ofx-card">Lançar no cartão</label>
          <SelectField id="ofx-card" value={card} title="Lançar no cartão" onChange={setCard} options={[{ value: "", label: "Sem cartão" }, ...p.cards.map((c) => ({ value: c.id, label: c.last4 ? `${c.name} final ${c.last4}` : c.name }))]} />
        </div>
      )}

      {usedNew.length > 0 && (
        <p className="ofx-newcats">
          <span className="muted">Categorias novas:</span>
          {usedNew.map((c) => <span key={c.name} className="ofx-chip"><i style={{ background: c.color }} />{c.name}</span>)}
        </p>
      )}

      <div className="ofx-filter" role="tablist" aria-label="Mostrar">
        <button role="tab" aria-selected={filter === "all"} className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>Todos <b>{rows.length}</b></button>
        <button role="tab" aria-selected={filter === "check"} className={filter === "check" ? "on" : ""} onClick={() => setFilter("check")}>Para conferir <b>{toCheck}</b></button>
        <button role="tab" aria-selected={filter === "off"} className={filter === "off" ? "on" : ""} onClick={() => setFilter("off")}>Fora <b>{offCount}</b></button>
      </div>

      <div className="ofx-list">
        {shown.length === 0 && <p className="muted ofx-empty">Nada aqui.</p>}
        {shown.map((r) => {
          const checked = on.has(r.ref);
          const hint = r.imported ? "Já importado" : r.skip ?? (r.similar ? `Parece com “${r.similar.description}” de ${day(r.similar.date)}` : null);
          return (
            <div key={r.ref} className={`ofx-row${checked ? "" : " off"}${r.imported ? " done" : ""}`}>
              <button className="ofx-check" role="checkbox" aria-checked={checked} disabled={r.imported} aria-label={`Importar ${r.description}`} onClick={() => toggle(r)}>
                {checked && <Icon name="check" size={13} />}
              </button>
              <span className="ofx-text">
                <span className="ellipsis">{r.description}</span>
                <small className={`ellipsis${hint && !r.imported ? " warn" : ""}`}>{day(r.date)}{hint ? ` · ${hint}` : ""}</small>
              </span>
              <button className={`ofx-cat${isNew(r.category) ? " nova" : ""}`} disabled={r.imported} onClick={() => { haptic(5); setNote(null); setPicking(r); }} style={{ ["--c" as any]: colorOf(r.category) }}>
                <i />
                <span className="ellipsis">{r.category}</span>
              </button>
              <strong className={`mono${r.kind === "income" ? " amount-in" : ""}`}>{r.kind === "income" ? "+" : "−"}{brl(r.amount)}</strong>
            </div>
          );
        })}
      </div>
      {note && <p className="rep-note"><Icon name="check" size={14} /> {note}</p>}
      <ErrorBox error={error} />
    </Modal>
  );
}
