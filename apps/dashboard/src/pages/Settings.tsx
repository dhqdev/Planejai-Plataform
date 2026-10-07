import { useEffect, useState } from "react";
import { api } from "../api";
import { ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";

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
    <div className="page fit settings-page">
      <PageHead title="Configurações" />
      <div className="grid grid-2">
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
          {num("dailyMessageLimit", "Mensagens por pessoa em 24h", "Ao passar, avisa uma vez e para de responder até liberar. 0 = sem limite.")}
          {num("dailyCostLimitUsd", "Gasto de IA por pessoa em 24h (US$)", "Soma o custo real do OpenRouter das respostas daquela pessoa. 0 = sem limite.", 0.05)}
          {num("maxMessageChars", "Tamanho máximo de mensagem (caracteres)", "Texto maior é cortado antes de ir para a IA. Documentos têm limite próprio.", 100)}
          <p className="muted" style={{ fontSize: 12 }}>Sempre ligadas: o agente ignora ordens escritas dentro de documentos, páginas e e-mails, não revela instruções nem chaves, pede "sim" antes de pagar ou enviar algo, e nenhuma chave de API sai numa mensagem.</p>
          <div className="row">
            <button className="btn btn-primary" onClick={save}>Salvar</button>
            {saved && <span className="badge badge-ok">Salvo</span>}
            {saveErr && <span className="badge badge-err">{saveErr}</span>}
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
