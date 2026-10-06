import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api";
import { Loading } from "./components";
import { useApi } from "./hooks";
import { AccountsPage } from "./pages/Accounts";
import { AgentsPage } from "./pages/Agents";
import { ConversationsPage } from "./pages/Conversations";
import { ExecutionDetailPage, ExecutionsPage } from "./pages/Executions";
import { FinancePage } from "./pages/Finance";
import { HomePage } from "./pages/Home";
import { IntegrationsPage } from "./pages/Integrations";
import { AuthPage } from "./pages/Login";
import { MemoriesPage } from "./pages/Memories";
import { ModelsPage } from "./pages/Models";
import { OverviewPage } from "./pages/Overview";
import { PeoplePage } from "./pages/People";
import { PlaygroundPage } from "./pages/Playground";
import { ProfilePage } from "./pages/Profile";
import { RemindersPage } from "./pages/Reminders";
import { SettingsPage } from "./pages/Settings";
import { WhatsAppPage } from "./pages/WhatsApp";

export interface Me {
  id: string;
  email: string;
  name: string | null;
  role: "superadmin" | "admin";
  owner: boolean;
  linked: boolean;
}

type NavItem = { section: string } | { to: string; label: string; icon: string; badge?: string };

/** Super admin (dono da stack): tudo. Admin (quem se cadastrou): só os próprios dados. */
const SUPER_NAV: NavItem[] = [
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
  { to: "/finance", label: "Finanças", icon: "💰" },
  { to: "/reminders", label: "Lembretes", icon: "⏰" },
  { to: "/memories", label: "Memórias", icon: "🧩" },
  { section: "Administração" },
  { to: "/people", label: "Pessoas", icon: "👥" },
  { to: "/accounts", label: "Contas do painel", icon: "🔐", badge: "accounts" },
  { to: "/settings", label: "Configurações", icon: "⚑" },
];

const ADMIN_NAV: NavItem[] = [
  { section: "Meu Planejai" },
  { to: "/", label: "Início", icon: "◫" },
  { to: "/finance", label: "Meus gastos", icon: "💰" },
  { to: "/reminders", label: "Lembretes", icon: "⏰" },
  { to: "/conversations", label: "Conversas", icon: "💬" },
  { to: "/memories", label: "O que ele sabe de mim", icon: "🧩" },
  { section: "Conta" },
  { to: "/profile", label: "Minha conta", icon: "👤" },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "light");
  const [menu, setMenu] = useState(false);
  const loc = useLocation();

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe, () => setMe(null));
    const onLogout = () => setMe(null);
    window.addEventListener("pj:logout", onLogout);
    return () => window.removeEventListener("pj:logout", onLogout);
  }, []);
  useEffect(() => setMenu(false), [loc.pathname]);

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
  if (!me) return <AuthPage onLogin={setMe} />;

  const isSuper = me.role === "superadmin";
  return (
    <div className="layout">
      <header className="topbar">
        <button className="btn btn-sm" onClick={() => setMenu(true)} aria-label="Menu">☰</button>
        <div className="brand-logo" style={{ width: 28, height: 28, fontSize: 13 }}>P</div>
        Planejai
      </header>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-logo">P</div>
          <div>
            Planejai
            <small>{isSuper ? "Super admin" : "Painel"}</small>
          </div>
        </div>
        <Nav items={isSuper ? SUPER_NAV : ADMIN_NAV} isSuper={isSuper} />
        <div className="sidebar-foot">
          <div className="me">
            <div className="avatar">{(me.name ?? me.email).slice(0, 1).toUpperCase()}</div>
            <div style={{ minWidth: 0 }}>
              <div className="me-name">{me.name ?? me.email}</div>
              <div className="role-tag">{me.owner ? "Dono da stack" : isSuper ? "Super admin" : "Admin"}</div>
            </div>
          </div>
          <div className="row">
            <button className="btn btn-sm" style={{ flex: 1 }} onClick={toggleTheme}>
              {theme === "dark" ? "☀ Claro" : "☾ Escuro"}
            </button>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await api("/api/auth/logout", { method: "POST" });
                setMe(null);
              }}
            >
              Sair
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          {isSuper ? (
            <>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/executions" element={<ExecutionsPage />} />
              <Route path="/executions/:id" element={<ExecutionDetailPage />} />
              <Route path="/playground" element={<PlaygroundPage />} />
              <Route path="/whatsapp" element={<WhatsAppPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/people" element={<PeoplePage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </>
          ) : (
            <>
              <Route path="/" element={<HomePage me={me} />} />
              <Route path="/profile" element={<ProfilePage me={me} />} />
            </>
          )}
          <Route path="/finance" element={<FinancePage isSuper={isSuper} />} />
          <Route path="/reminders" element={<RemindersPage isSuper={isSuper} />} />
          <Route path="/memories" element={<MemoriesPage isSuper={isSuper} />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/conversations/:id" element={<ConversationsPage />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}

function Nav({ items, isSuper }: { items: NavItem[]; isSuper: boolean }) {
  const accounts = useApi<any[]>(isSuper ? "/api/accounts" : null, { poll: 60000 });
  const pending = (accounts.data ?? []).filter((a) => a.status === "pending").length;
  return (
    <nav className="nav">
      {items.map((item, i) =>
        "section" in item ? (
          <div className="nav-section" key={i}>
            {item.section}
          </div>
        ) : (
          <NavLink key={item.to} to={item.to} end={item.to === "/"}>
            <span className="ico">{item.icon}</span>
            {item.label}
            {item.badge === "accounts" && pending > 0 && <span className="count">{pending}</span>}
          </NavLink>
        ),
      )}
    </nav>
  );
}
