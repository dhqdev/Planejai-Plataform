import { lazy, Suspense, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { Loading, Modal } from "./components";
import { AuthPage } from "./pages/Login";
import { canInstall, haptic, isIos, isStandalone, onInstallAvailable, promptInstall } from "./touch";

// Cada tela é carregada só quando abre: o app inicia leve no celular
const AgentsPage = lazy(() => import("./pages/Agents").then((m) => ({ default: m.AgentsPage })));
const ClientsPage = lazy(() => import("./pages/Clients").then((m) => ({ default: m.ClientsPage })));
const DashboardPage = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.DashboardPage })));
const ExecutionDetailPage = lazy(() => import("./pages/Executions").then((m) => ({ default: m.ExecutionDetailPage })));
const ExecutionsPage = lazy(() => import("./pages/Executions").then((m) => ({ default: m.ExecutionsPage })));
const FinancePage = lazy(() => import("./pages/Finance").then((m) => ({ default: m.FinancePage })));
const IntegrationsPage = lazy(() => import("./pages/Integrations").then((m) => ({ default: m.IntegrationsPage })));
const InvitesPage = lazy(() => import("./pages/Invites").then((m) => ({ default: m.InvitesPage })));
const MemoriesPage = lazy(() => import("./pages/Memories").then((m) => ({ default: m.MemoriesPage })));
const ModelsPage = lazy(() => import("./pages/Models").then((m) => ({ default: m.ModelsPage })));
const ProfilePage = lazy(() => import("./pages/Profile").then((m) => ({ default: m.ProfilePage })));
const CalendarPage = lazy(() => import("./pages/Calendar").then((m) => ({ default: m.CalendarPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
const WatchesPage = lazy(() => import("./pages/Watches").then((m) => ({ default: m.WatchesPage })));
const WhatsAppPage = lazy(() => import("./pages/WhatsApp").then((m) => ({ default: m.WhatsAppPage })));
import { useApi } from "./hooks";
import { Icon, Logo } from "./icons";

export interface Me {
  id: string;
  email: string;
  name: string | null;
  role: "superadmin" | "admin";
  owner: boolean;
  linked: boolean;
}

type NavItem = { section: string } | { to: string; label: string; icon: string; badge?: string; short?: string };

/** Super admin (dono da stack): tudo. Admin (cliente com acesso ao painel): só os próprios dados. */
const SUPER_NAV: NavItem[] = [
  { section: "Visão geral" },
  { to: "/", label: "Painel", icon: "home" },
  { to: "/executions", label: "Execuções", icon: "activity" },
  { section: "Pessoas" },
  { to: "/clients", label: "Clientes", icon: "users", badge: "clients" },
  { to: "/invites", label: "Convites", icon: "user-plus" },
  { section: "Agente" },
  { to: "/agents", label: "Agentes", icon: "brain" },
  { to: "/whatsapp", label: "WhatsApp", icon: "phone" },
  { to: "/integrations", label: "Integrações", icon: "plug" },
  { to: "/models", label: "Modelos", icon: "cpu" },
  { section: "Dados" },
  { to: "/finance", label: "Finanças", icon: "wallet" },
  { to: "/agenda", label: "Agenda", icon: "calendar" },
  { to: "/watches", label: "Acompanhamentos", icon: "eye", short: "De olho" },
  { to: "/memories", label: "Memórias", icon: "bookmark" },
  { section: "Sistema" },
  { to: "/settings", label: "Configurações", icon: "settings" },
];

const ADMIN_NAV: NavItem[] = [
  { section: "Meu Planejai" },
  { to: "/", label: "Início", icon: "home" },
  { to: "/finance", label: "Gastos", icon: "wallet" },
  { to: "/agenda", label: "Agenda", icon: "calendar" },
  { to: "/watches", label: "Acompanhamentos", icon: "eye", short: "De olho" },
  { to: "/invites", label: "Convites", icon: "user-plus" },
  { to: "/memories", label: "O que ele sabe", icon: "bookmark" },
  { section: "Conta" },
  { to: "/profile", label: "Minha conta", icon: "user" },
];

/** Abas da barra inferior no celular; o resto fica em "Mais". */
const SUPER_TABS = [
  { to: "/", label: "Painel", icon: "home" },
  { to: "/clients", label: "Clientes", icon: "users" },
  { to: "/executions", label: "Execuções", icon: "activity" },
  { to: "/agents", label: "Agentes", icon: "brain" },
];
const ADMIN_TABS = [
  { to: "/", label: "Início", icon: "home" },
  { to: "/finance", label: "Gastos", icon: "wallet" },
  { to: "/agenda", label: "Agenda", icon: "calendar" },
  { to: "/invites", label: "Convites", icon: "user-plus" },
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
        <Logo size={28} />
        <strong className="topbar-title">{titleFor(loc.pathname, isSuper ? SUPER_NAV : ADMIN_NAV)}</strong>
        <span className="spacer" />
        <button className="icon-btn" onClick={toggleTheme} aria-label="Trocar tema"><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
      </header>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo"><Logo size={26} /></div>
          <div>
            planejai
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
            <button className="btn btn-sm" style={{ flex: 1 }} onClick={toggleTheme} aria-label="Trocar tema">
              <Icon name={theme === "dark" ? "sun" : "moon"} size={15} /> <span className="label">{theme === "dark" ? "Claro" : "Escuro"}</span>
            </button>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await api("/api/auth/logout", { method: "POST" });
                setMe(null);
              }}
              aria-label="Sair"
            >
              <Icon name="logout" size={15} /> <span className="label">Sair</span>
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
              <Route path="/executions" element={<ExecutionsPage />} />
              <Route path="/executions/:id" element={<ExecutionDetailPage />} />
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/whatsapp" element={<WhatsAppPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
            </>
          ) : (
            <Route path="/profile" element={<ProfilePage me={me} />} />
          )}
          <Route path="/" element={<DashboardPage me={me} theme={theme} onTheme={toggleTheme} />} />
          <Route path="/invites" element={<InvitesPage isSuper={isSuper} />} />
          <Route path="/watches" element={<WatchesPage isSuper={isSuper} />} />
          <Route path="/finance" element={<FinancePage isSuper={isSuper} />} />
          <Route path="/agenda" element={<CalendarPage isSuper={isSuper} />} />
          <Route path="/reminders" element={<Navigate to="/agenda" replace />} />
          <Route path="/memories" element={<MemoriesPage isSuper={isSuper} />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
        </div>
        </Suspense>
      </main>

      <nav className="tabbar" aria-label="Navegação">
        {(isSuper ? SUPER_TABS : ADMIN_TABS).map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === "/"} className="tab">
            <span className="tab-ico"><Icon name={t.icon} size={22} /></span>
            <span>{t.label}</span>
          </NavLink>
        ))}
        <button className={`tab ${menu ? "active" : ""}`} onClick={() => setMenu(true)}>
          <span className="tab-ico"><Icon name="menu" size={22} /></span>
          <span>Mais</span>
        </button>
      </nav>

      {menu && (
        <Modal title="Menu" onClose={() => setMenu(false)} className="more-sheet">
          {!isStandalone() && (installable || isIos()) && (
            <div className="install-card">
              <div className="brand-logo"><Logo size={26} /></div>
              <div style={{ flex: 1 }}>
                <strong>Instalar o Planejai</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {installable ? "Abre como app, em tela cheia." : "No Safari: toque em Compartilhar e depois em \"Adicionar à Tela de Início\"."}
                </div>
              </div>
              {installable && <button className="btn btn-primary btn-sm" onClick={async () => { if (await promptInstall()) setInstallable(false); }}>Instalar</button>}
            </div>
          )}
          <div className="me more-me">
            <div className="avatar">{(me.name ?? me.email).slice(0, 1).toUpperCase()}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="me-name">{me.name ?? me.email}</div>
              <div className="role-tag">{me.owner ? "Dono da stack" : isSuper ? "Super admin" : "Admin"}</div>
            </div>
          </div>
          <div className="more-grid">
            {(isSuper ? SUPER_NAV : ADMIN_NAV).filter((i): i is Exclude<NavItem, { section: string }> => "to" in i).map((item) => (
              <button key={item.to} className={`more-tile ${loc.pathname === item.to ? "active" : ""}`} onClick={() => { setMenu(false); nav(item.to); }}>
                <Icon name={item.icon} size={26} />
                <span>{item.short ?? item.label}</span>
              </button>
            ))}
            <button className="more-tile" onClick={toggleTheme}>
              <Icon name={theme === "dark" ? "sun" : "moon"} size={26} />
              <span>{theme === "dark" ? "Tema claro" : "Tema escuro"}</span>
            </button>
            <button className="more-tile" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setMenu(false); setMe(null); }}>
              <Icon name="logout" size={26} />
              <span>Sair</span>
            </button>
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
  const clients = useApi<any[]>(isSuper ? "/api/clients" : null, { poll: 60000 });
  const pending = (clients.data ?? []).filter((c) => c.status === "pending" || c.account_status === "pending").length;
  return (
    <nav className="nav">
      {items.map((item, i) =>
        "section" in item ? (
          <div className="nav-section" key={i}>
            {item.section}
          </div>
        ) : (
          <NavLink key={item.to} to={item.to} end={item.to === "/"} title={item.label} data-count={item.badge === "clients" && pending > 0 ? pending : undefined}>
            <Icon name={item.icon} />
            <span className="label">{item.label}</span>
            {item.badge === "clients" && pending > 0 && <span className="count">{pending}</span>}
          </NavLink>
        ),
      )}
    </nav>
  );
}
