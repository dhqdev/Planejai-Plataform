import { useEffect, useState } from "react";
import { api, brl, phoneFmt } from "../api";
import { CopyField, ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";

const BILL_STATE: Record<string, string> = { plan: "com plano", free: "nos grãos grátis", empty: "sem grãos", exempt: "liberado" };
const nf = new Intl.NumberFormat("pt-BR");

/** Grãos e planos pelo Asaas: ligar, vitrine (planos e pacotes), regras, webhook e a situação de cada pessoa. */
function BillingCard({ form, setForm, save, saved }: { form: any; setForm: (f: any) => void; save: () => void; saved: boolean }) {
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
    <div className="card card-pad">
      <h3>Grãos e planos (Asaas)</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Cada resposta gasta grãos pelo custo real da IA. A pessoa ganha os grãos de boas-vindas, depois assina um plano (recarrega todo mês) ou compra pacotes avulsos. Sem grãos, o assistente avisa uma vez por dia e para. Donos nunca gastam.
      </p>
      <div className="field">
        <label className="row" style={{ gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={!!form.billingEnabled} onChange={(e) => setForm({ ...form, billingEnabled: e.target.checked })} />
          Cobrar por grãos
        </label>
        <div className="help">
          {data?.connected ? (data.mode === "sandbox" ? <><b>Asaas em sandbox:</b> ninguém é cobrado de verdade. Troque por uma chave $aact_prod_ em Integrações &gt; Asaas.</> : "Asaas conectado (produção).") : "Antes de ligar, cole a chave de API e o token do webhook em Integrações > Asaas."} Ao ligar, cada pessoa ganha os grãos de boas-vindas na primeira mensagem.
        </div>
      </div>
      <h4 className="set-sub">Planos (por mês)</h4>
      <div className="set-plans">
        {plans.map((p, i) => (
          <div key={i} className="set-plan">
            <input className="input" aria-label="Nome do plano" value={p.name ?? ""} onChange={(e) => setPlan(i, { name: e.target.value })} />
            <input className="input" aria-label="Preço por mês (R$)" type="number" inputMode="decimal" step={0.1} min={1} value={p.price ?? ""} onChange={(e) => setPlan(i, { price: n(e.target.value) })} />
            <input className="input" aria-label="Grãos por mês" type="number" inputMode="numeric" step={100} min={1} value={p.grains ?? ""} onChange={(e) => setPlan(i, { grains: n(e.target.value) })} />
            <input className="input set-plan-blurb" aria-label="Para quem é" placeholder="Para quem é" value={p.blurb ?? ""} onChange={(e) => setPlan(i, { blurb: e.target.value })} />
            <label className="set-plan-hl"><input type="radio" name="plan-hl" checked={!!p.highlight} onChange={() => setPlan(i, { highlight: true })} /> destaque</label>
            {plans.length > 1 && <button className="btn btn-sm btn-ghost" onClick={() => setForm({ ...form, billingPlans: plans.filter((_, j) => j !== i) })}>Tirar</button>}
          </div>
        ))}
        {plans.length < 4 && <button className="btn btn-sm" onClick={() => setForm({ ...form, billingPlans: [...plans, { name: "", price: 29.9, grains: 3000, blurb: "" }] })}>Adicionar plano</button>}
        <div className="help">Nome, R$ por mês e grãos por mês. Mudar o preço vale para quem assinar depois; quem já assina é ajustado na próxima troca.</div>
      </div>
      <h4 className="set-sub">Pacotes avulsos</h4>
      <div className="set-plans">
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
      <div className="grid grid-2" style={{ gap: 10 }}>
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
          <div className="help">Asaas &gt; Integrações &gt; Webhooks: eventos de Cobranças e Assinaturas, com o mesmo token que você colou em Integrações.</div>
        </div>
      )}
      <div className="row">
        <button className="btn btn-primary" onClick={save}>Salvar</button>
        {saved && <span className="badge badge-ok">Salvo</span>}
      </div>
      {data && (
        <>
          <h3 style={{ marginTop: 20 }}>Situação</h3>
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
    </div>
  );
}

export function SettingsPage() {
  const { data, error } = useApi<any>("/api/settings");
  const [form, setForm] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data || !form) return <Loading />;

  const save = async () => {
    setSaveErr(null);
    try {
      await api("/api/settings", { method: "PUT", json: form });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveErr((e as Error).message);
    }
  };
  const num = (key: string, label: string, help: string, step = 1) => (
    <div className="field">
      <label>{label}</label>
      <input className="input" type="number" inputMode="decimal" step={step} min={0} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value === "" ? "" : Number(e.target.value) })} />
      <div className="help">{help}</div>
    </div>
  );

  return (
    <div className="page settings-page">
      <PageHead title="Configurações" />
      <div className="grid grid-3">
        <div className="card card-pad">
          <h3>Personalidade do agente</h3>
          <div className="field"><label>Nome do assistente</label><input className="input" value={form.assistantName} onChange={(e) => setForm({ ...form, assistantName: e.target.value })} /></div>
          <div className="field"><label>Fuso horário padrão</label><input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></div>
          <div className="field">
            <label>Instruções extras</label>
            <textarea className="textarea" placeholder="Ex.: me chame de Dav, seja mais informal, sempre sugira opções baratas primeiro…" value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} />
            <div className="help">Somadas ao prompt do CTO em toda conversa.</div>
          </div>
          <div className="field">
            <label>Cadastro no painel</label>
            <select className="select" value={form.signupMode} onChange={(e) => setForm({ ...form, signupMode: e.target.value })}>
              <option value="invite">Só por convite (recomendado)</option>
              <option value="approval">Aberto, mas eu aprovo cada conta</option>
              <option value="open">Aberto: libera na hora (painel e WhatsApp)</option>
              <option value="closed">Fechado: só eu crio contas</option>
            </select>
            <div className="help">Só por convite: a pessoa entra pelo link do convite ou respondendo SIM no WhatsApp. Quem entra vê só os próprios dados. Liberar na hora deixa o número usar o assistente (gasta sua chave do OpenRouter).</div>
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={save}>Salvar</button>
            {saved && <span className="badge badge-ok">Salvo</span>}
          </div>
        </div>
        <div className="card card-pad">
          <h3>Travas de segurança</h3>
          <p className="muted" style={{ marginTop: 0 }}>Valem para todo mundo, menos para os números de dono. Quando uma trava age, aparece em Execuções como "trava: …".</p>
          {num("maxExecutionMinutes", "Tempo máximo por resposta (minutos)", "Perto do fim o time é avisado para responder com o que tem; no limite, tudo é cancelado e a pessoa recebe um aviso. Entre 0,5 e 30.", 0.5)}
          {num("maxToolCalls", "Ações por resposta", "Ferramentas e consultas somando o time todo. Evita loop de pesquisa. Entre 5 e 200.")}
          {num("rateLimitPerMinute", "Mensagens por minuto", "Acima disso o agente junta tudo e responde no máximo uma vez por minuto. Nada se perde.")}
          {num("dailyMessageLimit", "Mensagens por pessoa por dia", "Ao passar, avisa uma vez e para de responder até liberar. 0 = sem limite.")}
          {num("dailyCostLimitUsd", "Gasto de IA por pessoa em 24h (US$)", "Soma o custo real do OpenRouter das respostas daquela pessoa. 0 = sem limite.", 0.05)}
          {num("maxMessageChars", "Tamanho máximo de mensagem (caracteres)", "Texto maior é cortado antes de ir para a IA. Documentos têm limite próprio.", 100)}
          <p className="muted" style={{ fontSize: 12 }}>Sempre ligadas: o agente ignora ordens escritas dentro de documentos, páginas e e-mails, não revela instruções nem chaves, pede "sim" antes de pagar ou enviar algo, e nenhuma chave de API sai numa mensagem.</p>
          <div className="row">
            <button className="btn btn-primary" onClick={save}>Salvar</button>
            {saved && <span className="badge badge-ok">Salvo</span>}
            {saveErr && <span className="badge badge-err">{saveErr}</span>}
          </div>
        </div>
        <BillingCard form={form} setForm={setForm} save={save} saved={saved} />
        <div className="card card-pad">
          <h3>Responsável pelos dados</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Aparece em Termos e privacidade (/privacidade). A LGPD pede que o cliente saiba quem trata os dados dele e por onde falar com o encarregado.
          </p>
          <div className="field"><label>Nome ou razão social</label><input className="input" value={form.legalName ?? ""} onChange={(e) => setForm({ ...form, legalName: e.target.value })} /></div>
          <div className="field"><label>CPF ou CNPJ</label><input className="input" inputMode="numeric" value={form.legalDocument ?? ""} onChange={(e) => setForm({ ...form, legalDocument: e.target.value })} /></div>
          <div className="field">
            <label>E-mail para assuntos de dados</label>
            <input className="input" type="email" value={form.privacyEmail ?? ""} onChange={(e) => setForm({ ...form, privacyEmail: e.target.value })} />
            <div className="help">Canal do encarregado: é para onde a pessoa escreve para pedir acesso, correção ou exclusão.</div>
          </div>
          <div className="field"><label>Cidade do foro</label><input className="input" placeholder="Ex.: Campinas/SP" value={form.legalCity ?? ""} onChange={(e) => setForm({ ...form, legalCity: e.target.value })} /></div>
          <div className="row">
            <button className="btn btn-primary" onClick={save}>Salvar</button>
            {saved && <span className="badge badge-ok">Salvo</span>}
          </div>
        </div>
        <div className="card card-pad">
          <h3>Canal WhatsApp</h3>
          <p>
            Provedor: <strong>{data.channel.provider === "baileys" ? "Conexão própria (Baileys)" : data.channel.provider === "cloud" ? "WhatsApp Cloud API (Meta)" : data.channel.provider === "evolution" ? "Evolution API" : "nenhum"}</strong>{" "}
            {data.channel.configured ? <span className="badge badge-ok">configurado</span> : <span className="badge badge-warn">faltam variáveis no .env</span>}
          </p>
          {!data.channel.webhookUrl ? (
            <p>
              Conexão própria por QR code. Conecte o número na tela <a href="/whatsapp" style={{ color: "var(--accent)" }}>WhatsApp</a>.
            </p>
          ) : (
          <div className="field">
            <label>URL do webhook</label>
            <code className="json">{data.channel.webhookUrl}</code>
            <div className="help">
              {data.channel.provider === "cloud"
                ? "Cadastre no app da Meta (WhatsApp > Configuration) com o verify token do .env e assine o campo messages."
                : "Na Evolution, configure o webhook da instância com esta URL e o evento MESSAGES_UPSERT."}
            </div>
          </div>
          )}
          <h3 style={{ marginTop: 18 }}>Acesso</h3>
          <p className="muted">
            Donos (sempre liberados): {data.ownerPhones.length ? data.ownerPhones.map((p: string) => phoneFmt(p)).join(", ") : "nenhum (defina OWNER_PHONES)"}
            <br />
            Contatos desconhecidos: {data.allowUnknown ? "liberados automaticamente" : "ficam aguardando aprovação em Pessoas"}
          </p>
          <h3 style={{ marginTop: 18 }}>OpenRouter</h3>
          <p>{data.openrouter ? <span className="badge badge-ok">chave configurada</span> : <span className="badge badge-err">defina OPENROUTER_API_KEY</span>}</p>
        </div>
      </div>
    </div>
  );
}
