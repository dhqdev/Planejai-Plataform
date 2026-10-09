import { type FormEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, brl } from "../api";
import { ComoFuncionaCompras, ComprasPoliticaResumo } from "../ComoFuncionaCompras";
import { Empty, ErrorBox, Loading, Modal, PageHead, confirmDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

interface Address {
  cep: string;
  street: string;
  number: string;
  complement?: string;
  district: string;
  city: string;
  state: string;
}
export interface BuyerProfile {
  address: Address | null;
  terms: { version: string; accepted: boolean; accepted_at: string | null };
}
interface Rules {
  enabled: boolean;
  maxCents: number;
  monthMaxCents: number;
}
interface Purchase {
  id: string;
  store: string;
  title: string;
  url: string | null;
  store_cents: number;
  status: string;
  order_ref: string | null;
  tracking: string | null;
  error: string | null;
  created_at: string;
}
interface Store {
  id: string;
  name: string;
  site: string;
  custom: boolean;
  connected: boolean;
  access: boolean;
  updated_at: string | null;
}
interface Data {
  rules: Rules;
  profile: BuyerProfile;
  stores: Store[];
  purchases: Purchase[];
}

const reais = (cents: number) => brl(cents / 100);
const STATUS: Record<string, [string, string]> = {
  awaiting_confirm: ["Esperando seu sim", "warn"],
  awaiting_person: ["Esperando seu Pix", "warn"],
  paid: ["Pago na loja", "ok"],
  delivered: ["Entregue", "ok"],
  canceled: ["Cancelado", ""],
};
const dateBR = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });

/**
 * Compras pelo assistente (Pix direto): o que falta para comprar (termos, loja, endereço), a explicação animada,
 * as lojas conectadas e o histórico. O dono vê também a explicação do lado dele e o atalho para as regras.
 */
