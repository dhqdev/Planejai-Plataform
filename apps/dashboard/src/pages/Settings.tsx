import { useEffect, useState } from "react";
import { api } from "../api";
import { ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";

export function SettingsPage() {
  const { data, error } = useApi<any>("/api/settings");
  const [form, setForm] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data || !form) return <Loading />;

  return (
    <div className="page">
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
          <div className="row">
            <button className="btn btn-primary" onClick={async () => { await api("/api/settings", { method: "PUT", json: form }); setSaved(true); setTimeout(() => setSaved(false), 2000); }}>Salvar</button>
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
