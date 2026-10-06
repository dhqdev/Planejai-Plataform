import { lazy, Suspense, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { Loading, Modal } from "./components";
import { AuthPage } from "./pages/Login";
import { canInstall, haptic, isIos, isStandalone, onInstallAvailable, promptInstall } from "./touch";

// Cada tela é carregada só quando abre: o app inicia leve no celular
const AccountsPage = lazy(() => import("./pages/Accounts").then((m) => ({ default: m.AccountsPage })));
const AgentsPage = lazy(() => import("./pages/Agents").then((m) => ({ default: m.AgentsPage })));
const ConversationsPage = lazy(() => import("./pages/Conversations").then((m) => ({ default: m.ConversationsPage })));
const ExecutionDetailPage = lazy(() => import("./pages/Executions").then((m) => ({ default: m.ExecutionDetailPage })));
const ExecutionsPage = lazy(() => import("./pages/Executions").then((m) => ({ default: m.ExecutionsPage })));
const FinancePage = lazy(() => import("./pages/Finance").then((m) => ({ default: m.FinancePage })));
const HomePage = lazy(() => import("./pages/Home").then((m) => ({ default: m.HomePage })));
const IntegrationsPage = lazy(() => import("./pages/Integrations").then((m) => ({ default: m.IntegrationsPage })));
const MemoriesPage = lazy(() => import("./pages/Memories").then((m) => ({ default: m.MemoriesPage })));
const ModelsPage = lazy(() => import("./pages/Models").then((m) => ({ default: m.ModelsPage })));
const OverviewPage = lazy(() => import("./pages/Overview").then((m) => ({ default: m.OverviewPage })));
const PeoplePage = lazy(() => import("./pages/People").then((m) => ({ default: m.PeoplePage })));
const PlaygroundPage = lazy(() => import("./pages/Playground").then((m) => ({ default: m.PlaygroundPage })));
const ProfilePage = lazy(() => import("./pages/Profile").then((m) => ({ default: m.ProfilePage })));
const RemindersPage = lazy(() => import("./pages/Reminders").then((m) => ({ default: m.RemindersPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const WhatsAppPage = lazy(() => import("./pages/WhatsApp").then((m) => ({ default: m.WhatsAppPage })));
import { useApi } from "./hooks";

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

/** Abas da barra inferior no celular; o resto fica em "Mais". */
const SUPER_TABS = [
  { to: "/", label: "Painel", icon: "◫" },
  { to: "/conversations", label: "Conversas", icon: "💬" },
  { to: "/finance", label: "Finanças", icon: "💰" },
  { to: "/playground", label: "Testar", icon: "▶" },
];
const ADMIN_TABS = [
  { to: "/", label: "Início", icon: "◫" },
  { to: "/finance", label: "Gastos", icon: "💰" },
  { to: "/reminders", label: "Lembretes", icon: "⏰" },
  { to: "/conversations", label: "Conversas", icon: "💬" },
];

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "light");
  const [menu, setMenu] = useState(false);
  const [installable, setInstallable] = useState(canInstall());
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => onInstallAvailable(() => setInstallable(true)), []);

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe, () => setMe(null));
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
  if (!me) return <AuthPage onLogin={setMe} />;

  const isSuper = me.role === "superadmin";
  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand-logo" style={{ width: 30, height: 30, fontSize: 14 }}>P</div>
        <strong className="topbar-title">{titleFor(loc.pathname, isSuper ? SUPER_NAV : ADMIN_NAV)}</strong>
        <span className="spacer" />
        <button className="icon-btn" onClick={toggleTheme} aria-label="Trocar tema">{theme === "dark" ? "☀" : "☾"}</button>
      </header>
      <aside className="sidebar">
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
        <Suspense fallback={<Loading />}>
        <div className="route-fade" key={loc.pathname}>
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
        </div>
        </Suspense>
      </main>

      <nav className="tabbar" aria-label="Navegação">
        {(isSuper ? SUPER_TABS : ADMIN_TABS).map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === "/"} className="tab">
            <span className="tab-ico">{t.icon}</span>
            <span>{t.label}</span>
          </NavLink>
        ))}
        <button className={`tab ${menu ? "active" : ""}`} onClick={() => setMenu(true)}>
          <span className="tab-ico">☰</span>
          <span>Mais</span>
        </button>
      </nav>

      {menu && (
        <Modal title="Menu" onClose={() => setMenu(false)}>
          {!isStandalone() && (installable || isIos()) && (
            <div className="install-card">
              <div className="brand-logo">P</div>
              <div style={{ flex: 1 }}>
                <strong>Instalar o Planejai</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {installable ? "Abre como app, em tela cheia." : "No Safari: toque em Compartilhar e depois em \"Adicionar à Tela de Início\"."}
                </div>
              </div>
              {installable && <button className="btn btn-primary btn-sm" onClick={async () => { if (await promptInstall()) setInstallable(false); }}>Instalar</button>}
            </div>
          )}
          <div className="sheet-nav">
            {(isSuper ? SUPER_NAV : ADMIN_NAV).map((item, i) =>
              "section" in item ? (
                <div className="nav-section" key={i}>{item.section}</div>
              ) : (
                <button key={item.to} className={`sheet-item ${loc.pathname === item.to ? "active" : ""}`} onClick={() => { haptic(); setMenu(false); nav(item.to); }}>
                  <span className="ico">{item.icon}</span>
                  {item.label}
                  <span className="chev">›</span>
                </button>
              ),
            )}
          </div>
          <div className="me" style={{ marginTop: 14 }}>
            <div className="avatar">{(me.name ?? me.email).slice(0, 1).toUpperCase()}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="me-name">{me.name ?? me.email}</div>
              <div className="role-tag">{me.owner ? "Dono da stack" : isSuper ? "Super admin" : "Admin"}</div>
            </div>
            <button className="btn btn-sm" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setMenu(false); setMe(null); }}>Sair</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function titleFor(path: string, items: NavItem[]) {
  const base = "/" + (path.split("/")[1] ?? "");
  const hit = items.find((i) => "to" in i && i.to === base) as { label: string } | undefined;
  return hit?.label ?? "Planejai";
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
