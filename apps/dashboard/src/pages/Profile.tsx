import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api, phoneFmt } from "../api";
import type { Me } from "../App";
import { ErrorBox, PageHead, alertDialog, confirmDialog } from "../components";
import { CampoSenha } from "../CampoSenha";
import { Connections } from "../Connections";
import { MyIntegrations } from "../MyIntegrations";
import { useApi } from "../hooks";
import { haptic } from "../touch";
import { MeetingsPage } from "./Meetings";
import { MemoriesPage } from "./Memories";

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
  // perfil em abas (David, 2026-10-16: "deixe mais simples"): uma coisa por vez, em vez de uma pilha de cartões.
  // A reunião das 19h é só do dono da stack. Links antigos (#sabe, #reunioes) abrem a aba certa.
  const { hash } = useLocation();
  const isSuper = me.role === "superadmin";
  const tabs: { id: Tab; label: string }[] = [
    { id: "perfil", label: "Perfil" },
    ...((me.linked || me.owner) ? [{ id: "sabe" as Tab, label: "O que sei de você" }] : []),
    { id: "conexoes", label: "Conexões" },
    { id: "seguranca", label: "Segurança" },
    ...(isSuper ? [{ id: "reunioes" as Tab, label: "Reuniões" }] : []),
  ];
  const fromHash = tabs.find((t) => `#${t.id}` === hash)?.id;
  const [tab, setTab] = useState<Tab>(fromHash ?? "perfil");
  useEffect(() => {
    if (fromHash) setTab(fromHash);
  }, [fromHash]);
  // no celular as abas rolam de lado: a escolhida sempre fica à vista
  useEffect(() => {
    document.querySelector(".acct-tabs .active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);
  const pick = (t: Tab) => {
    haptic(5);
    setTab(t);
    history.replaceState(history.state, "", t === "perfil" ? location.pathname : `#${t}`);
  };
  return (
    <div className="page acct-page">
      <PageHead title="Minha conta" subtitle={me.owner ? "Dono da plataforma. Nome e senha vêm da stack." : me.email} />
      <div className="acct-tabs-wrap">
        <div className="seg acct-tabs" role="tablist" aria-label="Minha conta">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => pick(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {msg && <div className="ok-box" role="status">{msg}</div>}
      <ErrorBox error={error} />

      {tab === "perfil" && (
        <section className="acct-section acct-cards" aria-label="Perfil">
          {!me.owner && (
            <div className="card card-pad">
              <h3>Seus dados</h3>
              <div className="field"><label htmlFor="pf-name">Nome</label><input id="pf-name" name="name" autoComplete="name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="field">
                <label htmlFor="pf-phone">WhatsApp ligado</label>
                <input id="pf-phone" className="input" aria-describedby="pf-phone-help" value={data?.user ? phoneFmt(data.user.phone) : "nenhum"} disabled />
                <span className="help" id="pf-phone-help">É por esse número que o assistente sabe que é você.</span>
              </div>
              <div className="field">
                <label htmlFor="pf-tz">Fuso horário</label>
                <input id="pf-tz" name="timezone" autoComplete="off" spellCheck={false} autoCapitalize="none" className="input" placeholder={data?.user?.timezone ?? "America/Sao_Paulo"} value={tz} onChange={(e) => setTz(e.target.value)} />
              </div>
              <button className="btn btn-primary" onClick={() => save({ name, timezone: tz || undefined })}>Salvar</button>
            </div>
          )}
          {(me.linked || me.owner) && <AboutMe />}
          <Sharing />
        </section>
      )}
      {tab === "sabe" && <MemoriesPage embedded />}
      {tab === "conexoes" && (
        <section className="acct-section acct-cards" aria-label="Conexões">
          <Connections owner={me.owner} />
          {me.linked && !me.owner && <MyIntegrations />}
        </section>
      )}
      {tab === "seguranca" && (
        <section className="acct-section acct-cards" aria-label="Segurança">
          {!me.owner && (
            <div className="card card-pad">
              <h3>Trocar senha</h3>
              <div className="field"><label htmlFor="pf-pw">Senha atual</label><CampoSenha id="pf-pw" name="current-password" autoComplete="current-password" className="input" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></div>
              <div className="field"><label htmlFor="pf-newpw">Nova senha</label><CampoSenha id="pf-newpw" name="new-password" autoComplete="new-password" className="input" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></div>
              <button className="btn" onClick={() => save(pw)}>Trocar senha</button>
            </div>
          )}
          <Security me={me} />
        </section>
      )}
      {tab === "reunioes" && isSuper && <MeetingsPage embedded />}
    </div>
  );
}

type Tab = "perfil" | "sabe" | "conexoes" | "seguranca" | "reunioes";

/** O que a pessoa contou nas perguntas de boas-vindas (o assistente lê isso antes de cada conversa). */
function AboutMe() {
  const { data, reload } = useApi<{ summary: string }>("/api/me/onboarding");
  useEffect(() => {
    window.addEventListener("pj:welcome-done", reload);
    return () => window.removeEventListener("pj:welcome-done", reload);
  }, [reload]);
  return (
    <div className="card card-pad">
      <h3>Sobre você</h3>
      <p className="muted" style={{ marginTop: 0 }}>{data?.summary ? data.summary + "." : "Responda umas perguntas rápidas e o assistente já começa a conversa te conhecendo."}</p>
      <button className="btn" onClick={() => window.dispatchEvent(new Event("pj:welcome"))}>{data?.summary ? "Refazer as perguntas" : "Responder as perguntas"}</button>
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
              <div className="field"><label htmlFor="pf-erase">Confirme com sua senha</label><CampoSenha id="pf-erase" name="password" autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></div>
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

const SCREENS = [
  { id: "finance", label: "Finanças" },
  { id: "agenda", label: "Agenda" },
] as const;

/**
 * Finanças e Agenda são particulares. Aqui a pessoa escolhe, por contato (quem aceitou um convite),
 * o que ele pode ver. Também dá para pedir no WhatsApp: "deixa a Ana ver minhas finanças".
 */
function Sharing() {
  const { data, reload } = useApi<{ mine: { id: string; name: string; scopes: string[] }[]; withMe: { id: string; name: string; scopes: string[] }[] }>("/api/shares");
  const [error, setError] = useState<string | null>(null);
  const [mineState, setMineState] = useState<{ id: string; name: string; scopes: string[] }[] | null>(null);

  useEffect(() => {
    if (data?.mine) setMineState(data.mine);
  }, [data]);

  const list = mineState ?? data?.mine ?? [];

  const toggle = async (contact: string, scope: string, on: boolean) => {
    setError(null);
    haptic(5);
    const prev = mineState ?? data?.mine ?? [];
    // Atualização otimista na interface
    setMineState(prev.map((c) => {
      if (c.id !== contact) return c;
      const nextScopes = on ? [...new Set([...c.scopes, scope])] : c.scopes.filter((s) => s !== scope);
      return { ...c, scopes: nextScopes };
    }));
    try {
      await api("/api/shares", { method: "PUT", json: { contact, user: contact, scope, on } });
      await reload();
    } catch (e) {
      setMineState(prev);
      setError((e as Error).message);
    }
  };
  if (!data) return null;
  return (
    <div className="card card-pad">
      <h3>Compartilhar</h3>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Suas finanças e sua agenda são só suas. Escolha o que cada contato pode ver (só leitura). Contatos são quem aceitou um convite.
      </p>
      <ErrorBox error={error} />
      {list.length === 0 ? (
        <p className="muted" style={{ fontSize: 13 }}>Você ainda não tem contatos. Convide alguém pelo WhatsApp e ele aparece aqui.</p>
      ) : (
        <div className="share-list">
          {list.map((c) => (
            <div key={c.id} className="share-row">
              <span className="ellipsis">{c.name}</span>
              <div className="share-toggles">
                {SCREENS.map((s) => {
                  const on = c.scopes.includes(s.id);
                  return (
                    <button key={s.id} className={`chip ${on ? "active" : ""}`} aria-pressed={on} onClick={() => toggle(c.id, s.id, !on)}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {data.withMe.length > 0 && (
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          Compartilharam com você: {data.withMe.map((p) => `${p.name} (${p.scopes.map((x) => SCREENS.find((s) => s.id === x)?.label ?? x).join(" e ")})`).join(", ")}. Abra em Finanças ou Agenda.
        </p>
      )}
    </div>
  );
}
