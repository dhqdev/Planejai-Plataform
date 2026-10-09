import { useEffect, useState } from "react";
import { api, phoneFmt } from "../api";
import type { Me } from "../App";
import { ErrorBox } from "../components";
import { haptic } from "../touch";
import { Mochi, type Mood } from "../mochi/Mochi";
import { FloatingMochis, StageMochi, lookAt } from "../mochi/Parade";

interface Invite {
  name: string | null;
  email: string | null;
  phone: string | null;
  inviter: string | null;
  used: boolean;
}

/** Código do convite quando a pessoa abre o link /convite/CODIGO. */
const inviteCode = () => /^\/convite\/([A-Za-z0-9-]+)/.exec(location.pathname)?.[1]?.replace(/-/g, "").toUpperCase() ?? null;
const cleanCode = (raw: string) => raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);

/** Etapas do cadastro: código do convite, quem é você, acesso. */
type Step = "code" | "you" | "access";
const STEPS: Step[] = ["code", "you", "access"];

/** O que o Mochi diz em cada etapa (no palco do notebook). */
const SAY: Record<Step, string> = {
  code: "Cadê o seu convite?",
  you: "Prazer! Como te chamo?",
  access: "Agora é só criar a senha.",
};

/** Cara do Mochi conforme o campo em foco: tímido na senha, curioso no WhatsApp. */
const FIELD_MOOD: Record<string, Mood> = { code: "searching", name: "happy", phone: "curious", email: "thinking", password: "shy" };

