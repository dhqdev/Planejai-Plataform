import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api, brl } from "../api";
import { ErrorBox, Loading, Modal, PageHead, alertDialog, confirmDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

interface Offer {
  store: string;
  title: string;
  cents: number;
  old_cents?: number;
  link: string;
  image?: string;
  free_shipping?: boolean;
  seller?: string;
  rating?: number;
  sold?: number;
  variant_ok?: boolean;
  pick?: string;
}
interface Search {
  offers: Offer[];
  stores: string[];
  failed: string[];
  web?: { title: string; url: string; content?: string }[];
  web_answer?: string;
  /** o que falta dizer para o link abrir na variação certa ("qual a voltagem (110 ou 220)") */
  ask?: string[];
  /** a variação usada nesta busca (vai junto ao guardar) */
  variant?: string;
}
interface Item {
  id: string;
  title: string;
  store: string | null;
  cents: number | null;
  link: string | null;
  image: string | null;
  query: string | null;
  variant: string | null;
  bought_at: string | null;
  created_at: string;
  watch_id: string | null;
  watch_active: boolean | null;
  alert_below: string | null;
  watch_best: { price?: number; title?: string; link?: string; at?: string } | null;
}
interface Data {
  items: Item[];
  stores: Record<string, boolean>;
  web: boolean;
}

const reais = (cents: number) => brl(cents / 100);
/** Foto só dos CDNs das lojas (os mesmos liberados na CSP do painel). */
const safeImage = (u?: string | null) => {
  try {
    const h = u ? new URL(u).hostname : "";
    return /(^|\.)mlstatic\.com$|(^|\.)susercontent\.com$/.test(h) ? u! : null;
  } catch {
    return null;
  }
};
const EXAMPLES = ["fone JBL Tune 520BT", "air fryer Mondial 4L", "tênis Nike Revolution 7", "kindle 11ª geração"];

/**
 * Compras: o assistente acha o menor preço nas lojas (Mercado Livre e Shopee juntos) e manda o link; a compra é da pessoa,
 * no app da loja. Aqui dá para buscar, guardar na lista e ligar o aviso de quando o preço baixar.
 */
export function ComprasPage({ isSuper }: { isSuper?: boolean }) {
  const { data, error, reload } = useApi<Data>("/api/compras");
  const [q, setQ] = useState("");
  const [condition, setCondition] = useState<"" | "new" | "used">("");
  const [max, setMax] = useState("");
  const [variant, setVariant] = useState("");
  const [result, setResult] = useState<Search | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [alertFor, setAlertFor] = useState<Item | null>(null);
  const [showBought, setShowBought] = useState(false);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;

  const connected = Object.entries(data.stores).filter(([, on]) => on).map(([name]) => name);
  const saved = new Set(data.items.filter((i) => !i.bought_at).map((i) => i.link));
  const open = data.items.filter((i) => !i.bought_at);
  const bought = data.items.filter((i) => i.bought_at);

  const search = async (e?: FormEvent, text = q) => {
    e?.preventDefault();
    if (!text.trim() || searching) return;
    setQ(text);
    setSearching(true);
    setSearchError(null);
    try {
      const p = new URLSearchParams({ q: text.trim() });
      if (condition) p.set("condition", condition);
      if (Number(max) > 0) p.set("max", max);
      if (variant.trim()) p.set("variant", variant.trim());
      setResult({ ...(await api<Search>(`/api/compras/busca?${p}`)), variant: variant.trim() || undefined });
      haptic(8);
    } catch (err) {
      setSearchError((err as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const save = async (o: Offer, alert = false) => {
    try {
      await api("/api/compras/lista", {
        method: "POST",
        json: { title: o.title, store: o.store, cents: o.cents, link: o.link, image: o.image, query: q.trim() || o.title, variant: result?.variant, alert },
      });
      haptic(10);
      reload();
    } catch (err) {
      void alertDialog("Não deu para guardar", (err as Error).message);
    }
  };

  const patch = async (it: Item, json: Record<string, unknown>) => {
    try {
      await api(`/api/compras/lista/${it.id}`, { method: "PATCH", json });
      haptic(8);
    } catch (err) {
      void alertDialog("Não deu certo", (err as Error).message);
    } finally {
      reload();
    }
  };

  const remove = async (it: Item) => {
    if (!(await confirmDialog({ title: "Tirar da lista?", body: it.watch_id ? "O aviso de preço desse item também para." : undefined, confirmLabel: "Tirar", danger: true }))) return;
    await api(`/api/compras/lista/${it.id}`, { method: "DELETE" }).catch(() => {});
    reload();
  };

  return (
    <div className="page shop-page">
      <PageHead title="Compras" subtitle="Ache o menor preço nas lojas e guarde o que você quer. Você compra no app da loja, com o seu pagamento." />

      <section className="card card-pad shop-search">
        <form className="shop-bar" onSubmit={search}>
          <Icon name="search" size={18} />
          <input
            className="shop-input"
            type="search"
            enterKeyHint="search"
            placeholder="O que você quer comprar?"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Produto"
          />
          <button className="btn btn-primary" disabled={!q.trim() || searching}>{searching ? "Buscando…" : "Buscar"}</button>
        </form>
        <label className="shop-variant">
          <span>Cor, tamanho, voltagem</span>
          <input
            className="input"
            value={variant}
            onChange={(e) => setVariant(e.target.value)}
            placeholder="ex.: 42, preto · 220V · 128 GB"
            maxLength={60}
            enterKeyHint="search"
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
        </label>
        <div className="shop-filters">
          <div className="seg" role="radiogroup" aria-label="Condição">
            {([["", "Todos"], ["new", "Novos"], ["used", "Usados"]] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={condition === v} className={condition === v ? "active" : ""} onClick={() => setCondition(v)}>
                {label}
              </button>
            ))}
          </div>
          <label className="shop-max">
            <span>Até R$</span>
            <input className="input" type="number" inputMode="decimal" min={0} step={1} value={max} onChange={(e) => setMax(e.target.value)} placeholder="sem teto" />
          </label>
        </div>
        <p className="shop-stores">
          {connected.length ? (
            <>
              Buscando em {connected.map((s, i) => <span key={s}><b>{s}</b>{i < connected.length - 1 ? " e " : ""}</span>)} ao mesmo tempo.
            </>
          ) : (
            <>Nenhuma loja conectada ainda, então a busca usa a web{data.web ? "" : " (e ela também não está ligada)"}.</>
          )}
          {isSuper && <> <Link to="/integrations">Conectar lojas</Link></>}
        </p>
      </section>

      <ErrorBox error={searchError} />

      {result ? (
        <Results result={result} saved={saved} onSave={save} />
      ) : (
        !open.length && (
          <section className="shop-hint">
            <p>Experimente:</p>
            <div className="shop-chips">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="chip" onClick={() => search(undefined, ex)}>{ex}</button>
              ))}
            </div>
            <p className="muted">Ou mande no WhatsApp: "acha o menor preço do fone JBL" ou "me avisa quando a air fryer baixar de R$ 300".</p>
          </section>
        )
      )}

      <section className="shop-list-wrap">
        <div className="shop-list-head">
          <h2>Sua lista</h2>
          {bought.length > 0 && (
            <button className="link-btn" onClick={() => setShowBought(!showBought)}>{showBought ? "Esconder comprados" : `Comprados (${bought.length})`}</button>
          )}
        </div>
        {open.length === 0 ? (
          <p className="muted shop-empty">Nada guardado. Toque em "Guardar" numa oferta, ou peça no WhatsApp para guardar e avisar quando baixar.</p>
        ) : (
          <ul className="shop-list">{open.map((it) => <ListItem key={it.id} it={it} onAlert={() => setAlertFor(it)} onBought={() => patch(it, { bought: true })} onRemove={() => remove(it)} />)}</ul>
        )}
        {showBought && bought.length > 0 && (
          <ul className="shop-list is-bought">{bought.map((it) => <ListItem key={it.id} it={it} onBought={() => patch(it, { bought: false })} onRemove={() => remove(it)} />)}</ul>
        )}
      </section>

      {alertFor && (
        <AlertModal
          item={alertFor}
          onClose={() => setAlertFor(null)}
          onSave={async (on, below) => {
            setAlertFor(null);
            await patch(alertFor, { alert: on, alert_below: below });
          }}
        />
      )}
    </div>
  );
}

function Results({ result, saved, onSave }: { result: Search; saved: Set<string | null>; onSave: (o: Offer, alert?: boolean) => void }) {
  const cheapest = result.offers[0]?.cents;
  return (
    <section className="shop-results" aria-live="polite">
      {result.ask && result.ask.length > 0 && result.offers.length > 0 && (
        <p className="shop-warn">Diga {result.ask.join(" e ")} no campo de cima e o link já abre na variação certa.</p>
      )}
      {result.failed.length > 0 && <p className="shop-warn">Não deu para ver {result.failed.join(" e ")} agora; mostrando o resto.</p>}
      {result.offers.length > 0 ? (
        <ul className="shop-grid">
          {result.offers.map((o, i) => {
            const img = safeImage(o.image);
            const isSaved = saved.has(o.link);
            return (
              <li key={o.link} className="shop-offer" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                <div className="shop-photo">{img ? <img src={img} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="shop" size={28} />}</div>
                <div className="shop-offer-body">
                  <div className="shop-tags">
                    <span className="shop-store">{o.store}</span>
                    {o.cents === cheapest && i === 0 && <span className="shop-best">Menor preço</span>}
                    {o.variant_ok && <span className="shop-variant-ok">Variação certa</span>}
                  </div>
                  <a className="shop-title" href={o.link} target="_blank" rel="noreferrer noopener">{o.title}</a>
                  <div className="shop-price">
                    <strong>{reais(o.cents)}</strong>
                    {o.old_cents && o.old_cents > o.cents && <s>{reais(o.old_cents)}</s>}
                  </div>
                  <small className="muted">
                    {[o.free_shipping && "Frete grátis", o.seller, o.rating && `${o.rating.toFixed(1)} de nota`, o.sold && `${o.sold.toLocaleString("pt-BR")} vendidos`].filter(Boolean).join(" · ")}
                  </small>
                  {o.pick && <small className="shop-pick">Na loja, escolha: {o.pick}</small>}
                </div>
                <div className="shop-actions">
                  <a className="btn btn-primary btn-sm" href={o.link} target="_blank" rel="noreferrer noopener">
                    Abrir na loja <Icon name="external" size={14} />
                  </a>
                  {isSaved ? (
                    <span className="shop-saved"><Icon name="check" size={14} /> Na lista</span>
                  ) : (
                    <button className="btn btn-sm" onClick={() => onSave(o)}>
                      <Icon name="bookmark" size={14} /> Guardar
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : result.web?.length ? (
        <div className="card card-pad shop-web">
          <p className="muted">Sem preço das lojas para isso. Achei na web (confira o preço na página):</p>
          {result.web_answer && <p>{result.web_answer}</p>}
          <ul>
            {result.web.map((w) => (
              <li key={w.url}>
                <a href={w.url} target="_blank" rel="noreferrer noopener">{w.title}</a>
                {w.content && <small className="muted">{w.content}</small>}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted shop-empty">Não achei esse produto. Tente com a marca e o modelo, sem "barato" nem "promoção".</p>
      )}
    </section>
  );
}

function ListItem({ it, onAlert, onBought, onRemove }: { it: Item; onAlert?: () => void; onBought: () => void; onRemove: () => void }) {
  const img = safeImage(it.image);
  const now = it.watch_best?.price != null ? Math.round(Number(it.watch_best.price) * 100) : null;
  const diff = now != null && it.cents ? now - it.cents : null;
  const watching = Boolean(it.watch_id && it.watch_active);
  return (
    <li className="shop-item">
      <div className="shop-photo sm">{img ? <img src={img} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="shop" size={20} />}</div>
      <div className="shop-item-main">
        {it.link ? <a href={it.link} target="_blank" rel="noreferrer noopener" className="shop-title">{it.title}</a> : <span className="shop-title">{it.title}</span>}
        <small className="muted">
          {[it.variant, it.store, it.cents && `guardado por ${reais(it.cents)}`].filter(Boolean).join(" · ")}
          {now != null && (
            <>
              {" · "}
              <span className={diff != null && diff < 0 ? "shop-down" : ""}>
                hoje {reais(now)}
                {diff != null && diff !== 0 && ` (${diff < 0 ? "-" : "+"}${reais(Math.abs(diff))})`}
              </span>
            </>
          )}
        </small>
        {watching && (
          <small className="shop-watch">
            <Icon name="bell" size={12} /> Avisando quando baixar{it.alert_below ? ` de ${brl(Number(it.alert_below))}` : ""}
          </small>
        )}
      </div>
      <div className="shop-item-actions">
        {onAlert && (
          <button className={`icon-btn${watching ? " active" : ""}`} title="Aviso de preço" aria-label="Aviso de preço" onClick={onAlert}>
            <Icon name="bell" size={16} />
          </button>
        )}
        <button className="icon-btn" title={it.bought_at ? "Voltar para a lista" : "Comprei"} aria-label={it.bought_at ? "Voltar para a lista" : "Comprei"} onClick={onBought}>
          <Icon name={it.bought_at ? "repeat" : "check"} size={16} />
        </button>
        <button className="icon-btn" title="Tirar da lista" aria-label="Tirar da lista" onClick={onRemove}>
          <Icon name="trash" size={16} />
        </button>
      </div>
    </li>
  );
}

function AlertModal({ item, onClose, onSave }: { item: Item; onClose: () => void; onSave: (on: boolean, below: number | null) => void }) {
  const watching = Boolean(item.watch_id && item.watch_active);
  const [below, setBelow] = useState(item.alert_below ? String(Number(item.alert_below)) : "");
  return (
    <Modal
      title="Aviso de preço"
      icon="bell"
      onClose={onClose}
      footer={(close) => (
        <>
          {watching ? (
            <button className="btn" onClick={() => onSave(false, null)}>Parar de avisar</button>
          ) : (
            <button className="btn" onClick={close}>Cancelar</button>
          )}
          <button className="btn btn-primary" onClick={() => onSave(true, Number(below) > 0 ? Number(below) : null)}>{watching ? "Salvar" : "Avisar"}</button>
        </>
      )}
    >
      <p className="muted">Fico de olho no preço de "{item.title}" no Mercado Livre e na Shopee por 30 dias e te aviso no WhatsApp quando baixar.</p>
      <div className="field">
        <label htmlFor="shop-below">Avisar só quando chegar em (R$)</label>
        <input id="shop-below" className="input" type="number" inputMode="decimal" min={0} step={1} value={below} onChange={(e) => setBelow(e.target.value)} placeholder="qualquer queda" />
      </div>
    </Modal>
  );
}