export function ComprasPage({ isSuper }: { isSuper?: boolean }) {
  const { data, error, reload } = useApi<Data>("/api/compras");
  const [view, setView] = useState<"cliente" | "dono">(isSuper ? "dono" : "cliente");
  const [login, setLogin] = useState<string | null>(null);
  const [access, setAccess] = useState<Store | null>(null);
  const [adding, setAdding] = useState(false);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const { rules, profile } = data;
  const off = !rules.enabled;

  if (off && !isSuper) {
    return (
      <div className="page">
        <PageHead title="Compras" subtitle="Peça para o assistente comprar por você." />
        <Empty>As compras pelo assistente ainda não estão ligadas. Quando estiverem, é por aqui que você conecta sua loja e acompanha os pedidos.</Empty>
      </div>
    );
  }

  const anyStore = data.stores.some((s) => s.connected);
  const steps: { done: boolean; label: string; href: string }[] = [
    { done: profile.terms.accepted, label: "Aceitar os Termos de compra", href: "#cp-termos" },
    { done: anyStore, label: "Conectar sua conta numa loja", href: "#cp-lojas" },
  ];
  const ready = steps.every((s) => s.done);

  return (
    <div className="page cp-page">
      <PageHead title="Compras" subtitle='Mande no WhatsApp: "compra pra mim um fone JBL no Mercado Livre". O assistente acha, monta o carrinho e, depois do seu sim, te manda o Pix da loja.' />

      {isSuper && off && (
        <div className="card card-pad cp-note">
          <Icon name="settings" size={16} /> As compras estão desligadas para todo mundo. Ligue e ajuste os limites em <Link to="/settings#compras">Configurações &gt; Compras</Link>.
        </div>
      )}

      <section className="card card-pad cp-ready">
        <div className="cp-ready-head">
          <h2>{ready ? "Tudo pronto para comprar" : "Falta pouco para comprar"}</h2>
          <span className={`badge ${ready ? "badge-ok" : "badge-warn"}`}>{steps.filter((s) => s.done).length} de {steps.length}</span>
        </div>
        <ul className="cp-steps">
          {steps.map((s) => (
            <li key={s.label} className={s.done ? "done" : ""}>
              <span className="cp-check">{s.done ? <Icon name="check" size={14} /> : null}</span>
              {s.done ? s.label : <a href={s.href}>{s.label}</a>}
            </li>
          ))}
        </ul>
        <p className="muted cp-small">
          Você paga o Pix da loja direto do seu banco, sem taxa. Limite de {reais(rules.maxCents)} por compra e {reais(rules.monthMaxCents)} em 30 dias.
        </p>
      </section>

      <section className="cp-how">
        <div className="cp-how-head">
          <h2>Como funciona</h2>
          {isSuper && (
            <div className="tabs" role="tablist">
              <button className={`tab ${view === "dono" ? "active" : ""}`} onClick={() => setView("dono")}>Para você (dono)</button>
              <button className={`tab ${view === "cliente" ? "active" : ""}`} onClick={() => setView("cliente")}>Como o cliente vê</button>
            </div>
          )}
        </div>
        <ComoFuncionaCompras audience={view} />
      </section>

      <div className="cp-grid">
        <StoresCard stores={data.stores} onLogin={setLogin} onAccess={setAccess} onAdd={() => setAdding(true)} onChange={reload} />

        <section id="cp-termos" className="card card-pad">
          <ComprasPoliticaResumo />
          {profile.terms.accepted ? (
            <p className="cp-ok"><Icon name="check" size={14} /> Você aceitou em {dateBR(profile.terms.accepted_at!)}</p>
          ) : (
            <AcceptTerms onDone={reload} />
          )}
        </section>

        <section id="cp-dados" className="card card-pad">
          <h3 className="cp-h"><Icon name="user" size={16} /> Endereço de entrega</h3>
          <p className="muted cp-small">Opcional. Sem ele, o assistente usa o endereço principal da sua conta na loja e confirma com você. Fica criptografado e só vai para a loja.</p>
          <AddressForm profile={profile} onSaved={reload} />
        </section>

        <section className="card card-pad cp-wide">
          <h3 className="cp-h"><Icon name="file" size={16} /> Suas compras</h3>
          {data.purchases.length === 0 ? (
            <p className="muted cp-small">Nenhuma compra ainda. Peça no WhatsApp quando quiser.</p>
          ) : (
            <ul className="cp-list">
              {data.purchases.map((p) => {
                const [label, tone] = STATUS[p.status] ?? [p.status, ""];
                return (
                  <li key={p.id}>
                    <div className="cp-list-main">
                      <strong>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a> : p.title}</strong>
                      <small>
                        {dateBR(p.created_at)} · {data.stores.find((s) => s.id === p.store)?.name ?? p.store}
                        {p.order_ref ? ` · pedido ${p.order_ref}` : ""}
                        {p.tracking ? ` · rastreio ${p.tracking}` : ""}
                      </small>
                      {p.error && p.status === "canceled" && <small className="cp-err">{p.error}</small>}
                    </div>
                    <div className="cp-list-side">
                      <strong>{reais(p.store_cents)}</strong>
                      <span className={`badge${tone ? ` badge-${tone}` : ""}`}>{label}</span>
                      {(p.status === "awaiting_person" || p.status === "paid") && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={async () => {
                            await api(`/api/compras/${p.id}`, { method: "PATCH", json: { status: p.status === "paid" ? "delivered" : "paid" } });
                            reload();
                          }}
                        >
                          {p.status === "paid" ? "Chegou" : "Já paguei"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      {access && <AccessModal store={access} onClose={(ok) => { setAccess(null); if (ok) reload(); }} />}
      {adding && (
        <AddStoreModal
          onClose={(id) => {
            setAdding(false);
            if (!id) return;
            reload();
            setLogin(id);
          }}
        />
      )}
      {login && (
        <StoreLogin
          store={login}
          name={data.stores.find((s) => s.id === login)?.name ?? "site da loja"}
          onClose={(ok) => {
            setLogin(null);
            if (ok) reload();
          }}
        />
      )}
    </div>
  );
}

/** Lojas da pessoa (conectadas, com acesso salvo ou cadastradas por ela) e o catálogo para adicionar mais. */
function StoresCard({ stores, onLogin, onAccess, onAdd, onChange }: { stores: Store[]; onLogin: (id: string) => void; onAccess: (s: Store) => void; onAdd: () => void; onChange: () => void }) {
  const [q, setQ] = useState("");
  const mine = stores.filter((s) => s.connected || s.access || s.custom);
  const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const rest = stores.filter((s) => !mine.includes(s) && norm(`${s.name} ${s.site}`).includes(norm(q.trim())));
  const status = (s: Store) =>
    [s.connected ? `conectada${s.updated_at ? ` em ${dateBR(s.updated_at)}` : ""}` : "não conectada", s.access ? "login automático" : ""].filter(Boolean).join(" · ");
  return (
    <section id="cp-lojas" className="card card-pad cp-wide">
      <h3 className="cp-h"><Icon name="shop" size={16} /> Suas lojas</h3>
      <p className="muted cp-small">Você entra na sua conta numa janela daqui; senha e código vão direto para a loja, sem passar pelo assistente. Guardamos só o login, criptografado.</p>
      {mine.length ? (
        <ul className="cp-stores">
          {mine.map((s) => (
            <li key={s.id}>
              <span>
                <strong>{s.name}</strong>
                <small>{s.custom ? `${s.site} · ` : ""}{status(s)}</small>
              </span>
              <span className="cp-row-actions">
                <button className={`btn btn-sm ${s.connected ? "btn-ghost" : "btn-primary"}`} onClick={() => onLogin(s.id)}>{s.connected ? "Entrar de novo" : "Conectar"}</button>
                <button className="btn btn-sm btn-ghost" onClick={() => onAccess(s)}>Login automático</button>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    const body = s.custom ? "Ela sai da sua lista, com o login e o acesso salvos." : "O assistente para de entrar na sua conta e o acesso salvo é apagado. Dá para conectar de novo quando quiser.";
                    if (!(await confirmDialog({ title: `${s.custom ? "Tirar" : "Desconectar"} ${s.name}?`, body, confirmLabel: s.custom ? "Tirar" : "Desconectar", danger: true }))) return;
                    if (s.custom) await api(`/api/compras/lojas/${s.id}/cadastro`, { method: "DELETE" });
                    else {
                      await api(`/api/compras/lojas/${s.id}`, { method: "DELETE" });
                      await api(`/api/compras/lojas/${s.id}/acesso`, { method: "DELETE" });
                    }
                    onChange();
                  }}
                >
                  {s.custom ? "Tirar" : "Desconectar"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted cp-small cp-empty">Nenhuma loja ainda. Escolha uma abaixo.</p>
      )}

      <div className="cp-add">
        <div className="cp-add-head">
          <strong>Adicionar loja</strong>
          <input className="input" type="search" placeholder="Buscar loja" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar loja" />
        </div>
        <div className="cp-chips">
          {rest.map((s) => (
            <button key={s.id} className="cp-chip" onClick={() => onLogin(s.id)}>
              <Icon name="plus" size={13} /> {s.name}
            </button>
          ))}
          <button className="cp-chip cp-chip-other" onClick={onAdd}>
            <Icon name="link" size={13} /> Outra loja
          </button>
        </div>
      </div>
    </section>
  );
}

/** Cadastra uma loja que não está na lista, pelo site. */
function AddStoreModal({ onClose }: { onClose: (id: string | null) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ id: string }>("/api/compras/lojas", { method: "POST", json: { name, url } });
      onClose(r.id);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Outra loja"
      icon={<Icon name="shop" />}
      onClose={() => onClose(null)}
      footer={
        <>
          <button className="btn" onClick={() => onClose(null)}>Cancelar</button>
          <button className="btn btn-primary" disabled={busy || !url.trim()} onClick={() => save()}>{busy ? "Salvando…" : "Adicionar e entrar"}</button>
        </>
      }
    >
      <form className="cp-form compact" onSubmit={save}>
        <div className="field cp-span-all">
          <label>Site da loja</label>
          <input className="input" inputMode="url" placeholder="www.lojaexemplo.com.br" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus required />
        </div>
        <div className="field cp-span-all">
          <label>Nome (opcional)</label>
          <input className="input" placeholder="Loja Exemplo" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </div>
      </form>
      <p className="muted cp-small">Depois você entra na sua conta dela. A compra só fecha se a loja aceitar Pix.</p>
      {err && <p className="cp-err">{err}</p>}
    </Modal>
  );
}

/** E-mail e senha da loja para a Nina entrar de novo sozinha quando o login vencer. */
function AccessModal({ store, onClose }: { store: Store; onClose: (ok: boolean) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/compras/lojas/${store.id}/acesso`, { method: "PUT", json: { email, password } });
      onClose(true);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Login automático no ${store.name}`}
      icon={<Icon name="shield" />}
      onClose={() => onClose(false)}
      footer={
        <>
          {store.access && (
            <button
              className="btn btn-ghost"
              onClick={async () => {
                await api(`/api/compras/lojas/${store.id}/acesso`, { method: "DELETE" });
                onClose(true);
              }}
            >
              Apagar acesso
            </button>
          )}
          <button className="btn" onClick={() => onClose(false)}>Cancelar</button>
          <button className="btn btn-primary" disabled={busy || (!email.trim() && !password)} onClick={() => save()}>{busy ? "Salvando…" : "Salvar"}</button>
        </>
      }
    >
      <p className="muted cp-small">
        Quando o login da loja vencer, a Nina entra de novo sozinha: o sistema digita o e-mail e a senha direto no site da loja, sem o assistente ver. Se a loja
        mandar um código por e-mail e o seu Gmail estiver conectado em Minha conta, ela pega o código lá. Código por SMS continua com você.
      </p>
      <form className="cp-form compact" onSubmit={save}>
        <div className="field cp-span-all">
          <label>E-mail ou usuário da loja</label>
          <input className="input" autoComplete="off" placeholder={store.access ? "deixe em branco para manter" : ""} value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field cp-span-all">
          <label>Senha da loja</label>
          <input className="input" type="password" autoComplete="new-password" placeholder={store.access ? "deixe em branco para manter" : ""} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
      </form>
      <p className="muted cp-small">Fica criptografado e só é usado no site dessa loja. Você apaga quando quiser.</p>
      {err && <p className="cp-err">{err}</p>}
    </Modal>
  );
}

function AcceptTerms({ onDone }: { onDone: () => void }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="cp-accept">
      <label className="cp-agree">
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>Li e aceito os <Link to="/termos-de-compra" target="_blank">Termos de compra</Link>.</span>
      </label>
      <button
        className="btn btn-primary btn-sm"
        disabled={!ok || busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("/api/compras/termos", { method: "POST" });
            onDone();
          } finally {
            setBusy(false);
          }
        }}
      >
        Aceitar
      </button>
    </div>
  );
}

const UFS = "AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" ");
const cepMask = (v: string) => v.replace(/\D/g, "").slice(0, 8).replace(/^(\d{5})(\d)/, "$1-$2");
/** Endereço de entrega. O CEP preenche rua, bairro e cidade. Usado aqui e no cadastro. */
export function AddressForm({ profile, onSaved, compact }: { profile: BuyerProfile | null; onSaved: () => void; compact?: boolean }) {
  const a = profile?.address;
  const [f, setF] = useState({
    cep: a?.cep ? cepMask(a.cep) : "",
    street: a?.street ?? "",
    number: a?.number ?? "",
    complement: a?.complement ?? "",
    district: a?.district ?? "",
    city: a?.city ?? "",
    state: a?.state ?? "",
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const lookup = async (cep: string) => {
    const d = cep.replace(/\D/g, "");
    if (d.length !== 8) return;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${d}/json/`).then((x) => x.json());
      if (r && !r.erro) setF((x) => ({ ...x, street: x.street || r.logradouro || "", district: x.district || r.bairro || "", city: r.localidade || x.city, state: r.uf || x.state }));
    } catch {
      /* sem internet ou CEP fora do ar: a pessoa digita */
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api("/api/compras/endereco", { method: "PUT", json: { address: f } });
      setSaved(true);
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={`cp-form ${compact ? "compact" : ""}`} onSubmit={submit}>
      <div className="field">
        <label>CEP</label>
        <input
          className="input"
          inputMode="numeric"
          autoComplete="postal-code"
          value={f.cep}
          onChange={(e) => {
            const v = cepMask(e.target.value);
            setF((x) => ({ ...x, cep: v }));
            if (v.length === 9) void lookup(v);
          }}
          required
        />
      </div>
      <div className="field cp-span2">
        <label>Rua</label>
        <input className="input" autoComplete="address-line1" value={f.street} onChange={set("street")} required />
      </div>
      <div className="field">
        <label>Número</label>
        <input className="input" value={f.number} onChange={set("number")} required />
      </div>
      <div className="field">
        <label>Complemento</label>
        <input className="input" autoComplete="address-line2" value={f.complement} onChange={set("complement")} />
      </div>
      <div className="field">
        <label>Bairro</label>
        <input className="input" value={f.district} onChange={set("district")} required />
      </div>
      <div className="field">
        <label>Cidade</label>
        <input className="input" autoComplete="address-level2" value={f.city} onChange={set("city")} required />
      </div>
      <div className="field">
        <label>UF</label>
        <select className="select" value={f.state} onChange={set("state")} required>
          <option value="" />
          {UFS.map((u) => <option key={u}>{u}</option>)}
        </select>
      </div>
      <div className="cp-form-foot cp-span-all">
        {err && <span className="cp-err">{err}</span>}
        {saved && !err && <span className="cp-ok"><Icon name="check" size={14} /> Salvo</span>}
        <button className="btn btn-primary" disabled={busy}>{busy ? "Salvando…" : "Salvar endereço"}</button>
      </div>
    </form>
  );
}

/**
 * Janela ao vivo para a pessoa entrar na conta da loja: mostra a tela do navegador do servidor e manda os toques
 * e o que ela digita. O que é digitado vai direto para a página da loja, sem passar pelo assistente.
 */
function StoreLogin({ store, name, onClose }: { store: string; name: string; onClose: (ok: boolean) => void }) {
  const [sess, setSess] = useState<{ id: string; width: number; height: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [text, setText] = useState("");
  const [hide, setHide] = useState(true);
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const idRef = useRef<string | null>(null);
  const quiet = { "x-pj-quiet": "1" };

  useEffect(() => {
    let alive = true;
    api<{ id: string; width: number; height: number }>(`/api/compras/lojas/${store}/login`, { method: "POST", headers: quiet }).then(
      (s) => {
        if (!alive) return void api(`/api/compras/login/${s.id}`, { method: "DELETE", headers: quiet }).catch(() => {});
        idRef.current = s.id;
        setSess(s);
      },
      (e) => setErr((e as Error).message),
    );
    return () => {
      alive = false;
      if (idRef.current) void api(`/api/compras/login/${idRef.current}`, { method: "DELETE", headers: quiet }).catch(() => {});
    };
  }, [store]);
  // a tela da loja atualiza sozinha
  useEffect(() => {
    if (!sess) return;
    const t = setInterval(() => setTick((n) => n + 1), 900);
    return () => clearInterval(t);
  }, [sess]);

  const send = async (input: Record<string, unknown>) => {
    if (!sess) return;
    try {
      await api(`/api/compras/login/${sess.id}`, { method: "POST", json: input, headers: quiet });
      setTick((n) => n + 1);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const click = (e: MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !sess) return;
    const r = img.getBoundingClientRect();
    void send({ type: "click", x: Math.round(((e.clientX - r.left) / r.width) * sess.width), y: Math.round(((e.clientY - r.top) / r.height) * sess.height) });
  };
  const finish = async () => {
    if (!sess) return;
    setBusy(true);
    try {
      await api(`/api/compras/login/${sess.id}/pronto`, { method: "POST", headers: quiet });
      idRef.current = null;
      onClose(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Entrar no ${name}`}
      icon={<Icon name="shop" />}
      onClose={() => onClose(false)}
      footer={
        <>
          <button className="btn" onClick={() => onClose(false)}>Cancelar</button>
          <button className="btn btn-primary" disabled={!sess || busy} onClick={finish}>{busy ? "Guardando…" : "Pronto, entrei"}</button>
        </>
      }
    >
      <p className="muted cp-small">Toque na tela da loja para escolher os campos e use a caixa abaixo para digitar. Entre na sua conta normalmente, inclusive com o código que a loja mandar.</p>
      {err && <p className="cp-err">{err}</p>}
      <div className="cp-live">
        {sess ? (
          <img ref={imgRef} src={`/api/compras/login/${sess.id}/tela?t=${tick}`} alt={`Tela do ${name}`} onClick={click} width={sess.width} height={sess.height} />
        ) : (
          !err && <div className="cp-live-wait">Abrindo o {name}…</div>
        )}
      </div>
      <form
        className="cp-type"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          void send({ type: "text", text }).then(() => setText(""));
        }}
      >
        <input className="input" type={hide ? "password" : "text"} autoComplete="off" placeholder="Digite aqui e toque em Enviar" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="button" className="icon-btn sm" title={hide ? "Mostrar" : "Esconder"} onClick={() => setHide(!hide)}><Icon name="eye" size={16} /></button>
        <button className="btn btn-sm">Enviar</button>
      </form>
      <div className="cp-keys">
        <button className="btn btn-sm btn-ghost" onClick={() => send({ type: "key", key: "Enter" })}>Enter</button>
        <button className="btn btn-sm btn-ghost" onClick={() => send({ type: "key", key: "Backspace" })}>Apagar</button>
        <button className="btn btn-sm btn-ghost" onClick={() => send({ type: "key", key: "Tab" })}>Próximo campo</button>
        <button className="btn btn-sm btn-ghost" onClick={() => send({ type: "scroll", dy: -500 })}>Subir</button>
        <button className="btn btn-sm btn-ghost" onClick={() => send({ type: "scroll", dy: 500 })}>Descer</button>
        <button className="btn btn-sm btn-ghost" onClick={() => send({ type: "back" })}>Voltar</button>
      </div>
    </Modal>
  );
}
