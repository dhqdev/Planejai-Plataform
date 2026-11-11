import { useEffect, useState } from "react";
import { api } from "../api";
import type { Me } from "../App";
import { ErrorBox } from "../components";
import { CampoSenha } from "../CampoSenha";
import { Icon } from "../icons";
import { haptic, isStandalone } from "../touch";
import { useKeyboardShell } from "../teclado";
import { Mascote, type Mood } from "../mascote/Mascote";
import { FloatingMascotes, StageMascote, lookAt } from "../mascote/Parade";
import { SignupChat } from "./SignupChat";

/** Código do convite quando a pessoa abre o link /convite/CODIGO. */
const inviteCode = () => /^\/convite\/([A-Za-z0-9-]+)/.exec(location.pathname)?.[1]?.replace(/-/g, "").toUpperCase() ?? null;

/** Cara do Mascote conforme o campo em foco: tímido na senha. */
const FIELD_MOOD: Record<string, Mood> = { email: "thinking", password: "shy" };

/**
 * Entrar, esqueci a senha e cadastro. O cadastro é uma conversa com o Bolinho (`SignupChat`, desde 2026-11-11);
 * entrar e esqueci a senha seguem no formulário curto.
 */
export function AuthPage({ onLogin }: { onLogin: (me: Me) => void }) {
  const [code] = useState<string | null>(inviteCode);
  const wantsSignup = Boolean(code) || new URLSearchParams(location.search).has("cadastro");
  const [mode, setMode] = useState<"login" | "register" | "forgot">(wantsSignup ? "register" : "login");
  // esqueci a senha: o código chega no WhatsApp da conta
  const [reset, setReset] = useState<string | null>(null);
  const [signup, setSignup] = useState<string>("invite");
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  // navegador novo: depois da senha, código de 6 dígitos que chega no WhatsApp
  const [challenge, setChallenge] = useState<{ id: string; to: string } | null>(null);
  const [otp, setOtp] = useState("");
  // foco automático só com mouse: no celular ele abria o teclado ao abrir a tela e empurrava tudo para cima
  const [desk] = useState(() => !window.matchMedia("(pointer: coarse)").matches);
  // celular: a tela fica presa na área visível e encolhe com o teclado em vez de rolar (login-celular.css)
  useKeyboardShell();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const focusProps = (k: string) => ({ onFocus: () => setFocus(k), onBlur: () => setFocus((f) => (f === k ? null : f)) });

  useEffect(() => {
    api("/api/auth/config").then(
      (c) => setSignup(c.signupMode),
      () => {},
    );
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "forgot" && !reset) {
        const r = await api<{ challenge: string }>("/api/auth/forgot", { method: "POST", json: { email: form.email } });
        setReset(r.challenge);
        setOtp("");
        setForm((f) => ({ ...f, password: "" }));
      } else if (mode === "forgot") {
        const me = await api<Me>("/api/auth/reset", { method: "POST", json: { challenge: reset, code: otp, password: form.password } });
        onLogin(me);
      } else if (challenge) {
        const me = await api<Me>("/api/auth/login/verify", { method: "POST", json: { challenge: challenge.id, code: otp } });
        if (code) history.replaceState(null, "", "/");
        onLogin(me);
      } else {
        const r = await api<Me & { needs_code?: boolean; challenge?: string; to?: string }>("/api/auth/login", { method: "POST", json: { email: form.email, password: form.password } });
        if (r.needs_code) {
          setChallenge({ id: r.challenge!, to: r.to ?? "seu WhatsApp" });
          setOtp("");
          return;
        }
        if (code) history.replaceState(null, "", "/");
        onLogin(r);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canRegister = signup !== "closed";
  const look = lookAt(0);
  const mood: Mood = error ? "error" : busy ? "working" : (focus && FIELD_MOOD[focus]) || "greeting";
  const say = error ? "Opa, algo não bateu." : mode === "forgot" ? "Acontece com todo mundo." : mode === "register" ? "Bora conversar?" : "Que bom te ver!";

  const hero = (
    <section className="auth-hero">
      <div className="brand" style={{ padding: 0 }}>
        <Mascote size={44} crop mood={busy ? "working" : "greeting"} />
        planejai
      </div>
      <div className="auth-hero-stage">
        <FloatingMascotes />
        <StageMascote step={mode} look={look} mood={mode === "register" ? "happy" : mood} size={190} say={say} />
      </div>
      <div>
        <h2>Seu assistente no WhatsApp que resolve de verdade.</h2>
        <p>Um time de agentes que pesquisa, lembra, anota seus gastos e fica de olho no que importa para você.</p>
        <small style={{ opacity: 0.6 }}>Entrada só por convite</small>
      </div>
    </section>
  );

  // cadastro: a conversa ocupa a coluna da direita no notebook e a tela toda no celular
  if (mode === "register")
    return (
      <div className="auth auth-chat">
        {hero}
        <section className="auth-form">
          <SignupChat
            initialCode={code}
            onLogin={onLogin}
            onEnter={() => {
              setMode("login");
              setError(null);
            }}
          />
        </section>
      </div>
    );

  return (
    <div className="auth">
      {hero}
      <section className="auth-form">
        {/* volta para a página de apresentação (quem caiu aqui pelo link e quer ler antes) */}
        {!isStandalone() && (
        <a className="auth-back" href="/" aria-label="Voltar para a página inicial" title="Voltar">
          <Icon name="chevron-left" size={20} />
          <span>Voltar</span>
        </a>
        )}
        <FloatingMascotes edges />
        <form className="card" onSubmit={submit}>
          <div className="auth-logo">
            <StageMascote step={mode} look={look} mood={mood} size={92} />
          </div>
          {challenge ? (
            <>
              <h1>Confirme que é você</h1>
              <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
                Este navegador é novo. Mandamos um código de 6 dígitos para o WhatsApp {challenge.to}.
              </p>
              <div className="field">
                <label>Código</label>
                <input
                  className="input otp-input mono"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  autoFocus
                  required
                />
              </div>
              <ErrorBox error={error} />
              <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 12, padding: "10px 12px" }} disabled={busy || otp.length !== 6} onClick={() => haptic(10)}>
                {busy ? "Conferindo…" : "Entrar"}
              </button>
              <p className="muted" style={{ textAlign: "center", marginBottom: 0, fontSize: 13 }}>
                Não chegou?{" "}
                <button type="button" className="link" onClick={() => { setChallenge(null); setError(null); setOtp(""); }}>Voltar e entrar de novo</button>
              </p>
            </>
          ) : mode === "forgot" ? (
            reset ? (
              <>
                <h1>Senha nova</h1>
                <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>Se esse e-mail tem conta, o código chegou agora no WhatsApp cadastrado. Ele vale 15 minutos.</p>
                <div className="field">
                  <label htmlFor="reset-code">Código</label>
                  <input
                    id="reset-code"
                    className="input otp-input mono"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    autoFocus
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="reset-pass">Senha nova</label>
                  <CampoSenha id="reset-pass" className="input" value={form.password} onChange={set("password")} {...focusProps("password")} minLength={8} autoComplete="new-password" required />
                  <span className="help">Pelo menos 8 caracteres. Os outros aparelhos saem da conta.</span>
                </div>
                <ErrorBox error={error} />
                <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 12, padding: "10px 12px" }} disabled={busy || otp.length !== 6 || form.password.length < 8} onClick={() => haptic(10)}>
                  {busy ? "Salvando…" : "Salvar e entrar"}
                </button>
                <p className="muted" style={{ textAlign: "center", marginBottom: 0, fontSize: 13 }}>
                  Não chegou?{" "}
                  <button type="button" className="link" onClick={() => { setReset(null); setError(null); }}>Pedir outro código</button>
                </p>
              </>
            ) : (
              <>
                <h1>Esqueci a senha</h1>
                <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>Digite o e-mail da sua conta. Mandamos um código no seu WhatsApp para você criar uma senha nova.</p>
                <div className="field"><label htmlFor="forgot-email">E-mail</label><input id="forgot-email" className="input" type="email" value={form.email} onChange={set("email")} {...focusProps("email")} autoComplete="email" autoFocus required /></div>
                <ErrorBox error={error} />
                <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 12, padding: "10px 12px" }} disabled={busy} onClick={() => haptic(10)}>
                  {busy ? "Enviando…" : "Mandar código no WhatsApp"}
                </button>
                <p className="muted" style={{ textAlign: "center", marginBottom: 0, fontSize: 13 }}>
                  Lembrou?{" "}
                  <button type="button" className="link" onClick={() => { setMode("login"); setError(null); }}>Voltar e entrar</button>
                </p>
              </>
            )
          ) : (
            <>
              <h1>Entrar</h1>
              <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>Acesse o painel do seu assistente.</p>
              <div className="field"><label>E-mail</label><input className="input" type="email" value={form.email} onChange={set("email")} {...focusProps("email")} autoComplete="email" autoFocus={desk} required /></div>
              <div className="field">
                <label>Senha</label>
                <CampoSenha className="input" value={form.password} onChange={set("password")} {...focusProps("password")} autoComplete="current-password" required />
                <button type="button" className="link forgot-link" onClick={() => { setMode("forgot"); setReset(null); setError(null); }}>Esqueci a senha</button>
              </div>
              <ErrorBox error={error} />
              <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 12, padding: "10px 12px" }} disabled={busy}>
                {busy ? "Aguarde…" : "Entrar"}
              </button>
              <p className="muted" style={{ textAlign: "center", marginBottom: 0, fontSize: 13 }}>
                {canRegister ? (
                  <>
                    {signup === "invite" ? "Recebeu um convite?" : "Ainda não tem conta?"}{" "}
                    <button type="button" className="link" onClick={() => { setMode("register"); setError(null); }}>
                      {signup === "invite" ? "Usar meu código" : "Cadastre-se"}
                    </button>
                  </>
                ) : null}
              </p>
            </>
          )}
        </form>
      </section>
    </div>
  );
}
