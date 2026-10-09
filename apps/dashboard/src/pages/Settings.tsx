import { type ReactNode, useEffect, useState } from "react";
import { api, brl, phoneFmt } from "../api";
import { CopyField, ErrorBox, Loading, PageHead } from "../components";
import { Icon } from "../icons";
import { useApi } from "../hooks";

const BILL_STATE: Record<string, string> = { plan: "com plano", free: "nos grãos grátis", empty: "sem grãos", exempt: "liberado" };
const nf = new Intl.NumberFormat("pt-BR");

/** Grãos e planos pelo Asaas: ligar, vitrine (planos e pacotes), regras, webhook e a situação de cada pessoa. */
function BillingSection({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  const { data, reload } = useApi<any>("/api/billing/admin");
  const exempt = async (id: string, value: boolean) => {
    await api(`/api/billing/people/${id}`, { method: "PATCH", json: { exempt: value } });
    await reload();
  };
  const gift = async (id: string, name: string) => {
    const raw = window.prompt(`Quantos grãos de presente para ${name}?`, "500");
    const amount = Math.round(Number(raw));
    if (!raw || !(amount > 0)) return;
    await api(`/api/billing/people/${id}/grains`, { method: "POST", json: { amount, note: "Presente do responsável" } });
    await reload();
  };
  const plans: any[] = form.billingPlans ?? [];
  const packs: any[] = form.billingPacks ?? [];
  const setPlan = (i: number, patch: any) => setForm({ ...form, billingPlans: plans.map((p, j) => (j === i ? { ...p, ...patch } : patch.highlight ? { ...p, highlight: false } : p)) });
  const setPack = (i: number, patch: any) => setForm({ ...form, billingPacks: packs.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const n = (v: string) => (v === "" ? "" : Number(v));
  const numField = (key: string, label: string, help: string, max?: number) => (
    <div className="field">
      <label>{label}</label>
      <input className="input" type="number" inputMode="numeric" step={1} min={0} max={max} value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: n(e.target.value) })} />
      <div className="help">{help}</div>
    </div>
  );
  return (
    <Section id="graos" icon="card" title="Grãos e planos" desc="Cada resposta gasta grãos pelo custo real da IA. A pessoa ganha grãos de boas-vindas, depois assina um plano (recarrega todo mês) ou compra pacotes. Sem grãos, o assistente avisa uma vez por dia e para. Donos nunca gastam.">
      <label className="set-switch">
        <input type="checkbox" checked={!!form.billingEnabled} onChange={(e) => setForm({ ...form, billingEnabled: e.target.checked })} />
        <span>
          <strong>Cobrar por grãos</strong>
          <small>
            {data?.connected ? (data.mode === "sandbox" ? <><b>Asaas em sandbox:</b> ninguém é cobrado de verdade. Troque por uma chave $aact_prod_ em Conexões &gt; Integrações &gt; Asaas.</> : "Asaas conectado (produção).") : "Antes de ligar, cole a chave de API e o token do webhook em Conexões > Integrações > Asaas."} Ao ligar, cada pessoa ganha os grãos de boas-vindas na primeira mensagem.
          </small>
        </span>
      </label>
      <h4 className="set-sub">Planos por mês</h4>
      <div className="set-plans">
        {plans.length > 0 && <div className="set-plan set-plan-head" aria-hidden="true"><span>Nome</span><span>R$ por mês</span><span>Grãos por mês</span><span>Para quem é</span><span>Destaque</span><span /></div>}
        {plans.map((p, i) => (
          <div key={i} className="set-plan">
            <input className="input" aria-label="Nome do plano" value={p.name ?? ""} onChange={(e) => setPlan(i, { name: e.target.value })} />
            <input className="input" aria-label="Preço por mês (R$)" type="number" inputMode="decimal" step={0.1} min={1} value={p.price ?? ""} onChange={(e) => setPlan(i, { price: n(e.target.value) })} />
            <input className="input" aria-label="Grãos por mês" type="number" inputMode="numeric" step={100} min={1} value={p.grains ?? ""} onChange={(e) => setPlan(i, { grains: n(e.target.value) })} />
            <input className="input set-plan-blurb" aria-label="Para quem é" placeholder="Para quem é" value={p.blurb ?? ""} onChange={(e) => setPlan(i, { blurb: e.target.value })} />
            <label className="set-plan-hl" title="Plano em destaque na vitrine"><input type="radio" name="plan-hl" aria-label="Plano em destaque" checked={!!p.highlight} onChange={() => setPlan(i, { highlight: true })} /></label>
            {plans.length > 1 ? <button className="btn btn-sm btn-ghost" onClick={() => setForm({ ...form, billingPlans: plans.filter((_, j) => j !== i) })}>Tirar</button> : <span />}
          </div>
        ))}
        {plans.length < 4 && <button className="btn btn-sm" onClick={() => setForm({ ...form, billingPlans: [...plans, { name: "", price: 29.9, grains: 3000, blurb: "" }] })}>Adicionar plano</button>}
        <div className="help">Nome, R$ por mês e grãos por mês. Mudar o preço vale para quem assinar depois; quem já assina é ajustado na próxima troca.</div>
      </div>
      <h4 className="set-sub">Pacotes avulsos</h4>
      <div className="set-plans">
        {packs.length > 0 && <div className="set-plan set-pack set-plan-head" aria-hidden="true"><span>Grãos</span><span>Preço (R$)</span><span /></div>}
        {packs.map((p, i) => (
          <div key={i} className="set-plan set-pack">
            <input className="input" aria-label="Grãos" type="number" inputMode="numeric" step={100} min={1} value={p.grains ?? ""} onChange={(e) => setPack(i, { grains: n(e.target.value), id: "" })} />
            <input className="input" aria-label="Preço (R$)" type="number" inputMode="decimal" step={0.1} min={1} value={p.price ?? ""} onChange={(e) => setPack(i, { price: n(e.target.value) })} />
            <button className="btn btn-sm btn-ghost" onClick={() => setForm({ ...form, billingPacks: packs.filter((_, j) => j !== i) })}>Tirar</button>
          </div>
        ))}
        {packs.length < 4 && <button className="btn btn-sm" onClick={() => setForm({ ...form, billingPacks: [...packs, { grains: 1000, price: 19.9 }] })}>Adicionar pacote</button>}
        <div className="help">Grãos e preço. Deixe o grão do pacote mais caro que o do plano, para valer a pena assinar.</div>
      </div>
      <h4 className="set-sub">Regras</h4>
      <div className="set-fields">
        {numField("billingWelcomeGrains", "Grãos de boas-vindas", "Uma vez por pessoa.")}
        {numField("billingGrainsPerUsd", "Grãos por US$ 1 de IA", "Custo real do OpenRouter. 1.000 = 1 grão a cada US$ 0,001.")}
        {numField("billingReferralStep", "Desconto por amigo pagante (%)", "Na mensalidade de quem convidou. 0 desliga.", 50)}
        {numField("billingReferralMax", "Desconto máximo (%)", "Teto somando todos os amigos.", 90)}
        {numField("billingReminderDays", "Lembrar o vencimento (dias antes)", "Pix ou boleto; cartão renova sozinho.", 10)}
      </div>
      {data?.webhookUrl && (
        <div className="field">
          <label>Webhook para cadastrar no Asaas</label>
          <CopyField value={data.webhookUrl} />
          <div className="help">Asaas &gt; Integrações &gt; Webhooks: eventos de Cobranças e Assinaturas, com o mesmo token que você colou em Conexões.</div>
        </div>
      )}
      {data && (
        <>
          <h4 className="set-sub">Situação de cada pessoa</h4>
          <p className="bill-counts">
            <span><strong>{data.counts.plan ?? 0}</strong> com plano</span>
            <span><strong>{data.counts.free ?? 0}</strong> nos grãos grátis</span>
            <span><strong>{data.counts.empty ?? 0}</strong> sem grãos</span>
            <span><strong>{data.counts.exempt ?? 0}</strong> liberados</span>
            <span><strong>{brl(data.mrr)}</strong> por mês</span>
            <span><strong>{brl(data.packsMonth ?? 0)}</strong> avulsos no mês</span>
          </p>
          <ul className="bill-people">
            {data.people.map((p: any) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <small>{p.owner ? "dono" : `${p.plan ?? BILL_STATE[p.state] ?? p.state}${p.state !== "exempt" ? ` · ${nf.format(p.balance)}` : ""}${p.discount ? ` · -${p.discount}%` : ""}`}</small>
                {!p.owner && <button className="btn btn-sm btn-ghost" onClick={() => gift(p.id, p.name)}>Dar grãos</button>}
                {!p.owner && (
                  <button className="btn btn-sm" onClick={() => exempt(p.id, !p.exempt)}>{p.exempt ? "Voltar a cobrar" : "Liberar"}</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

/**
 * Compras pelo assistente: ligar e os limites. Valores em centavos no servidor, em reais aqui.
 * Desligado por padrão. A pessoa paga o Pix da loja do banco dela: nenhum dinheiro passa pela sua conta.
 */
function PurchasesSection({ form, setForm }: { form: any; setForm: (f: any) => void }) {
  const { data } = useApi<any>("/api/compras/admin");
  const money = (key: string, label: string, help: string) => (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        type="number"
        inputMode="decimal"
        step={0.01}
        min={0}
        value={form[key] === "" || form[key] == null ? "" : Number(form[key]) / 100}
        onChange={(e) => setForm({ ...form, [key]: e.target.value === "" ? "" : Math.round(Number(e.target.value) * 100) })}
      />
      <div className="help">{help}</div>
    </div>
  );
  return (
    <Section id="compras" icon="shop" title="Compras pelo assistente" desc="O agente Compras entra na conta da pessoa na loja, monta o carrinho e chega no Pix do checkout. Depois do sim dela, manda o Pix para ela pagar do banco dela. O valor sai do próprio código Pix, nunca do modelo.">
      <label className="set-switch">
        <input type="checkbox" checked={!!form.purchasesEnabled} onChange={(e) => setForm({ ...form, purchasesEnabled: e.target.checked })} />
        <span>
          <strong>Ligar compras</strong>
          <small>A tela Compras aparece para todo mundo e o agente entra no time. Sem taxa e sem dinheiro passando por você. Veja como funciona em <a href="/compras">Compras</a>.</small>
        </span>
      </label>
      {form.purchasesEnabled && (
        <>
          <h4 className="set-sub">Limites</h4>
          <div className="set-fields">
            {money("purchaseMaxCents", "Limite por compra (R$)", "Valor do Pix da loja, com frete.")}
            {money("purchaseMonthMaxCents", "Limite por pessoa em 30 dias (R$)", "Somando as compras que não foram canceladas.")}
          </div>
          <p className="help">Com o Asaas conectado, o assistente também lê o valor de Pix dinâmico que não traz o valor escrito (só leitura, nada é cobrado).</p>
          {data && (
            <p className="bill-counts">
              <span><strong>{data.month?.paid ?? 0}</strong> compras pagas no mês</span>
              <span><strong>{brl((data.month?.stores_cents ?? 0) / 100)}</strong> pagos às lojas</span>
              <span><strong>{data.month?.waiting ?? 0}</strong> esperando o Pix</span>
              <span><strong>{data.month?.people ?? 0}</strong> pessoas comprando</span>
            </p>
          )}
        </>
      )}
    </Section>
  );
}

/** Uma área das configurações: título e explicação curtos, campos embaixo. */
function Section({ id, icon, title, desc, children }: { id: string; icon: string; title: string; desc: string; children: ReactNode }) {
  return (
    <section id={id} className="card set-section">
      <header className="set-section-head">
        <span className="set-section-ico"><Icon name={icon} size={18} /></span>
        <div>
          <h2>{title}</h2>
          <p>{desc}</p>
        </div>
      </header>
      <div className="set-section-body">{children}</div>
    </section>
  );
}

const SECTIONS = [
  { id: "assistente", icon: "sparkle", label: "Assistente" },
  { id: "travas", icon: "shield", label: "Travas de segurança" },
  { id: "graos", icon: "card", label: "Grãos e planos" },
  { id: "compras", icon: "shop", label: "Compras" },
  { id: "dados", icon: "file", label: "Dados e LGPD" },
  { id: "canal", icon: "phone", label: "WhatsApp e acesso" },
];

export function SettingsPage() {
  const { data, error } = useApi<any>("/api/settings");
  const [form, setForm] = useState<any>(null);
  const [base, setBase] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [active, setActive] = useState(SECTIONS[0]!.id);
  const ready = Boolean(form);
  // menu das áreas acompanha a rolagem
  useEffect(() => {
    if (!ready) return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-10% 0px -60% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ready]);
  useEffect(() => {
    if (data) {
      setForm(data.settings);
      setBase(JSON.stringify(data.settings));
    }
  }, [data]);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data || !form) return <Loading />;

  const dirty = JSON.stringify(form) !== base;
  const save = async () => {
    setSaveErr(null);
    setSaving(true);
    try {
      await api("/api/settings", { method: "PUT", json: form });
      setBase(JSON.stringify(form));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const num = (key: string, label: string, help: string, step = 1) => (
    <div className="field">
      <label>{label}</label>
      <input className="input" type="number" inputMode="decimal" step={step} min={0} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value === "" ? "" : Number(e.target.value) })} />
      <div className="help">{help}</div>
    </div>
  );
  const provider =
    data.channel.provider === "baileys" ? "Conexão própria (Baileys)" : data.channel.provider === "cloud" ? "WhatsApp Cloud API (Meta)" : data.channel.provider === "evolution" ? "Evolution API" : "nenhum";

  return (
    <div className="page settings-page ios-list">
      <PageHead title="Configurações" subtitle="Como o assistente se comporta, os limites de uso, a cobrança e os dados da plataforma. Só os donos veem esta tela." />
      <div className="set-layout">
        <nav className="set-nav" aria-label="Áreas das configurações">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={active === s.id ? "active" : ""} aria-current={active === s.id ? "true" : undefined} onClick={(e) => { e.preventDefault(); setActive(s.id); document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" }); }}>
              <Icon name={s.icon} size={16} /> {s.label}
            </a>
          ))}
        </nav>
        <div className="set-main">
          <Section id="assistente" icon="sparkle" title="Assistente" desc="Nome, fuso e o jeito de falar do assistente, e quem pode criar conta no painel.">
            <div className="set-fields">
              <div className="field"><label>Nome do assistente</label><input className="input" value={form.assistantName} onChange={(e) => setForm({ ...form, assistantName: e.target.value })} /><div className="help">Como ele se apresenta no WhatsApp.</div></div>
              <div className="field"><label>Fuso horário padrão</label><input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /><div className="help">Usado em lembretes de quem ainda não tem fuso. Ex.: America/Sao_Paulo.</div></div>
            </div>
            <div className="field">
              <label>Instruções extras</label>
              <textarea className="textarea" placeholder="Ex.: me chame de Dav, seja mais informal, sempre sugira opções baratas primeiro…" value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} />
              <div className="help">Valem para todas as conversas, somadas às instruções do Juvenal (CTO).</div>
            </div>
            <div className="field">
              <label>Quem pode criar conta</label>
              <select className="select" value={form.signupMode} onChange={(e) => setForm({ ...form, signupMode: e.target.value })}>
                <option value="invite">Só por convite (recomendado)</option>
                <option value="approval">Aberto, mas eu aprovo cada conta</option>
                <option value="open">Aberto: libera na hora (painel e WhatsApp)</option>
                <option value="closed">Fechado: só eu crio contas</option>
              </select>
              <div className="help">Só por convite: a pessoa entra pelo link do convite ou respondendo SIM no WhatsApp. Quem entra vê só os próprios dados. Liberar na hora deixa qualquer número usar o assistente (gasta sua chave do OpenRouter).</div>
            </div>
          </Section>

          <Section id="travas" icon="shield" title="Travas de segurança" desc='Limites que evitam gasto e loop. Valem para todo mundo, menos para os números de dono. Quando uma trava age, aparece em Execuções como "trava: …".'>
            <div className="set-fields">
              {num("maxExecutionMinutes", "Tempo máximo por resposta (minutos)", "Perto do fim o time responde com o que tem; no limite, tudo é cancelado e a pessoa recebe um aviso. Entre 0,5 e 30.", 0.5)}
              {num("maxToolCalls", "Ações por resposta", "Ferramentas e consultas somando o time todo. Evita loop de pesquisa. Entre 5 e 200.")}
              {num("rateLimitPerMinute", "Mensagens por minuto", "Acima disso o assistente junta tudo e responde no máximo uma vez por minuto. Nada se perde.")}
              {num("dailyMessageLimit", "Mensagens por pessoa por dia", "Ao passar, avisa uma vez e para até o dia seguinte. 0 = sem limite.")}
              {num("dailyCostLimitUsd", "Gasto de IA por pessoa em 24h (US$)", "Custo real do OpenRouter das respostas daquela pessoa. 0 = sem limite.", 0.05)}
              {num("maxMessageChars", "Tamanho máximo de mensagem (caracteres)", "Texto maior é cortado antes de ir para a IA. Documentos têm limite próprio.", 100)}
            </div>
            <p className="set-note"><Icon name="check" size={14} /> Sempre ligadas: o assistente ignora ordens escritas dentro de documentos, páginas e e-mails, não revela instruções nem chaves, pede "sim" antes de pagar ou mandar algo para alguém, e nenhuma chave de API sai numa mensagem.</p>
          </Section>

          <BillingSection form={form} setForm={setForm} />

          <PurchasesSection form={form} setForm={setForm} />

          <Section id="dados" icon="file" title="Dados e LGPD" desc="Quem é o responsável pelos dados. Aparece em Termos e privacidade (/privacidade): a LGPD pede que o cliente saiba quem trata os dados dele e por onde falar.">
            <div className="set-fields">
              <div className="field"><label>Nome ou razão social</label><input className="input" value={form.legalName ?? ""} onChange={(e) => setForm({ ...form, legalName: e.target.value })} /></div>
              <div className="field"><label>CPF ou CNPJ</label><input className="input" inputMode="numeric" value={form.legalDocument ?? ""} onChange={(e) => setForm({ ...form, legalDocument: e.target.value })} /></div>
              <div className="field">
                <label>E-mail para assuntos de dados</label>
                <input className="input" type="email" value={form.privacyEmail ?? ""} onChange={(e) => setForm({ ...form, privacyEmail: e.target.value })} />
                <div className="help">Para onde a pessoa escreve para pedir acesso, correção ou exclusão.</div>
              </div>
              <div className="field"><label>Cidade do foro</label><input className="input" placeholder="Ex.: Campinas/SP" value={form.legalCity ?? ""} onChange={(e) => setForm({ ...form, legalCity: e.target.value })} /></div>
            </div>
          </Section>

          <Section id="canal" icon="phone" title="WhatsApp e acesso" desc="Por onde o assistente fala e quem passa direto. Só leitura: muda pelas variáveis do servidor.">
            <dl className="set-facts">
              <div><dt>Provedor do WhatsApp</dt><dd>{provider} {data.channel.configured ? <span className="badge badge-ok">configurado</span> : <span className="badge badge-warn">faltam variáveis no .env</span>}</dd></div>
              {!data.channel.webhookUrl ? (
                <div><dt>Conexão</dt><dd>Por QR code, na tela <a href="/whatsapp">WhatsApp</a>.</dd></div>
              ) : (
                <div>
                  <dt>URL do webhook</dt>
                  <dd>
                    <CopyField value={data.channel.webhookUrl} />
                    <small className="help">{data.channel.provider === "cloud" ? "Cadastre no app da Meta (WhatsApp > Configuration) com o verify token do .env e assine o campo messages." : "Na Evolution, configure o webhook da instância com esta URL e o evento MESSAGES_UPSERT."}</small>
                  </dd>
                </div>
              )}
              <div><dt>Donos (sempre liberados)</dt><dd>{data.ownerPhones.length ? data.ownerPhones.map((p: string) => phoneFmt(p)).join(", ") : "nenhum (defina OWNER_PHONES)"}</dd></div>
              <div><dt>Números desconhecidos</dt><dd>{data.allowUnknown ? "liberados automaticamente" : "esperam aprovação em Pessoas"}</dd></div>
              <div><dt>OpenRouter</dt><dd>{data.openrouter ? <span className="badge badge-ok">chave configurada</span> : <span className="badge badge-err">defina OPENROUTER_API_KEY</span>}</dd></div>
            </dl>
          </Section>
        </div>
      </div>

      <div className={`set-savebar${dirty || saved || saveErr ? " show" : ""}`} role="status">
        <span>{saveErr ? `Não salvou: ${saveErr}` : saved && !dirty ? "Alterações salvas." : "Você tem alterações não salvas."}</span>
        {dirty && <button className="btn btn-ghost" onClick={() => setForm(JSON.parse(base))} disabled={saving}>Desfazer</button>}
        {dirty && <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "Salvando…" : "Salvar"}</button>}
      </div>
    </div>
  );
}
