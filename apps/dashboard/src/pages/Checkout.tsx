import { type FormEvent, useEffect, useState } from "react";
import { api, brl } from "../api";
import { Icon } from "../icons";
import "../checkout.css";

/**
 * Nosso checkout, no lugar da página do Asaas. Duas entradas:
 * - /pagar/plano/<id> e /pagar/pacote/<id> (logado): escolhe como pagar, cria a cobrança e segue aqui mesmo;
 * - /pagar/<token> (sem login): uma cobrança que já existe (mensalidade, pacote, troca de plano), o link do WhatsApp.
 * Pix mostra o QR e o copia e cola e confere sozinho até cair; cartão paga na hora; boleto mostra a linha e o PDF.
 * Notebook: resumo à esquerda e pagamento à direita num cartão só. Celular: uma coluna, resumo curto em cima.
 */

type Method = "pix" | "card" | "boleto";

interface Summary {
  kind: "plan" | "pack" | "upgrade";
  title: string;
  value: number;
  fullPrice?: number;
  discount?: number;
  grains: number;
  recurring: boolean;
  autoRenew?: boolean;
  perks: string[];
  dueDate?: string | null;
  overdue?: boolean;
  paid?: boolean;
  open?: boolean;
  analysis?: boolean;
  status?: string;
  needsEmail?: boolean;
  firstName?: string | null;
}
interface NewItem extends Summary {
  id: string;
  ready: boolean;
  needsDoc: boolean;
  name: string;
  email: string;
  savedCard: { brand: string | null; last4: string } | null;
}
interface Pix {
  paid?: boolean;
  image: string | null;
  code: string;
  expiresAt: string | null;
}
interface Boleto {
  paid?: boolean;
  line: string;
  pdf: string | null;
  dueDate: string | null;
}

const nf = new Intl.NumberFormat("pt-BR");
const ddmm = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").slice(1).reverse().join("/") : "");
const digits = (v: string) => v.replace(/\D/g, "");

/** 000.000.000-00 ou 00.000.000/0000-00 enquanto digita. */
export function maskDoc(v: string) {
  const d = digits(v).slice(0, 14);
  if (d.length <= 11) return d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  return d.replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d{1,2})$/, "$1-$2");
}

/** Bandeira pelo começo do número (só para mostrar; quem decide é o Asaas). */
export function brandOf(n: string) {
  const d = digits(n);
  if (/^(4011|4312|4389|4514|4576|5041|5066|5067|509|6277|6362|6363|650|6516|6550)/.test(d)) return "Elo";
  if (/^(606282|3841)/.test(d)) return "Hipercard";
  if (/^3[47]/.test(d)) return "Amex";
  if (/^4/.test(d)) return "Visa";
  if (/^(5[1-5]|2[2-7])/.test(d)) return "Mastercard";
  return "";
}

const maskCard = (v: string) => {
  const d = digits(v).slice(0, 19);
  if (/^3[47]/.test(d)) return d.replace(/^(\d{4})(\d{0,6})(\d{0,5}).*/, (_, a, b, c) => [a, b, c].filter(Boolean).join(" "));
  return d.replace(/(\d{4})(?=\d)/g, "$1 ");
};
const maskExpiry = (v: string) => {
  const d = digits(v).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};
const maskCep = (v: string) => digits(v).slice(0, 8).replace(/^(\d{5})(\d)/, "$1-$2");

/** Copia e mostra "Copiado" por um instante. */
function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement("textarea");
      t.value = text;
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1800);
  };
  return (
    <button type="button" className={`co-copy${done ? " done" : ""}`} onClick={copy}>
      <Icon name={done ? "check" : "copy"} size={16} />
      {done ? "Copiado" : label}
    </button>
  );
}

