import { useState } from "react";
import { api, brl } from "../api";
import { CATEGORY_COLORS, ErrorBox, Modal } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { SelectField } from "../pickers";
import { haptic } from "../touch";

/** Categoria de gastos da pessoa (`/api/finance/categories`). */
export type FinCategory = {
  id: string;
  name: string;
  color: string;
  kind: "expense" | "income" | "both";
  keywords: string[];
  count: number;
  month_total: number;
  fixed: boolean;
};

const PALETTE = ["#FF7A1A", "#FF4458", "#E23382", "#B830C8", "#8B2BE2", "#5B45E8", "#2F7BEA", "#16A3A3", "#2E9E5B", "#C9A227", "#8D6E63", "#9AA0A6"];
const KIND_LABEL = { expense: "Gasto", income: "Receita", both: "Os dois" } as const;

export function useCategories(user = "") {
  const r = useApi<FinCategory[]>(`/api/finance/categories${user ? `?user=${user}` : ""}`);
  const list = r.data ?? [];
  // cor da categoria; a que não está na lista (lançamento antigo) pega a da posição, como antes
  const colorOf = (name: string, i = 0) => list.find((c) => c.name === name)?.color ?? CATEGORY_COLORS[i % CATEGORY_COLORS.length]!;
  return { ...r, list, colorOf };
}

/** Lista de categorias: tocar edita; "Nova categoria" cria. */
export function CategoriesModal({ onClose }: { onClose: (changed: boolean) => void }) {
  const { list, reload } = useCategories();
  const [editing, setEditing] = useState<FinCategory | "new" | null>(null);
  const [changed, setChanged] = useState(false);
  // uma folha por vez: editar troca a lista pelo formulário e volta para ela
  if (editing)
    return (
      <CategoryForm
        initial={editing === "new" ? null : editing}
        others={list.filter((c) => editing === "new" || c.id !== editing.id)}
        onClose={(saved) => {
          setEditing(null);
          if (saved) {
            setChanged(true);
            void reload();
          }
        }}
      />
    );
  return (
    <Modal
      title="Categorias"
      icon={<Icon name="hash" />}
      onClose={() => onClose(changed)}
      footer={<button className="btn btn-brand" onClick={() => { haptic(5); setEditing("new"); }}><Icon name="plus" size={15} /> Nova categoria</button>}
    >
      <p className="muted cat-help">Quando você troca a categoria de um lançamento, os parecidos já vão para ela da próxima vez.</p>
      <div className="cat-list">
        {list.map((c) => (
          <button key={c.id} className="cat-row" onClick={() => { haptic(5); setEditing(c); }}>
            <span className="cat-dot" style={{ background: c.color }} />
            <span className="cat-text">
              <span className="ellipsis">{c.name}</span>
              <small className="muted ellipsis">
                {c.kind !== "expense" ? `${KIND_LABEL[c.kind]} · ` : ""}
                {c.count} {c.count === 1 ? "lançamento" : "lançamentos"}
                {c.keywords.length ? ` · ${c.keywords.join(", ")}` : ""}
              </small>
            </span>
            {c.month_total > 0 && <small className="cat-month">{brl(c.month_total)}</small>}
            <Icon name="chevron-right" size={14} />
          </button>
        ))}
      </div>
    </Modal>
  );
}

function CategoryForm({ initial, others, onClose }: { initial: FinCategory | null; others: FinCategory[]; onClose: (saved: boolean) => void }) {
  const used = new Set(others.map((c) => c.color.toUpperCase()));
  const [f, setF] = useState({
    name: initial?.name ?? "",
    color: initial?.color ?? PALETTE.find((c) => !used.has(c)) ?? PALETTE[0]!,
    kind: initial?.kind ?? "expense",
    keywords: initial?.keywords.join(", ") ?? "",
  });
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      haptic(10);
      onClose(true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const save = () => run(() => (initial ? api(`/api/finance/categories/${initial.id}`, { method: "PATCH", json: f }) : api("/api/finance/categories", { method: "POST", json: f })));
  const remove = () => run(() => api(`/api/finance/categories/${initial!.id}?move_to=${encodeURIComponent(removing ?? "Outros")}`, { method: "DELETE" }));
  if (initial && removing !== null)
    return (
      <Modal
        title={`Excluir ${initial.name}?`}
        icon={<Icon name="trash" />}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setRemoving(null)}>Voltar</button>
            <span className="spacer" />
            <button className="btn btn-danger" disabled={busy} onClick={remove}>{busy ? "Excluindo…" : "Excluir"}</button>
          </>
        }
      >
        {initial.count > 0 ? (
          <div className="field">
            <label htmlFor="cat-move">Os {initial.count} lançamentos vão para</label>
            <SelectField id="cat-move" title="Mover lançamentos para" value={removing} onChange={setRemoving} options={others.map((c) => ({ value: c.name, label: c.name, dot: c.color }))} />
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>Ela não tem lançamentos. Os limites e contas fixas dela, se tiver, vão para {removing}.</p>
        )}
        <ErrorBox error={error} />
      </Modal>
    );
  return (
    <Modal
      title={initial ? "Editar categoria" : "Nova categoria"}
      icon={<Icon name="hash" />}
      onClose={() => onClose(false)}
      footer={
        <>
          {initial && !initial.fixed && <button className="btn btn-ghost" onClick={() => setRemoving(others.some((c) => c.name === "Outros") ? "Outros" : (others[0]?.name ?? "Outros"))}><Icon name="trash" size={15} /> Excluir</button>}
          <span className="spacer" />
          <button className="btn btn-primary" disabled={busy || !f.name.trim()} onClick={save}>{busy ? "Salvando…" : "Salvar"}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="field">
        <label htmlFor="cat-name">Nome</label>
        <input id="cat-name" className="input" autoComplete="off" maxLength={30} disabled={initial?.fixed} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Pets" />
        {initial && initial.count > 0 && f.name.trim() && f.name.trim() !== initial.name && <small className="muted">Os {initial.count} lançamentos passam a se chamar {f.name.trim()}.</small>}
      </div>
      <div className="field">
        <span className="field-label">Cor</span>
        <div className="cat-colors" role="radiogroup" aria-label="Cor">
          {PALETTE.map((c) => (
            <button key={c} role="radio" aria-checked={f.color.toUpperCase() === c} aria-label={c} className={`cat-color${f.color.toUpperCase() === c ? " on" : ""}`} style={{ background: c }} onClick={() => { haptic(4); setF({ ...f, color: c }); }} />
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">Usada em</span>
        <div className="tabs">
          {(["expense", "income", "both"] as const).map((k) => (
            <button key={k} className={f.kind === k ? "active" : ""} aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })}>{k === "expense" ? "Gastos" : k === "income" ? "Receitas" : "Os dois"}</button>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="cat-words">Palavras que caem nela</label>
        <input id="cat-words" className="input" autoComplete="off" value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} placeholder="ração, veterinário, petshop" />
        <small className="muted">Separe por vírgula. Um gasto com essas palavras entra aqui sozinho.</small>
      </div>
    </Modal>
  );
}
