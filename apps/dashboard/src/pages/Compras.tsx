import { type FormEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, brl } from "../api";
import { ComoFuncionaCompras, ComprasPoliticaResumo } from "../ComoFuncionaCompras";
import { Empty, ErrorBox, Loading, Modal, PageHead, confirmDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

type Method = "pix" | "card" | "wallet";

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
  filled: boolean;
  full_name: string;
  cpf_end: string | null;
  birth_date: string;
  address: Address | null;
  terms: { version: string; accepted: boolean; accepted_at: string | null };
  card: { brand: string | null; last4: string } | null;
}
interface Rules {
  enabled: boolean;
  methods: Record<Method, boolean>;
  feePercent: number;
  feeMinCents: number;
  maxCents: number;
  monthMaxCents: number;
  walletMaxCents: number;
  cardNeedsPlan: boolean;
}
interface Purchase {
  id: string;
  store: string;
  title: string;
  url: string | null;
  method: Method;
  store_cents: number;
  fee_cents: number;
  total_cents: number;
  status: string;
  order_ref: string | null;
  tracking: string | null;
  error: string | null;
  invoice_url: string | null;
  created_at: string;
}
interface Data {
  rules: Rules;
  profile: BuyerProfile;
  stores: { id: string; name: string; connected: boolean; updated_at: string | null }[];
  wallet: { balance: number; held: number };
  statement: { kind: string; delta_cents: number; note: string | null; created_at: string }[];
  purchases: Purchase[];
}

const reais = (cents: number) => brl(cents / 100);
const STATUS: Record<string, [string, string]> = {
  awaiting_person: ["Esperando seu Pix", "warn"],
  charging: ["Esperando o cartão", "warn"],
  charged: ["Finalizando na loja", "warn"],
  approved: ["Finalizando na loja", "warn"],
  paying_store: ["Pagando a loja", "warn"],
  paid: ["Pago na loja", "ok"],
  delivered: ["Entregue", "ok"],
  failed: ["Não deu certo", "err"],
  refunded: ["Estornado", "err"],
  canceled: ["Cancelado", ""],
};
const METHOD: Record<Method, string> = { pix: "Pix direto", card: "Cartão", wallet: "Saldo" };
const LEDGER: Record<string, string> = { recarga: "Recarga por Pix", reserva: "Compra", devolucao: "Devolução", compra: "Compra concluída", ajuste: "Ajuste" };
const dateBR = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });

/**
 * Compras pelo assistente: o que falta para comprar (termos, dados, loja, cartão, saldo), a explicação animada,
 * as lojas conectadas, o saldo e o histórico. O dono vê também a explicação do lado dele e o atalho para as regras.
 */
