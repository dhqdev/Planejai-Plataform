import { useState } from "react";
import { api } from "../api";
import type { Me } from "../App";
import { ErrorBox, PageHead, alertDialog, confirmDialog } from "../components";
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
      {msg && <div className="ok-box" role="status" style={{ marginBottom: 12 }}>{msg}</div>}
      <ErrorBox error={error} />
      <div className="grid grid-2" style={{ alignItems: "start" }}>
      <div className="card card-pad">
        <h3>Perfil</h3>
        <div className="field"><label htmlFor="pf-name">Nome</label><input id="pf-name" name="name" autoComplete="name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field">
          <label htmlFor="pf-phone">WhatsApp ligado</label>
          <input id="pf-phone" className="input" aria-describedby="pf-phone-help" value={data?.user ? `+${data.user.phone}` : "nenhum"} disabled />
          <span className="help" id="pf-phone-help">É por esse número que o assistente sabe que é você.</span>
        </div>
        <div className="field">
          <label htmlFor="pf-tz">Fuso horário</label>
          <input id="pf-tz" name="timezone" autoComplete="off" spellCheck={false} autoCapitalize="none" className="input" placeholder={data?.user?.timezone ?? "America/Sao_Paulo"} value={tz} onChange={(e) => setTz(e.target.value)} />
        </div>
        <button className="btn btn-primary" onClick={() => save({ name, timezone: tz || undefined })}>Salvar perfil</button>
      </div>
      <div className="card card-pad">
        <h3>Trocar senha</h3>
        <div className="field"><label htmlFor="pf-pw">Senha atual</label><input id="pf-pw" name="current-password" autoComplete="current-password" className="input" type="password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></div>
        <div className="field"><label htmlFor="pf-newpw">Nova senha</label><input id="pf-newpw" name="new-password" autoComplete="new-password" className="input" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></div>
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
    const ok = await confirmDialog({
      title: "Sair de todos os aparelhos?",
      body: "Todos os logins caem, inclusive este. Você vai precisar entrar de novo.",
      confirmLabel: "Sair de todos",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("/api/auth/logout-all", { method: "POST" });
      location.href = "/";
    } catch (e) {
      void alertDialog("Não deu para sair", (e as Error).message);
    }
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
              <div className="field"><label htmlFor="pf-erase">Confirme com sua senha</label><input id="pf-erase" name="password" autoComplete="current-password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></div>
              <ErrorBox error={error} />
              <div className="row row-wrap" style={{ gap: 8 }}>
                <button className="btn btn-danger-solid" disabled={!password} onClick={eraseAll}>Apagar tudo</button>
                <button className="btn btn-ghost" onClick={() => setErase(false)}>Cancelar</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
