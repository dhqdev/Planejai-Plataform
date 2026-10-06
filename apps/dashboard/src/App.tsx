import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api";
import { Loading } from "./components";
import { AgentsPage } from "./pages/Agents";
import { ConversationsPage } from "./pages/Conversations";
import { ExecutionDetailPage, ExecutionsPage } from "./pages/Executions";
import { IntegrationsPage } from "./pages/Integrations";
import { LoginPage } from "./pages/Login";
import { ModelsPage } from "./pages/Models";
import { OverviewPage } from "./pages/Overview";
import { PeoplePage } from "./pages/People";
import { PlaygroundPage } from "./pages/Playground";
import { RemindersPage } from "./pages/Reminders";
import { SettingsPage } from "./pages/Settings";
import { WhatsAppPage } from "./pages/WhatsApp";

const NAV = [
  { section: "Visão geral" },
  { to: "/", label: "Painel", icon: "◫" },
  { to: "/executions", label: "Execuções", icon: "≡" },
  { to: "/conversations", label: "Conversas", icon: "💬" },
  { to: "/playground", label: "Playground", icon: "▶" },
  { section: "Agente" },
  { to: "/whatsapp", label: "WhatsApp", icon: "📱" },
  { to: "/agents", label: "Time de agentes", icon: "🧠" },
  { to: "/integrations", label: "Integrações", icon: "🔌" },
  { to: "/models", label: "Modelos", icon: "⚙" },
  { section: "Dados" },
  { to: "/reminders", label: "Lembretes", icon: "⏰" },
  { to: "/people", label: "Pessoas", icon: "👥" },
  { to: "/settings", label: "Configurações", icon: "⚑" },
] as const;

export function App() {
  const [me, setMe] = useState<{ email: string } | null | undefined>(undefined);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "light");

  useEffect(() => {
    api("/api/auth/me").then(setMe, () => setMe(null));
    const onLogout = () => setMe(null);
    window.addEventListener("pj:logout", onLogout);
    return () => window.removeEventListener("pj:logout", onLogout);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("pj-theme", next);
    } catch {
      /* sem storage */
    }
    setTheme(next);
  };

  if (me === undefined) return <Loading />;
  if (!me) return <LoginPage onLogin={setMe} />;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">P</div>
          Planejai
        </div>
        <nav className="nav">
          {NAV.map((item, i) =>
            "section" in item ? (
              <div className="nav-section" key={i}>
                {item.section}
              </div>
            ) : (
              <NavLink key={item.to} to={item.to} end={item.to === "/"}>
                <span className="ico">{item.icon}</span>
                {item.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-foot">
          <button className="btn btn-sm" onClick={toggleTheme}>
            {theme === "dark" ? "☀ Tema claro" : "☾ Tema escuro"}
          </button>
          <span>{me.email}</span>
          <button
            className="btn btn-sm btn-ghost"
            onClick={async () => {
              await api("/api/auth/logout", { method: "POST" });
              setMe(null);
            }}
          >
            Sair
          </button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/executions" element={<ExecutionsPage />} />
          <Route path="/executions/:id" element={<ExecutionDetailPage />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:id" element={<ConversationsPage />} />
          <Route path="/playground" element={<PlaygroundPage />} />
          <Route path="/whatsapp" element={<WhatsAppPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/reminders" element={<RemindersPage />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
