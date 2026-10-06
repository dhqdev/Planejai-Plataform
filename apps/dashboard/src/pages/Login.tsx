import { useState } from "react";
import { api } from "../api";
import { ErrorBox } from "../components";

export function LoginPage({ onLogin }: { onLogin: (me: { email: string }) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="login">
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onLogin(await api("/api/auth/login", { method: "POST", json: { email, password } }));
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
          <div className="brand-logo">P</div>
          Planejai
        </div>
        <div className="field">
          <label>E-mail</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Senha</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <ErrorBox error={error} />
        <button className="btn btn-primary" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} disabled={busy}>
          Entrar
        </button>
      </form>
    </div>
  );
}
