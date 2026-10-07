import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { Loading, Modal } from "./components";
import { AuthPage } from "./pages/Login";
import { canInstall, haptic, isIos, isStandalone, onInstallAvailable, promptInstall } from "./touch";

// Cada tela é carregada só quando abre (o app inicia leve no celular) e, logo depois, baixada em segundo plano
const PAGE_LOADERS = [
  () => import("./pages/Dashboard"),
  () => import("./pages/Finance"),
  () => import("./pages/Calendar"),
  () => import("./pages/Watches"),
  () => import("./pages/Invites"),
  () => import("./pages/Team"),
  () => import("./pages/Memories"),
  () => import("./pages/Profile"),
  () => import("./pages/Agents"),
  () => import("./pages/Clients"),
  () => import("./pages/Executions"),
  () => import("./pages/Queues"),
];
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
const QueuesPage = lazy(() => import("./pages/Queues").then((m) => ({ default: m.QueuesPage })));
const TeamPage = lazy(() => import("./pages/Team").then((m) => ({ default: m.TeamPage })));
const CustomTabPage = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.CustomTabPage })));
const WhatsAppPage = lazy(() => import("./pages/WhatsApp").then((m) => ({ default: m.WhatsAppPage })));
import { clearApiCache, prefetchApi, useApi } from "./hooks";
import { PullToRefresh } from "./PullToRefresh";
import { applyUpdate, onUpdateAvailable } from "./update";
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
  { to: "/queues", label: "Filas", icon: "list" },
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

interface AppTabs {
  all: boolean;
  modules: string[];
  custom: { slug: string; title: string; icon: string; widgets: string[] }[];
  catalog: Record<string, { label: string; icon: string; to: string }>;
}

/**
 * Cliente começa só com o essencial (Início, Agenda, Finanças e De olho). Módulos e abas sob medida
 * aparecem quando a reunião noturna do time libera para a pessoa.
 */
function adminNav(tabs: AppTabs | null): NavItem[] {
  const extra: NavItem[] = [
    ...(tabs?.modules ?? []).map((m) => tabs!.catalog[m]).filter(Boolean).map((m) => ({ to: m!.to, label: m!.label, icon: m!.icon })),
    ...(tabs?.custom ?? []).map((t) => ({ to: `/aba/${t.slug}`, label: t.title, icon: t.icon })),
  ];
  return [
    { section: "Meu Planejai" },
    { to: "/", label: "Início", icon: "home" },
    { to: "/agenda", label: "Agenda", icon: "calendar" },
    { to: "/finance", label: "Finanças", icon: "wallet" },
    { to: "/watches", label: "Acompanhamentos", icon: "eye", short: "De olho" },
    ...(extra.length ? [{ section: "Feito para você" }, ...extra] : []),
    { section: "Conta" },
    { to: "/profile", label: "Minha conta", icon: "user" },
  ];
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "light");
  const [menu, setMenu] = useState(false);
  const [installable, setInstallable] = useState(canInstall());
  const loc = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // barra de baixo: a aba aberta desliza para o meio (dá para rolar para os lados)
  useEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>(".tab.active");
    el?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [loc.pathname]);
  const [update, setUpdate] = useState(false);
  useEffect(() => onUpdateAvailable(setUpdate), []);
  // trocou de tela: começa do topo
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [loc.pathname]);
  // conta nova: nada do cache da anterior; depois esquenta as telas que mais se abre e baixa o código delas
  useEffect(() => {
    clearApiCache();
    if (!me) return;
    const d = new Date();
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const t = setTimeout(() => {
      ["/api/me/overview", `/api/finance?month=${month}`, "/api/watches", "/api/me/dashboard"].forEach(prefetchApi);
      for (const load of PAGE_LOADERS) load().catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [me?.id]);
  const nav = useNavigate();
  useEffect(() => onInstallAvailable(() => setInstallable(true)), []);
  const tabs = useApi<AppTabs>(me ? `/api/me/tabs?for=${me.id}` : null);

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
  const NAV = isSuper ? SUPER_NAV : adminNav(tabs.data ?? null);
  const has = (m: string) => isSuper || (tabs.data?.modules ?? []).includes(m);
  return (
    <div className="layout">
      <header className="topbar">
        <Logo size={28} />
        <strong className="topbar-title">{titleFor(loc.pathname, NAV)}</strong>
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
        <Nav items={NAV} isSuper={isSuper} />
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
      <main className="main" ref={mainRef}>
        <PullToRefresh target={mainRef} />
        <Suspense fallback={<Loading />}>
        <div className="route-fade" key={loc.pathname}>
        <Routes>
          {isSuper ? (
            <>
              <Route path="/executions" element={<ExecutionsPage />} />
              <Route path="/executions/:id" element={<ExecutionDetailPage />} />
              <Route path="/queues" element={<QueuesPage />} />
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
          {has("convites") && <Route path="/invites" element={<InvitesPage isSuper={isSuper} />} />}
          {has("meu_time") && <Route path="/time" element={<TeamPage />} />}
          {(tabs.data?.custom ?? []).map((t) => (
            <Route key={t.slug} path={`/aba/${t.slug}`} element={<CustomTabPage me={me} tab={t} />} />
          ))}
          <Route path="/watches" element={<WatchesPage isSuper={isSuper} />} />
          <Route path="/finance" element={<FinancePage isSuper={isSuper} />} />
          <Route path="/agenda" element={<CalendarPage isSuper={isSuper} />} />
          <Route path="/reminders" element={<Navigate to="/agenda" replace />} />
          {has("memorias") && <Route path="/memories" element={<MemoriesPage isSuper={isSuper} />} />}
          <Route path="*" element={tabs.loading && !isSuper ? <Loading /> : <Navigate to="/" />} />
        </Routes>
        </div>
        </Suspense>
      </main>

      {update && (
        <div className="update-pill" role="status">
          <span>Nova versão do Planejai</span>
          <button className="btn btn-sm btn-brand" onClick={() => { haptic(10); void applyUpdate(); }}>Atualizar</button>
        </div>
      )}

      <nav className="tabbar" aria-label="Navegação">
        <div className="tabbar-pill">
          <div className="tabbar-scroll" ref={tabsRef}>
            {NAV.filter((i): i is Exclude<NavItem, { section: string }> => "to" in i).map((t) => (
              <NavLink key={t.to} to={t.to} end={t.to === "/"} className="tab">
                <span className="tab-ico"><Icon name={t.icon} size={21} /></span>
                <span className="tab-label">{t.short ?? t.label}</span>
              </NavLink>
            ))}
          </div>
          <button className={`tab tab-more ${menu ? "active" : ""}`} onClick={() => setMenu(true)}>
            <span className="tab-ico"><Icon name="more" size={21} /></span>
            <span className="tab-label">Mais</span>
          </button>
        </div>
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
            {NAV.filter((i): i is Exclude<NavItem, { section: string }> => "to" in i).map((item) => (
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
  const hit = (items.find((i) => "to" in i && i.to === path) ?? items.find((i) => "to" in i && i.to === base)) as { label: string } | undefined;
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
