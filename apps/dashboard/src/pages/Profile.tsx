import { useState } from "react";
import { api } from "../api";
import type { Me } from "../App";
import { ErrorBox, PageHead } from "../components";
import { Connections } from "../Connections";
import { useApi } from "../hooks";

export function ProfilePage({ me }: { me: Me }) {
  const { data } = useApi<any>("/api/me/profile");
  const [name, setName] = useState(me.name ?? "");
  const [tz, setTz] = useState("");
  const [pw, setPw] = useState({ current_password: "", password: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (body: any) => {
    setMsg(null);
    setError(null);
    try {
      await api("/api/me", { method: "PATCH", json: body });
      setMsg("Salvo!");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <PageHead title="Minha conta" subtitle={me.email} />
      {msg && <div className="ok-box" style={{ marginBottom: 12 }}>{msg}</div>}
      <ErrorBox error={error} />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card card-pad">
        <h3>Perfil</h3>
        <div className="field"><label>Nome</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field">
          <label>WhatsApp ligado</label>
          <input className="input" value={data?.user ? `+${data.user.phone}` : "nenhum"} disabled />
          <span className="help">É por esse número que o assistente sabe que é você.</span>
        </div>
        <div className="field">
          <label>Fuso horário</label>
          <input className="input" placeholder={data?.user?.timezone ?? "America/Sao_Paulo"} value={tz} onChange={(e) => setTz(e.target.value)} />
        </div>
        <button className="btn btn-primary" onClick={() => save({ name, timezone: tz || undefined })}>Salvar perfil</button>
      </div>
      <div className="card card-pad">
        <h3>Trocar senha</h3>
        <div className="field"><label>Senha atual</label><input className="input" type="password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></div>
        <div className="field"><label>Nova senha</label><input className="input" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></div>
        <button className="btn" onClick={() => save(pw)}>Trocar senha</button>
      </div>
      <Connections />
      </div>
    </div>
  );
}
