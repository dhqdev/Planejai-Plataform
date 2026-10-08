import { useEffect, useState } from "react";
import { api, brl } from "../api";
import { CopyField, ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";

const BILL_STATE: Record<string, string> = { trial: "dias grátis", active: "em dia", blocked: "travado", exempt: "liberado" };

/** Assinatura pelo Asaas: ligar, preço, dias grátis, endereço do webhook e a situação de cada pessoa. */
function BillingCard({ form, setForm, save, saved }: { form: any; setForm: (f: any) => void; save: () => void; saved: boolean }) {
  const { data, reload } = useApi<any>("/api/billing/admin");
  const exempt = async (id: string, value: boolean) => {
    await api(`/api/billing/people/${id}`, { method: "PATCH", json: { exempt: value } });
    await reload();
  };
  return (
    <div className="card card-pad">
      <h3>Assinatura (Asaas)</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Cobrança mensal dos clientes. Cada pessoa usa de graça pelos dias abaixo; depois, sem assinatura em dia o assistente avisa uma vez por dia e para de responder. Donos nunca são cobrados.
      </p>
      <div className="field">
        <label className="row" style={{ gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={!!form.billingEnabled} onChange={(e) => setForm({ ...form, billingEnabled: e.target.checked })} />
          Cobrar assinatura
        </label>
        <div className="help">
          {data?.connected ? "Asaas conectado." : "Antes de ligar, cole a chave de API e o token do webhook em Integrações > Asaas."} Ao ligar, quem já é cliente ganha os dias grátis a partir de agora.
        </div>
      </div>
      <div className="field"><label>Nome do plano</label><input className="input" value={form.billingPlanName ?? ""} onChange={(e) => setForm({ ...form, billingPlanName: e.target.value })} /></div>
      <div className="field">
        <label>Preço por mês (R$)</label>
        <input className="input" type="number" inputMode="decimal" step={0.1} min={1} value={form.billingPrice} onChange={(e) => setForm({ ...form, billingPrice: e.target.value === "" ? "" : Number(e.target.value) })} />
        <div className="help">Vale para novas assinaturas. Quem já assinou continua no valor em que entrou.</div>
      </div>
      <div className="field">
        <label>Dias grátis</label>
        <input className="input" type="number" inputMode="numeric" step={1} min={0} value={form.billingTrialDays} onChange={(e) => setForm({ ...form, billingTrialDays: e.target.value === "" ? "" : Number(e.target.value) })} />
      </div>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field">
          <label>Lembrar o vencimento (dias antes)</label>
          <input className="input" type="number" inputMode="numeric" step={1} min={0} max={10} value={form.billingReminderDays ?? 3} onChange={(e) => setForm({ ...form, billingReminderDays: e.target.value === "" ? "" : Number(e.target.value) })} />
          <div className="help">Para quem paga por Pix ou boleto, e de novo no dia. Cartão renova sozinho.</div>
        </div>
        <div className="field">
          <label>Desconto por indicação (%)</label>
          <input className="input" type="number" inputMode="numeric" step={1} min={0} max={100} value={form.billingReferralPercent ?? 10} onChange={(e) => setForm({ ...form, billingReferralPercent: e.target.value === "" ? "" : Number(e.target.value) })} />
          <div className="help">Quem convidou ganha na próxima mensalidade quando o convidado paga a primeira vez. 0 desliga.</div>
        </div>
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
            <span><strong>{data.counts.active}</strong> em dia</span>
            <span><strong>{data.counts.trial}</strong> nos dias grátis</span>
            <span><strong>{data.counts.blocked}</strong> travados</span>
            <span><strong>{data.counts.exempt}</strong> liberados</span>
            <span><strong>{brl(data.mrr)}</strong> por mês</span>
          </p>
          <ul className="bill-people">
            {data.people.map((p: any) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <small>{p.owner ? "dono" : BILL_STATE[p.state] ?? p.state}</small>
                {!p.owner && (
                  <button className="btn btn-sm" onClick={() => exempt(p.id, !p.exempt)}>{p.exempt ? "Voltar a cobrar" : "Liberar sem cobrança"}</button>
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
            Donos (sempre liberados): {data.ownerPhones.length ? data.ownerPhones.map((p: string) => `+${p}`).join(", ") : "nenhum (defina OWNER_PHONES)"}
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