export function ComprasPage({ isSuper }: { isSuper?: boolean }) {
  const { data, error, reload } = useApi<Data>("/api/compras");
  const [view, setView] = useState<"cliente" | "dono">(isSuper ? "dono" : "cliente");
  const [login, setLogin] = useState<string | null>(null);
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

  const needCard = rules.methods.card;
  const anyStore = data.stores.some((s) => s.connected);
  const steps: { done: boolean; label: string; href: string }[] = [
    { done: profile.terms.accepted, label: "Aceitar os Termos de compra", href: "#cp-termos" },
    { done: anyStore, label: "Conectar sua conta numa loja", href: "#cp-lojas" },
    ...(rules.methods.card || rules.methods.wallet ? [{ done: profile.filled, label: "Preencher CPF, nascimento e endereço", href: "#cp-dados" }] : []),
  ];
  const ready = steps.every((s) => s.done);

  return (
    <div className="page cp-page">
      <PageHead title="Compras" subtitle='Mande no WhatsApp: "compra pra mim um fone JBL no Mercado Livre". O assistente acha, monta o carrinho e só paga depois do seu sim.' />

      {isSuper && off && (
        <div className="card card-pad cp-note">
          <Icon name="settings" size={16} /> As compras estão desligadas para todo mundo. Ligue e escolha os jeitos de pagar em <Link to="/settings#compras">Configurações &gt; Compras</Link>.
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
          Limite de {reais(rules.maxCents)} por compra e {reais(rules.monthMaxCents)} em 30 dias.
          {(rules.methods.card || rules.methods.wallet) && ` No cartão e no saldo há taxa de serviço de ${rules.feePercent}% (mínimo ${reais(rules.feeMinCents)}); o Pix direto não tem taxa.`}
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
        <ComoFuncionaCompras audience={view} methods={isSuper && view === "dono" ? { pix: true, card: true, wallet: true } : rules.methods} />
      </section>

      <div className="cp-grid">
        <section id="cp-lojas" className="card card-pad">
          <h3 className="cp-h"><Icon name="shop" size={16} /> Suas lojas</h3>
          <p className="muted cp-small">Você entra na sua conta numa janela daqui; senha e código vão direto para a loja, sem passar pelo assistente. Guardamos só o login, criptografado.</p>
          <ul className="cp-stores">
            {data.stores.map((s) => (
              <li key={s.id}>
                <span>
                  <strong>{s.name}</strong>
                  <small>{s.connected ? `conectada${s.updated_at ? ` em ${dateBR(s.updated_at)}` : ""}` : "não conectada"}</small>
                </span>
                {s.connected ? (
                  <span className="cp-row-actions">
                    <button className="btn btn-sm btn-ghost" onClick={() => setLogin(s.id)}>Entrar de novo</button>
                    <button
                      className="btn btn-sm"
                      onClick={async () => {
                        if (!(await confirmDialog({ title: `Desconectar ${s.name}?`, body: "O assistente para de entrar na sua conta. Dá para conectar de novo quando quiser.", confirmLabel: "Desconectar", danger: true }))) return;
                        await api(`/api/compras/lojas/${s.id}`, { method: "DELETE" });
                        reload();
                      }}
                    >
                      Desconectar
                    </button>
                  </span>
                ) : (
                  <button className="btn btn-sm btn-primary" onClick={() => setLogin(s.id)}>Conectar</button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section id="cp-termos" className="card card-pad">
          <ComprasPoliticaResumo />
          {profile.terms.accepted ? (
            <p className="cp-ok"><Icon name="check" size={14} /> Você aceitou em {dateBR(profile.terms.accepted_at!)}</p>
          ) : (
            <AcceptTerms onDone={reload} />
          )}
        </section>

        {(rules.methods.card || rules.methods.wallet || profile.filled) && (
          <section id="cp-dados" className="card card-pad cp-wide">
            <h3 className="cp-h"><Icon name="user" size={16} /> Seus dados de compra</h3>
            <p className="muted cp-small">O Asaas pede CPF e nascimento para cobrar no cartão e para o saldo. O endereço é onde o assistente manda entregar. Fica criptografado e só vai para o Asaas e para a loja.</p>
            <BuyerForm profile={profile} onSaved={reload} />
          </section>
        )}

        {needCard && (
          <section className="card card-pad">
            <h3 className="cp-h"><Icon name="card" size={16} /> Cartão</h3>
            {profile.card ? (
              <div className="cp-card-row">
                <span>{profile.card.brand ?? "Cartão"} final <strong>{profile.card.last4}</strong></span>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={async () => {
                    await api("/api/compras/cartao", { method: "DELETE" });
                    reload();
                  }}
                >
                  Tirar
                </button>
              </div>
            ) : (
              <p className="muted cp-small">Na primeira compra no cartão você recebe um link seguro do Asaas para digitar o cartão. Depois ele fica salvo lá (aqui guardamos só o final).</p>
            )}
            {rules.cardNeedsPlan && <p className="muted cp-small">Compra no cartão é para quem já pagou um plano.</p>}
          </section>
        )}

        {rules.methods.wallet && <WalletCard data={data} onChange={reload} />}

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
                        {dateBR(p.created_at)} · {data.stores.find((s) => s.id === p.store)?.name ?? p.store} · {METHOD[p.method]}
                        {p.order_ref ? ` · pedido ${p.order_ref}` : ""}
                        {p.tracking ? ` · rastreio ${p.tracking}` : ""}
                      </small>
                      {p.error && ["failed", "refunded", "canceled"].includes(p.status) && <small className="cp-err">{p.error}</small>}
                    </div>
                    <div className="cp-list-side">
                      <strong>{reais(p.total_cents)}</strong>
                      <span className={`badge${tone ? ` badge-${tone}` : ""}`}>{label}</span>
                      {p.status === "charging" && p.invoice_url && <a className="btn btn-sm" href={p.invoice_url} target="_blank" rel="noreferrer">Pagar no cartão</a>}
                      {p.status === "paid" && (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={async () => {
                            await api(`/api/compras/${p.id}`, { method: "PATCH", json: { status: "delivered" } });
                            reload();
                          }}
                        >
                          Chegou
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

      {login && (
        <StoreLogin
          store={login}
          name={data.stores.find((s) => s.id === login)?.name ?? login}
          onClose={(ok) => {
            setLogin(null);
            if (ok) reload();
          }}
        />
      )}
    </div>
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
const cpfMask = (v: string) =>
  v
    .replace(/\D/g, "")
    .slice(0, 11)
    .replace(/^(\d{3})(\d)/, "$1.$2")
    .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1-$2");

/** Nome, CPF, nascimento e endereço de entrega. O CEP preenche rua, bairro e cidade. Usado aqui e no cadastro. */
export function BuyerForm({ profile, onSaved, compact }: { profile: BuyerProfile | null; onSaved: () => void; compact?: boolean }) {
  const [f, setF] = useState({
    full_name: profile?.full_name ?? "",
    cpf: "",
    birth_date: profile?.birth_date ?? "",
    cep: profile?.address?.cep ? cepMask(profile.address.cep) : "",
    street: profile?.address?.street ?? "",
    number: profile?.address?.number ?? "",
    complement: profile?.address?.complement ?? "",
    district: profile?.address?.district ?? "",
    city: profile?.address?.city ?? "",
    state: profile?.address?.state ?? "",
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
      await api("/api/compras/perfil", {
        method: "PUT",
        json: {
          full_name: f.full_name,
          cpf: f.cpf,
          birth_date: f.birth_date,
          address: { cep: f.cep, street: f.street, number: f.number, complement: f.complement, district: f.district, city: f.city, state: f.state },
        },
      });
      setSaved(true);
      setF((x) => ({ ...x, cpf: "" }));
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={`cp-form ${compact ? "compact" : ""}`} onSubmit={submit}>
      <div className="field cp-span2">
        <label>Nome completo</label>
        <input className="input" autoComplete="name" value={f.full_name} onChange={set("full_name")} required />
      </div>
      <div className="field">
        <label>CPF</label>
        <input
          className="input"
          inputMode="numeric"
          placeholder={profile?.cpf_end ? `final ${profile.cpf_end} (digite para trocar)` : "000.000.000-00"}
          value={f.cpf}
          onChange={(e) => setF((x) => ({ ...x, cpf: cpfMask(e.target.value) }))}
          required={!profile?.cpf_end}
        />
      </div>
      <div className="field">
        <label>Nascimento</label>
        <input className="input" type="date" autoComplete="bday" value={f.birth_date} onChange={set("birth_date")} required />
      </div>
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
        <button className="btn btn-primary" disabled={busy}>{busy ? "Salvando…" : "Salvar dados"}</button>
      </div>
    </form>
  );
}

function WalletCard({ data, onChange }: { data: Data; onChange: () => void }) {
  const [value, setValue] = useState("50");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const top = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ invoice_url: string | null }>("/api/compras/recarga", { method: "POST", json: { cents: Math.round(Number(value.replace(",", ".")) * 100) } });
      if (r.invoice_url) window.open(r.invoice_url, "_blank", "noopener");
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card card-pad">
      <h3 className="cp-h"><Icon name="wallet" size={16} /> Saldo para compras</h3>
      <p className="cp-balance">{reais(data.wallet.balance)}</p>
      {data.wallet.held > 0 && <p className="muted cp-small">{reais(data.wallet.held)} reservados numa compra em andamento.</p>}
      <div className="cp-topup">
        <span className="cp-prefix">R$</span>
        <input className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Valor da recarga" />
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={top}>Carregar por Pix</button>
      </div>
      {err && <p className="cp-err">{err}</p>}
      <p className="muted cp-small">Só por Pix, cai na hora. Saldo máximo de {reais(data.rules.walletMaxCents)}.</p>
      {data.statement.length > 0 && (
        <ul className="cp-ledger">
          {data.statement.slice(0, 8).map((e, i) => (
            <li key={i}>
              <span>{LEDGER[e.kind] ?? e.kind}{e.note ? ` · ${e.note}` : ""}</span>
              <span className={e.delta_cents >= 0 ? "pos" : "neg"}>{e.delta_cents === 0 ? "-" : `${e.delta_cents > 0 ? "+" : ""}${reais(e.delta_cents)}`}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
      icon="shop"
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
