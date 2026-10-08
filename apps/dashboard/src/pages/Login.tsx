import { useEffect, useState } from "react";
import { api } from "../api";
import type { Me } from "../App";
import { ErrorBox } from "../components";
import { haptic } from "../touch";
import { Mochi } from "../mochi/Mochi";

interface Invite {
  name: string | null;
  email: string | null;
  phone: string;
  inviter: string | null;
  used: boolean;
}

/** Código do convite quando a pessoa abre o link /convite/CODIGO. */
const inviteCode = () => /^\/convite\/([A-Za-z0-9]+)/.exec(location.pathname)?.[1]?.toUpperCase() ?? null;

export function AuthPage({ onLogin }: { onLogin: (me: Me) => void }) {
  const code = inviteCode();
  const [mode, setMode] = useState<"login" | "register">(code ? "register" : "login");
  const [signup, setSignup] = useState<string>("invite");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState(false);
  // navegador novo: depois da senha, código de 6 dígitos que chega no WhatsApp
  const [challenge, setChallenge] = useState<{ id: string; to: string } | null>(null);
  const [otp, setOtp] = useState("");
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    api("/api/auth/config").then((c) => setSignup(c.signupMode), () => {});
    if (code)
      api<Invite>(`/api/invite/${code}`).then(
        (i) => {
          setInvite(i);
          setForm((f) => ({ ...f, name: i.name ?? "", email: i.email ?? "", phone: i.phone }));
          if (i.used) setMode("login");
        },
        (e) => setError((e as Error).message),
      );
  }, [code]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login" && challenge) {
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
        if (form.name.trim().split(/\s+/).length < 2) throw new Error("Informe nome e sobrenome");
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

  const canRegister = signup !== "closed" && (signup !== "invite" || Boolean(code));

  return (
    <div className="auth">
      <section className="auth-hero">
        <div className="brand" style={{ padding: 0 }}>
          <Mochi size={44} crop mood={busy ? "working" : "greeting"} />
          planejai
        </div>
        <div>
          <h2>Seu assistente no WhatsApp que resolve de verdade.</h2>
          <p>Um time de agentes que pesquisa, lembra, anota seus gastos e fica de olho no que importa para você.</p>
          <div className="features">
            <div>Fala, texto, foto e documento</div>
            <div>Comprovante enviado, gasto anotado</div>
            <div>Lembretes do jeito que você fala</div>
            <div>Avisa sozinho quando o preço baixa</div>
          </div>
        </div>
        <small style={{ opacity: 0.6 }}>Entrada só por convite</small>
      </section>
      <section className="auth-form">
        <form className="card" onSubmit={submit}>
          <div className="auth-logo"><Mochi size={96} crop mood={error ? "error" : busy ? "working" : done ? "finished" : "greeting"} follow /></div>
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
          ) : done ? (
            <>
              <h1>Quase lá</h1>
              <p className="muted">{done}</p>
              <button type="button" className="btn" onClick={() => { setDone(null); setMode("login"); }}>Voltar para o login</button>
            </>
          ) : (
            <>
              <h1>{mode === "login" ? "Entrar" : invite ? `Olá${invite.name ? `, ${invite.name.split(" ")[0]}` : ""}` : "Criar conta"}</h1>
              <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
                {mode === "login"
                  ? "Acesse o painel do seu assistente."
                  : invite?.inviter
                    ? `${invite.inviter} convidou você. Crie sua senha para acessar o painel.`
                    : "Use o mesmo número de WhatsApp que conversa com o assistente."}
              </p>
              {mode === "register" && (
                <>
                  <div className="field"><label>Nome completo</label><input className="input" value={form.name} onChange={set("name")} autoComplete="name" autoFocus required /></div>
                  <div className="field">
                    <label>WhatsApp</label>
                    <input className="input" placeholder="(19) 99999-9999" value={invite ? `+${invite.phone}` : form.phone} onChange={set("phone")} disabled={Boolean(invite)} inputMode="tel" required />
                  </div>
                </>
              )}
              <div className="field"><label>E-mail</label><input className="input" type="email" value={form.email} onChange={set("email")} autoComplete="email" autoFocus={mode === "login"} required /></div>
              <div className="field">
                <label>Senha</label>
                <input className="input" type="password" value={form.password} onChange={set("password")} minLength={mode === "register" ? 8 : undefined} autoComplete={mode === "login" ? "current-password" : "new-password"} required />
                {mode === "register" && <span className="help">Pelo menos 8 caracteres.</span>}
              </div>
              {mode === "register" && (
                <label className="terms-check">
                  <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
                  <span>
                    Li e aceito os <a href="/privacidade" target="_blank" rel="noreferrer">termos de uso e a política de privacidade</a>.
                  </span>
                </label>
              )}
              <ErrorBox error={error} />
              <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 12, padding: "10px 12px" }} disabled={busy || (mode === "register" && (!canRegister || !terms))}>
                {busy ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}
              </button>
              <p className="muted" style={{ textAlign: "center", marginBottom: 0, fontSize: 13 }}>
                {mode === "register" ? (
                  <>
                    Já tem conta?{" "}
                    <button type="button" className="link" onClick={() => { setMode("login"); setError(null); }}>Entrar</button>
                  </>
                ) : canRegister ? (
                  <>
                    Ainda não tem conta?{" "}
                    <button type="button" className="link" onClick={() => { setMode("register"); setError(null); }}>Cadastre-se</button>
                  </>
                ) : signup === "invite" ? (
                  "O Planejai é só por convite. Peça um convite a quem já usa: ele chega no seu WhatsApp."
                ) : null}
              </p>
            </>
          )}
        </form>
      </section>
    </div>
  );
}