export function AuthPage({ onLogin }: { onLogin: (me: Me) => void }) {
  const [code, setCode] = useState<string | null>(inviteCode);
  const wantsSignup = Boolean(code) || new URLSearchParams(location.search).has("cadastro");
  const [mode, setMode] = useState<"login" | "register" | "forgot">(wantsSignup ? "register" : "login");
  // esqueci a senha: o código chega no WhatsApp da conta
  const [reset, setReset] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(code ? "you" : "code");
  const [signup, setSignup] = useState<string>("invite");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [typed, setTyped] = useState("");
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [found, setFound] = useState(false);
  // navegador novo: depois da senha, código de 6 dígitos que chega no WhatsApp
  const [challenge, setChallenge] = useState<{ id: string; to: string } | null>(null);
  const [otp, setOtp] = useState("");
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const focusProps = (k: string) => ({ onFocus: () => setFocus(k), onBlur: () => setFocus((f) => (f === k ? null : f)) });

  const loadInvite = (c: string) =>
    api<Invite>(`/api/invite/${c}`).then((i) => {
      setInvite(i);
      setForm((f) => ({ ...f, name: f.name || i.name || "", email: f.email || i.email || "", phone: i.phone ?? f.phone }));
      if (i.used) setMode("login");
      return i;
    });

  useEffect(() => {
    api("/api/auth/config").then(
      (c) => {
        setSignup(c.signupMode);
        // sem convite obrigatório, o cadastro começa direto nos dados
        if (c.signupMode !== "invite" && !code) setStep("you");
      },
      () => {},
    );
    if (code)
      loadInvite(code).catch((e) => {
        setError((e as Error).message);
        setCode(null);
        setStep("code");
      });
    // só na abertura: o código digitado depois passa por checkCode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** "Tenho um convite": confere o código digitado e segue para os dados da pessoa. */
  const checkCode = async () => {
    const c = cleanCode(typed);
    if (c.length < 6) return setError("O código tem 6 letras e números.");
    setBusy(true);
    setError(null);
    try {
      await loadInvite(c);
      setCode(c);
      history.replaceState(null, "", `/convite/${c}`);
      haptic(14);
      setFound(true);
      setTimeout(() => {
        setFound(false);
        setStep("you");
      }, 900);
    } catch (e) {
      haptic(30);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (mode === "register" && step === "code") return checkCode();
    if (mode === "register" && step === "you") {
      if (form.name.trim().split(/\s+/).length < 2) return setError("Informe nome e sobrenome");
      if (!invite?.phone && form.phone.replace(/\D/g, "").length < 10) return setError("Informe o WhatsApp com DDD (ex.: 19 99999-9999)");
      haptic(8);
      return setStep("access");
    }
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
      } else if (mode === "login" && challenge) {
        const me = await api<Me>("/api/auth/login/verify", { method: "POST", json: { challenge: challenge.id, code: otp } });
        if (code) history.replaceState(null, "", "/");
        onLogin(me);
      } else if (mode === "login") {
        const r = await api<Me & { needs_code?: boolean; challenge?: string; to?: string }>("/api/auth/login", { method: "POST", json: { email: form.email, password: form.password } });
        if (r.needs_code) {
          setChallenge({ id: r.challenge!, to: r.to ?? "seu WhatsApp" });
          setOtp("");
          return;
        }
        if (code) history.replaceState(null, "", "/");
        onLogin(r);
      } else {
        if (!terms) throw new Error("Para criar a conta, aceite os termos de uso e a política de privacidade.");
        const r = await api("/api/auth/register", { method: "POST", json: { ...form, code: code ?? undefined, accept_terms: true } });
        if (code) history.replaceState(null, "", "/");
        if (r.pending) setDone(r.message);
        else onLogin(r);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canRegister = signup !== "closed";
  const steps = signup === "invite" || code ? STEPS : STEPS.slice(1);
  const at = steps.indexOf(step);
  const register = mode === "register" && !done && !challenge;
  const look = register ? lookAt(STEPS.indexOf(step)) : lookAt(0);
  // a cara do Mochi: erro e espera mandam, depois o campo em foco, depois a da fantasia
  const mood: Mood = error ? "error" : found ? "surprised" : busy ? "working" : done ? "finished" : (focus && FIELD_MOOD[focus]) || (register ? look.mood : "greeting");
  const stageKey = register ? step : mode;
  const say = error ? "Opa, algo não bateu." : found ? "Achei seu convite!" : register ? SAY[step] : mode === "forgot" ? "Acontece com todo mundo." : "Que bom te ver!";
  const back = () => {
    setError(null);
    setStep(steps[Math.max(0, at - 1)]!);
  };

  return (
    <div className="auth">
      <section className="auth-hero">
        <div className="brand" style={{ padding: 0 }}>
          <Mochi size={44} crop mood={busy ? "working" : "greeting"} />
          planejai
        </div>
        <div className="auth-hero-stage">
          <FloatingMochis />
          <StageMochi step={stageKey} look={look} mood={mood} size={190} say={say} />
        </div>
        <div>
          <h2>Seu assistente no WhatsApp que resolve de verdade.</h2>
          <p>Um time de agentes que pesquisa, lembra, anota seus gastos e fica de olho no que importa para você.</p>
          <small style={{ opacity: 0.6 }}>Entrada só por convite</small>
        </div>
      </section>
      <section className="auth-form">
        <FloatingMochis edges />
        <form className="card" onSubmit={submit}>
          <div className="auth-logo">
            <StageMochi step={stageKey} look={look} mood={mood} size={92} />
          </div>
          {challenge ? (
            <>
              <h1>Confirme que é você</h1>
              <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>Este navegador é novo. Mandamos um código de 6 dígitos para o WhatsApp {challenge.to}.</p>
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
                  <input id="reset-pass" className="input" type="password" value={form.password} onChange={set("password")} {...focusProps("password")} minLength={8} autoComplete="new-password" required />
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
          ) : done ? (
            <>
              <h1>Quase lá</h1>
              <p className="muted">{done}</p>
              <button type="button" className="btn" onClick={() => { setDone(null); setMode("login"); }}>Voltar para o login</button>
            </>
          ) : register ? (
            <>
              <div className="signup-dots" aria-label={`Etapa ${at + 1} de ${steps.length}`}>
                {steps.map((s, i) => (
                  <span key={s} className={i < at ? "done" : i === at ? "on" : ""} />
                ))}
              </div>
              <div className="signup-step" key={step}>
                {step === "code" ? (
                  <>
                    <h1>Tenho um convite</h1>
                    <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>Digite o código que você recebeu. Ele tem 6 letras e números e vale por 24 horas.</p>
                    <div className="field">
                      <label>Código do convite</label>
                      <input
                        className={found ? "input code-input mono found" : "input code-input mono"}
                        value={typed}
                        onChange={(e) => { setTyped(cleanCode(e.target.value)); setError(null); }}
                        {...focusProps("code")}
                        placeholder="K7Q M2X"
                        autoCapitalize="characters"
                        autoComplete="one-time-code"
                        spellCheck={false}
                        autoFocus
                        required
                      />
                    </div>
                  </>
                ) : step === "you" ? (
                  <>
                    <h1>{invite?.name ? `Olá, ${invite.name.split(" ")[0]}` : "Olá!"}</h1>
                    <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
                      {invite?.inviter ? `${invite.inviter} te convidou. ` : ""}Use o mesmo WhatsApp que vai conversar com o assistente.
                    </p>
                    <div className="field"><label>Nome completo</label><input className="input" value={form.name} onChange={set("name")} {...focusProps("name")} autoComplete="name" autoFocus required /></div>
                    <div className="field">
                      <label>WhatsApp</label>
                      <input
                        className="input"
                        placeholder="(19) 99999-9999"
                        value={invite?.phone ? phoneFmt(invite.phone) : form.phone}
                        onChange={set("phone")}
                        {...focusProps("phone")}
                        disabled={Boolean(invite?.phone)}
                        inputMode="tel"
                        autoComplete="tel"
                        required
                      />
                    </div>
                  </>
                ) : (
                  <>
                    <h1>Seu acesso</h1>
                    <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>É com esse e-mail e senha que você entra no painel.</p>
                    <div className="field"><label>E-mail</label><input className="input" type="email" value={form.email} onChange={set("email")} {...focusProps("email")} autoComplete="email" autoFocus required /></div>
                    <div className="field">
                      <label>Senha</label>
                      <input className="input" type="password" value={form.password} onChange={set("password")} {...focusProps("password")} minLength={8} autoComplete="new-password" required />
                      <span className="help">Pelo menos 8 caracteres.</span>
                    </div>
                    <label className="terms-check">
                      <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
                      <span>
                        Li e aceito os <a href="/privacidade" target="_blank" rel="noreferrer">termos de uso e a política de privacidade</a>.
                      </span>
                    </label>
                  </>
                )}
              </div>
              <ErrorBox error={error} />
              <div className="signup-actions">
                {at > 0 ? (
                  <button type="button" className="btn" onClick={back} disabled={busy}>
                    Voltar
                  </button>
                ) : null}
                <button
                  className="btn btn-primary"
                  disabled={busy || found || !canRegister || (step === "code" && cleanCode(typed).length < 6) || (step === "access" && !terms)}
                  onClick={() => haptic(10)}
                >
                  {busy ? "Aguarde…" : found ? "Achei!" : step === "access" ? "Criar conta" : "Continuar"}
                </button>
              </div>
              <p className="muted" style={{ textAlign: "center", marginBottom: 0, fontSize: 13 }}>
                Já tem conta?{" "}
                <button type="button" className="link" onClick={() => { setMode("login"); setError(null); }}>Entrar</button>
              </p>
            </>
          ) : (
            <>
              <h1>Entrar</h1>
              <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>Acesse o painel do seu assistente.</p>
              <div className="field"><label>E-mail</label><input className="input" type="email" value={form.email} onChange={set("email")} {...focusProps("email")} autoComplete="email" autoFocus required /></div>
              <div className="field">
                <label>Senha</label>
                <input className="input" type="password" value={form.password} onChange={set("password")} {...focusProps("password")} autoComplete="current-password" required />
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
