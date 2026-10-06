import { useEffect, useState } from "react";
import { api } from "../api";
import type { Me } from "../App";
import { ErrorBox } from "../components";

export function AuthPage({ onLogin }: { onLogin: (me: Me) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [signup, setSignup] = useState<string>("approval");
  const [form, setForm] = useState({ name: "", email: "", password: "", phone: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  useEffect(() => {
    api("/api/auth/config").then((c) => setSignup(c.signupMode), () => {});
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") onLogin(await api("/api/auth/login", { method: "POST", json: { email: form.email, password: form.password } }));
      else {
        const r = await api("/api/auth/register", { method: "POST", json: form });
        if (r.pending) setDone(r.message);
        else onLogin(r);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <section className="auth-hero">
        <div className="brand" style={{ padding: 0, color: "#fff" }}>
          <div className="brand-logo" style={{ background: "rgba(255,255,255,0.2)", boxShadow: "none" }}>P</div>
          Planejai
        </div>
        <div>
          <h2>Seu assistente no WhatsApp que resolve de verdade.</h2>
          <p>Um time de agentes de IA que pesquisa, lembra, anota seus gastos e cuida da sua rotina, numa conversa só.</p>
          <div className="features">
            <div>💬 Fala, texto, foto e documento: ele entende tudo</div>
            <div>💰 Mandou o comprovante, o gasto já está anotado</div>
            <div>⏰ Lembretes naturais, do jeito que você fala</div>
            <div>🔎 Pesquisa na internet e até grava a tela para você ver</div>
          </div>
        </div>
        <small style={{ opacity: 0.75 }}>Planejai · assistente pessoal</small>
      </section>
      <section className="auth-form">
        <form className="card" onSubmit={submit}>
          {done ? (
            <>
              <h1>Quase lá! 🎉</h1>
              <p className="muted">{done}</p>
              <button type="button" className="btn" onClick={() => { setDone(null); setMode("login"); }}>Voltar para o login</button>
            </>
          ) : (
            <>
              <h1>{mode === "login" ? "Entrar" : "Criar conta"}</h1>
              <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
                {mode === "login" ? "Acesse o painel do seu assistente." : "Use o mesmo número de WhatsApp que conversa com o assistente."}
              </p>
              {mode === "register" && (
                <>
                  <div className="field"><label>Nome</label><input className="input" value={form.name} onChange={set("name")} autoFocus required /></div>
                  <div className="field"><label>WhatsApp</label><input className="input" placeholder="(19) 99999-9999" value={form.phone} onChange={set("phone")} required /></div>
                </>
              )}
              <div className="field"><label>E-mail</label><input className="input" type="email" value={form.email} onChange={set("email")} autoFocus={mode === "login"} required /></div>
              <div className="field">
                <label>Senha</label>
                <input className="input" type="password" value={form.password} onChange={set("password")} minLength={mode === "register" ? 8 : undefined} required />
                {mode === "register" && <span className="help">Pelo menos 8 caracteres.</span>}
              </div>
              <ErrorBox error={error} />
              <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 12, padding: "10px 12px" }} disabled={busy}>
                {busy ? "Aguarde…" : mode === "login" ? "Entrar" : "Criar conta"}
              </button>
              {signup !== "closed" && (
                <p className="muted" style={{ textAlign: "center", marginBottom: 0 }}>
                  {mode === "login" ? "Ainda não tem conta? " : "Já tem conta? "}
                  <button type="button" className="link" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>
                    {mode === "login" ? "Cadastre-se" : "Entrar"}
                  </button>
                </p>
              )}
            </>
          )}
        </form>
      </section>
    </div>
  );
}