export function CheckoutPage({ token: initialToken, kind, id }: { token?: string; kind?: "plan" | "pack"; id?: string }) {
  const [token, setToken] = useState<string | null>(initialToken ?? null);
  const [item, setItem] = useState<NewItem | null>(null);
  const [view, setView] = useState<Summary | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>("pix");
  const [pix, setPix] = useState<Pix | null>(null);
  const [boleto, setBoleto] = useState<Boleto | null>(null);
  const [paid, setPaid] = useState(false);
  const [analysis, setAnalysis] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // dados de quem paga (só na primeira compra, o Asaas pede nome e CPF)
  const [name, setName] = useState("");
  const [doc, setDoc] = useState("");
  const [useSaved, setUseSaved] = useState(false);
  const [card, setCard] = useState({ number: "", holderName: "", expiry: "", ccv: "", cpfCnpj: "", postalCode: "", addressNumber: "", email: "" });
  const logged = Boolean(kind);

  // carrega o item novo (logado) ou a cobrança (token)
  useEffect(() => {
    let off = false;
    const run = async () => {
      try {
        if (token) {
          const v = await api<Summary>(`/api/pay/${encodeURIComponent(token)}`);
          if (off) return;
          setView(v);
          setPaid(Boolean(v.paid));
          setAnalysis(Boolean(v.analysis));
        } else if (kind && id) {
          const it = await api<NewItem>(`/api/checkout/item?kind=${kind}&id=${encodeURIComponent(id)}`);
          if (off) return;
          setItem(it);
          setName(it.name);
          setUseSaved(Boolean(it.savedCard));
          if (it.savedCard) setMethod("card");
        }
      } catch (e) {
        if (!off) setLoadErr((e as Error).message);
      }
    };
    void run();
    return () => {
      off = true;
    };
    // o token novo (depois de criar a cobrança) já chega com o resumo certo; não recarrega
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, id]);

  const summary: Summary | null = view ?? item;
  const waiting = !paid && ((method === "pix" && pix) || (method === "boleto" && boleto));

  // esperando o Pix ou o boleto: confere de tempos em tempos (só com a aba visível)
  useEffect(() => {
    if (!token || paid) return;
    if (!waiting && !analysis) return;
    const t = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const s = await api<{ paid: boolean }>(`/api/pay/${encodeURIComponent(token)}/status`);
        if (s.paid) setPaid(true);
      } catch {
        /* tenta na próxima */
      }
    }, 4000);
    return () => clearInterval(t);
  }, [token, waiting, analysis, paid]);

  const needsDoc = Boolean(item?.needsDoc);
  const checkDoc = () => {
    if (!needsDoc) return true;
    if (name.trim().split(/\s+/).length < 2) return setErr("Escreva seu nome completo."), false;
    if (digits(doc).length !== 11 && digits(doc).length !== 14) return setErr("Confira o CPF ou CNPJ."), false;
    return true;
  };

  /** Cria a cobrança (entrada logada) e passa a usar o token dela, como se tivesse aberto pelo link. */
  const start = async (m: Method, extra: Record<string, unknown> = {}) => {
    const r = await api<{ paid: boolean; token: string | null }>("/api/checkout/start", {
      method: "POST",
      json: { kind, id, method: m === "card" ? "card" : "pix", ...(needsDoc ? { name, cpfCnpj: doc } : {}), ...extra },
    });
    if (r.token) {
      setToken(r.token);
      // recarregar a página abre a mesma cobrança
      try {
        history.replaceState(history.state, "", `/pagar/${r.token}`);
      } catch {
        /* sem history */
      }
    }
    return r;
  };

  const generate = async (m: "pix" | "boleto") => {
    setErr(null);
    if (!token && !checkDoc()) return;
    setBusy(true);
    try {
      let t = token;
      if (!t) {
        const r = await start(m);
        t = r.token;
        if (!t) throw new Error("A cobrança foi criada, mas não consegui abrir agora. Veja em Meu plano.");
      }
      const r = await api<Pix & Boleto>(`/api/pay/${encodeURIComponent(t)}/${m}`, { method: "POST" });
      if (r.paid) setPaid(true);
      else if (m === "pix") setPix(r);
      else setBoleto(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const payCard = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!useSaved && !checkDoc()) return;
    setBusy(true);
    try {
      const data = { ...card, cpfCnpj: needsDoc && !card.cpfCnpj ? doc : card.cpfCnpj };
      let ok: boolean;
      if (token && kind !== "plan") {
        // cobrança que já existe (link, ou pacote criado aqui antes): paga direto nela
        ok = (await api<{ paid: boolean }>(`/api/pay/${encodeURIComponent(token)}/card`, { method: "POST", json: data })).paid;
      } else {
        ok = (await start("card", useSaved ? { savedCard: true } : { card: data })).paid;
      }
      if (ok) setPaid(true);
      else setAnalysis(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = (m: Method) => {
    setErr(null);
    setMethod(m);
  };

  const back = () => {
    if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
    else location.href = logged ? "/plano" : "/";
  };

  if (loadErr)
    return (
      <div className="co-page">
        <div className="co-card co-card-small">
          <span className="co-ico-big co-ico-warn"><Icon name="receipt" size={26} /></span>
          <h1>Não deu para abrir o pagamento</h1>
          <p className="co-muted">{loadErr}</p>
          <a className="co-btn" href={logged ? "/plano" : "/"}>{logged ? "Voltar para Meu plano" : "Abrir o Planejai"}</a>
        </div>
      </div>
    );

  if (!summary)
    return (
      <div className="co-page">
        <div className="co-card co-loading" aria-busy="true" />
      </div>
    );

  const total = summary.value;
  const brand = brandOf(card.number);
  const closed = Boolean(view && !view.open && !paid && !analysis);
  const done = paid || closed;

  return (
    <div className="co-page">
      <header className="co-top">
        <button type="button" className="co-back" onClick={back}>
          <Icon name="chevron-left" size={18} />
          Voltar
        </button>
        <span className="co-brand">Planejai</span>
        <span className="co-safe">
          <Icon name="shield" size={15} />
          Pagamento seguro
        </span>
      </header>

      <main className="co-card">
        <section className="co-summary" aria-label="Resumo">
          <p className="co-kicker">{view?.firstName ? `${view.firstName}, você está pagando` : "Você está pagando"}</p>
          <h1>{summary.title}</h1>
          <p className="co-price">
            {summary.discount ? <s>{brl(summary.fullPrice)}</s> : null}
            <b>{brl(total)}</b>
            {summary.recurring && <span>por mês</span>}
          </p>
          {summary.discount ? <p className="co-tag">{summary.discount}% de desconto por indicação</p> : null}
          {summary.dueDate && !paid && (
            <p className={`co-due${summary.overdue ? " late" : ""}`}>{summary.overdue ? `Venceu em ${ddmm(summary.dueDate)}` : `Vence em ${ddmm(summary.dueDate)}`}</p>
          )}
          {summary.perks.length > 0 && (
            <ul className="co-perks">
              {summary.perks.map((p) => (
                <li key={p}>
                  <Icon name="check" size={16} />
                  {p}
                </li>
              ))}
            </ul>
          )}
          <dl className="co-total">
            <div>
              <dt>{summary.recurring ? "Hoje" : "Total"}</dt>
              <dd>{brl(total)}</dd>
            </div>
            {summary.recurring && (
              <div>
                <dt>Depois</dt>
                <dd>{brl(total)} todo mês</dd>
              </div>
            )}
          </dl>
          <p className="co-foot">Cobrança processada pelo Asaas. Os dados do cartão vão direto para lá e não ficam guardados no Planejai.</p>
        </section>

        <section className="co-pay" aria-label="Pagamento">
          {done ? (
            <div className="co-done" role="status">
              <span className={`co-ico-big${paid ? " co-ico-ok" : ""}`}><Icon name={paid ? "check" : "receipt"} size={28} /></span>
              <h2>{paid ? "Pagamento confirmado" : view?.status || "Cobrança fechada"}</h2>
              <p className="co-muted">
                {paid
                  ? summary.kind === "upgrade"
                    ? `Plano trocado. Entraram ${nf.format(summary.grains)} grãos a mais neste mês.`
                    : summary.kind === "plan"
                      ? `Seu plano está ativo e ${nf.format(summary.grains)} grãos já estão na sua conta. Também te avisei no WhatsApp.`
                      : `Entraram ${nf.format(summary.grains)} grãos na sua conta. Pode mandar o que precisar.`
                  : "Essa cobrança não está mais em aberto."}
              </p>
              <a className="co-btn" href="/plano">Ir para Meu plano</a>
            </div>
          ) : analysis ? (
            <div className="co-done" role="status">
              <span className="co-ico-big"><Icon name="clock" size={28} /></span>
              <h2>Cartão em análise</h2>
              <p className="co-muted">O Asaas está conferindo o pagamento. Assim que aprovar, os grãos entram e eu te aviso no WhatsApp. Pode fechar esta tela.</p>
              <span className="co-live"><i />Conferindo</span>
            </div>
          ) : (
            <>
              <h2>Como quer pagar?</h2>
              {item && !item.ready && <p className="co-note">A cobrança ainda está sendo configurada. Tente de novo mais tarde.</p>}
              <div className="co-methods" role="tablist" aria-label="Forma de pagamento">
                {(
                  [
                    ["pix", "Pix", "pix"],
                    ["card", "Cartão", "card"],
                    ["boleto", "Boleto", "receipt"],
                  ] as const
                ).map(([m, label, icon]) => (
                  <button key={m} type="button" role="tab" aria-selected={method === m} className={method === m ? "on" : ""} onClick={() => pick(m)}>
                    <Icon name={icon} size={18} />
                    {label}
                  </button>
                ))}
              </div>

              {needsDoc && !token && !(method === "card" && useSaved) && (
                <fieldset className="co-fields co-who">
                  <legend>Seus dados</legend>
                  <label className="co-field wide">
                    <span>Nome completo</span>
                    <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Como no documento" />
                  </label>
                  <label className="co-field wide">
                    <span>CPF ou CNPJ</span>
                    <input inputMode="numeric" autoComplete="off" value={doc} onChange={(e) => setDoc(maskDoc(e.target.value))} placeholder="000.000.000-00" />
                  </label>
                  <p className="co-hint wide">O Asaas pede para emitir a cobrança. Não fica guardado no Planejai.</p>
                </fieldset>
              )}

              {method === "pix" &&
                (pix ? (
                  <div className="co-pix">
                    <div className="co-qr">{pix.image ? <img src={pix.image} alt="QR Code do Pix" width={208} height={208} /> : <Icon name="pix" size={40} />}</div>
                    <ol className="co-steps">
                      <li>Abra o app do seu banco e escolha Pix.</li>
                      <li>Leia o QR Code ou use o copia e cola.</li>
                    </ol>
                    <div className="co-code">
                      <code>{pix.code}</code>
                      <CopyButton text={pix.code} label="Copiar código" />
                    </div>
                    <span className="co-live"><i />Esperando o pagamento. Esta tela atualiza sozinha.</span>
                  </div>
                ) : (
                  <div className="co-intro">
                    <p>Pague em segundos pelo app do banco. Os grãos entram assim que o Pix cair.</p>
                    <button type="button" className="co-btn" disabled={busy || item?.ready === false} onClick={() => generate("pix")}>
                      {busy ? "Gerando o Pix…" : `Gerar Pix de ${brl(total)}`}
                    </button>
                  </div>
                ))}

              {method === "boleto" &&
                (boleto ? (
                  <div className="co-boleto">
                    <p className="co-label">Linha digitável</p>
                    <div className="co-code">
                      <code>{boleto.line}</code>
                      <CopyButton text={digits(boleto.line)} />
                    </div>
                    {boleto.pdf && (
                      <a className="co-btn co-btn-ghost" href={boleto.pdf} target="_blank" rel="noopener noreferrer">
                        <Icon name="download" size={16} />
                        Baixar o boleto
                      </a>
                    )}
                    <p className="co-hint">{boleto.dueDate ? `Vence em ${ddmm(boleto.dueDate)}. ` : ""}O banco leva até 2 dias úteis para avisar; os grãos entram quando cair.</p>
                    <span className="co-live"><i />Esperando o pagamento</span>
                  </div>
                ) : (
                  <div className="co-intro">
                    <p>Pague no app do banco ou na lotérica. Compensa em até 2 dias úteis.</p>
                    <button type="button" className="co-btn" disabled={busy || item?.ready === false} onClick={() => generate("boleto")}>
                      {busy ? "Gerando o boleto…" : "Gerar boleto"}
                    </button>
                  </div>
                ))}

              {method === "card" && (
                <form className="co-cardform" onSubmit={payCard}>
                  {item?.savedCard && (
                    <div className="co-saved" role="radiogroup" aria-label="Cartão">
                      <label className={useSaved ? "on" : ""}>
                        <input type="radio" name="co-saved" checked={useSaved} onChange={() => setUseSaved(true)} />
                        <span>
                          <b>{item.savedCard.brand ?? "Cartão"} final {item.savedCard.last4}</b>
                          <small>O mesmo do seu plano. Cobra agora.</small>
                        </span>
                      </label>
                      <label className={!useSaved ? "on" : ""}>
                        <input type="radio" name="co-saved" checked={!useSaved} onChange={() => setUseSaved(false)} />
                        <span>
                          <b>Outro cartão</b>
                        </span>
                      </label>
                    </div>
                  )}
                  {!useSaved && (
                    <div className="co-fields">
                      <label className="co-field wide">
                        <span>Número do cartão</span>
                        <div className="co-input-brand">
                          <input
                            inputMode="numeric"
                            autoComplete="cc-number"
                            value={card.number}
                            onChange={(e) => setCard({ ...card, number: maskCard(e.target.value) })}
                            placeholder="0000 0000 0000 0000"
                            required
                          />
                          {brand && <em>{brand}</em>}
                        </div>
                      </label>
                      <label className="co-field wide">
                        <span>Nome impresso no cartão</span>
                        <input autoComplete="cc-name" value={card.holderName} onChange={(e) => setCard({ ...card, holderName: e.target.value })} placeholder="Como está no cartão" required />
                      </label>
                      <label className="co-field">
                        <span>Validade</span>
                        <input inputMode="numeric" autoComplete="cc-exp" value={card.expiry} onChange={(e) => setCard({ ...card, expiry: maskExpiry(e.target.value) })} placeholder="MM/AA" required />
                      </label>
                      <label className="co-field">
                        <span>CVV</span>
                        <input inputMode="numeric" autoComplete="cc-csc" value={card.ccv} onChange={(e) => setCard({ ...card, ccv: digits(e.target.value).slice(0, 4) })} placeholder="123" required />
                      </label>
                      {!needsDoc && (
                        <label className="co-field wide">
                          <span>CPF ou CNPJ do titular</span>
                          <input inputMode="numeric" autoComplete="off" value={card.cpfCnpj} onChange={(e) => setCard({ ...card, cpfCnpj: maskDoc(e.target.value) })} placeholder="000.000.000-00" required />
                        </label>
                      )}
                      <label className="co-field">
                        <span>CEP do titular</span>
                        <input inputMode="numeric" autoComplete="postal-code" value={card.postalCode} onChange={(e) => setCard({ ...card, postalCode: maskCep(e.target.value) })} placeholder="00000-000" required />
                      </label>
                      <label className="co-field">
                        <span>Número</span>
                        <input autoComplete="off" value={card.addressNumber} onChange={(e) => setCard({ ...card, addressNumber: e.target.value.slice(0, 10) })} placeholder="123" required />
                      </label>
                      {(view?.needsEmail || (item && !item.email)) && (
                        <label className="co-field wide">
                          <span>E-mail</span>
                          <input type="email" autoComplete="email" value={card.email} onChange={(e) => setCard({ ...card, email: e.target.value })} required />
                        </label>
                      )}
                    </div>
                  )}
                  {summary.recurring &&
                    (kind === "plan" || view?.autoRenew ? (
                      <p className="co-hint">Renova sozinho todo mês neste cartão. Dá para cancelar quando quiser em Meu plano.</p>
                    ) : (
                      <p className="co-hint">Paga esta mensalidade no cartão. As próximas continuam por Pix ou boleto.</p>
                    ))}
                  <button className="co-btn" disabled={busy || item?.ready === false}>
                    <Icon name="shield" size={16} />
                    {busy ? "Confirmando com o banco…" : `Pagar ${brl(total)}`}
                  </button>
                </form>
              )}

              {err && <p className="co-err" role="alert">{err}</p>}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default CheckoutPage;
