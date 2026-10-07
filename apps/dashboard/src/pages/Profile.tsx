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
      <Security me={me} />
      </div>
    </div>
  );
}

/** Sair de todos os aparelhos e, para quem não é o dono, apagar a conta e todos os dados (LGPD). */
function Security({ me }: { me: Me }) {
  const [erase, setErase] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const leaveAll = async () => {
    if (!confirm("Sair de todos os aparelhos, inclusive deste?")) return;
    await api("/api/auth/logout-all", { method: "POST" });
    location.href = "/";
  };
  const eraseAll = async () => {
    setError(null);
    try {
      await api("/api/me", { method: "DELETE", json: { password } });
      location.href = "/";
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card card-pad danger-zone">
      <h3>Segurança e privacidade</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Esqueceu o painel aberto em outro lugar? Saia de todos os aparelhos. Trocar a senha também derruba os outros logins.
      </p>
      <button className="btn" onClick={leaveAll}>Sair de todos os aparelhos</button>
      {!me.owner && (
        <>
          <p className="muted" style={{ fontSize: 13, marginTop: 18 }}>
            Apagar a conta remove gastos, limites, lembretes, memórias, contatos e o login, sem volta.{" "}
            <a href="/privacidade" target="_blank" rel="noreferrer">Política de privacidade</a>
          </p>
          {!erase ? (
            <button className="btn btn-danger" onClick={() => setErase(true)}>Apagar minha conta e meus dados</button>
          ) : (
            <>
              <div className="field"><label>Confirme com sua senha</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></div>
              <ErrorBox error={error} />
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-danger" disabled={!password} onClick={eraseAll}>Apagar tudo</button>
                <button className="btn btn-ghost" onClick={() => setErase(false)}>Cancelar</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
