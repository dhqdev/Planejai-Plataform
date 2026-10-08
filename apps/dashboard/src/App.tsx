import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { BlockLoader } from "./BlockLoader";
import { Empty, Loading, Modal } from "./components";
import { clearApiCache, prefetchApi, useApi } from "./hooks";
import { Icon } from "./icons";
import { openWardrobe } from "./mochi/state";
import { MochiButton, MochiIcon, WardrobeHost } from "./mochi/Wardrobe";
import { useUnread } from "./notify";
import { AuthPage } from "./pages/Login";
import { PrivacyPage } from "./pages/Privacy";
import { PullToRefresh } from "./PullToRefresh";
import { canInstall, haptic, isIos, isStandalone, onInstallAvailable, promptInstall } from "./touch";
import { applyUpdate, onUpdateAvailable } from "./update";

// Cada tela é um pedaço à parte: baixa só quando abre (o app inicia leve no celular)
const load = {
  agents: () => import("./pages/Agents"),
  calendar: () => import("./pages/Calendar"),
  clients: () => import("./pages/Clients"),
  dashboard: () => import("./pages/Dashboard"),
  documents: () => import("./pages/Documents"),
  executions: () => import("./pages/Executions"),
  finance: () => import("./pages/Finance"),
  integrations: () => import("./pages/Integrations"),
  invites: () => import("./pages/Invites"),
  memories: () => import("./pages/Memories"),
  models: () => import("./pages/Models"),
  notifications: () => import("./pages/Notifications"),
  profile: () => import("./pages/Profile"),
  queues: () => import("./pages/Queues"),
  settings: () => import("./pages/Settings"),
  team: () => import("./pages/Team"),
  watches: () => import("./pages/Watches"),
  whatsapp: () => import("./pages/WhatsApp"),
};

/** Tela sob demanda. Se o pedaço não baixar (sem internet), mostra um aviso no lugar em vez de derrubar o app. */
function page<P>(pick: () => Promise<ComponentType<P>>) {
  return lazy(() => pick().then((c) => ({ default: c }), () => ({ default: PageUnavailable as ComponentType<P> })));
}
function PageUnavailable() {
  return (
    <div className="page">
      <Empty>
        Não deu para abrir esta tela. Confira a internet e tente de novo.{" "}
        <button className="btn btn-sm" onClick={() => location.reload()}>Tentar de novo</button>
      </Empty>
    </div>
  );
}

const AgentsPage = page(() => load.agents().then((m) => m.AgentsPage));
const ClientsPage = page(() => load.clients().then((m) => m.ClientsPage));
const DashboardPage = page(() => load.dashboard().then((m) => m.DashboardPage));
const ExecutionDetailPage = page(() => load.executions().then((m) => m.ExecutionDetailPage));
const ExecutionsPage = page(() => load.executions().then((m) => m.ExecutionsPage));
const FinancePage = page(() => load.finance().then((m) => m.FinancePage));
const IntegrationsPage = page(() => load.integrations().then((m) => m.IntegrationsPage));
const InvitesPage = page(() => load.invites().then((m) => m.InvitesPage));
const MemoriesPage = page(() => load.memories().then((m) => m.MemoriesPage));
const ModelsPage = page(() => load.models().then((m) => m.ModelsPage));
const ProfilePage = page(() => load.profile().then((m) => m.ProfilePage));
const CalendarPage = page(() => load.calendar().then((m) => m.CalendarPage));
const SettingsPage = page(() => load.settings().then((m) => m.SettingsPage));
const WatchesPage = page(() => load.watches().then((m) => m.WatchesPage));
const QueuesPage = page(() => load.queues().then((m) => m.QueuesPage));
const TeamPage = page(() => load.team().then((m) => m.TeamPage));
const CustomTabPage = page(() => load.dashboard().then((m) => m.CustomTabPage));
const NotificationsPage = page(() => load.notifications().then((m) => m.NotificationsPage));
const DocumentsPage = page(() => load.documents().then((m) => m.DocumentsPage));
const WhatsAppPage = page(() => load.whatsapp().then((m) => m.WhatsAppPage));

/** Qual pedaço cada rota do menu abre: para baixar antes do toque (e deixar pronto para abrir sem internet). */
const ROUTE_CHUNK: Record<string, () => Promise<unknown>> = {
  "/": load.dashboard,
  "/notificacoes": load.notifications,
  "/executions": load.executions,
  "/queues": load.queues,
  "/clients": load.clients,
  "/invites": load.invites,
  "/agents": load.agents,
  "/whatsapp": load.whatsapp,
  "/integrations": load.integrations,
  "/models": load.models,
  "/finance": load.finance,
  "/agenda": load.calendar,
  "/watches": load.watches,
  "/documentos": load.documents,
  "/memories": load.memories,
  "/settings": load.settings,
  "/profile": load.profile,
  "/time": load.team,
};
function preload(to: string) {
  ROUTE_CHUNK[to]?.().catch(() => {});
}

/** Versão do app (package.json), igual à release vX.Y.Z no GitHub. */
declare const __APP_VERSION__: string;

export interface Me {
  id: string;
  email: string;
  name: string | null;
  role: "superadmin" | "admin";
  owner: boolean;
  linked: boolean;
}

type NavLinkItem = { to: string; label: string; icon: string; badge?: string; short?: string };
type NavItem = { section: string } | NavLinkItem;
const NO_NAV: NavItem[] = [];

/** Super admin (dono da stack): tudo. Admin (cliente com acesso ao painel): só os próprios dados. */
const SUPER_NAV: NavItem[] = [
  { section: "Visão geral" },
  { to: "/", label: "Painel", icon: "home" },
  { to: "/notificacoes", label: "Notificações", icon: "bell", badge: "notif", short: "Avisos" },
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
  { to: "/documentos", label: "Documentos", icon: "file" },
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
    { to: "/documentos", label: "Documentos", icon: "file" },
    ...(extra.length ? [{ section: "Feito para você" }, ...extra] : []),
    { section: "Conta" },
    { to: "/notificacoes", label: "Notificações", icon: "bell", badge: "notif", short: "Avisos" },
    { to: "/profile", label: "Minha conta", icon: "user" },
  ];
}

/**
 * Não lidas: o poll (30 s) mora neste provedor e só as bolinhas escutam, então o App e a tela aberta
 * não redesenham a cada consulta.
 */
const UnreadContext = createContext(0);
function UnreadProvider({ children }: { children: ReactNode }) {
  return <UnreadContext value={useUnread(true)}>{children}</UnreadContext>;
}
function UnreadDot({ className, count }: { className: string; count?: boolean }) {
  const unread = useContext(UnreadContext);
  return unread > 0 ? <span className={className} aria-label={count ? `${unread} não lidas` : undefined} /> : null;
}
function BellButton() {
  const unread = useContext(UnreadContext);
  const nav = useNavigate();
  return (
    <button className="icon-btn" onClick={() => { haptic(); nav("/notificacoes"); }} aria-label={unread ? `${unread} notificações não lidas` : "Notificações"}>
      <Icon name="bell" />
      {unread > 0 && <span className="bell-dot" />}
    </button>
  );
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
  // conta nova: nada do cache da anterior; depois esquenta os dados das telas que mais se abre
  useEffect(() => {
    clearApiCache();
    if (!me) return;
    const d = new Date();
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const t = setTimeout(() => {
      ["/api/me/overview", `/api/finance?month=${month}`, "/api/watches", "/api/me/dashboard"].forEach(prefetchApi);
    }, 1200);
    return () => clearTimeout(t);
  }, [me?.id]);
  const nav = useNavigate();
  useEffect(() => onInstallAvailable(() => setInstallable(true)), []);
  const tabs = useApi<AppTabs>(me ? `/api/me/tabs?for=${me.id}` : null);
  const isSuper = me?.role === "superadmin";
  const NAV = !me ? NO_NAV : isSuper ? SUPER_NAV : adminNav(tabs.data ?? null);
  const links = NAV.filter((i): i is NavLinkItem => "to" in i);
  // com o app parado, baixa em segundo plano o código das telas do menu desta pessoa (e só delas)
  const routes = links.map((l) => l.to).join(" ");
  useEffect(() => {
    if (!routes) return;
    const t = setTimeout(() => routes.split(" ").forEach(preload), 1200);
    return () => clearTimeout(t);
  }, [routes]);

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

  // termos e privacidade abrem sem login (link do cadastro e do convite no WhatsApp)
  if (loc.pathname === "/privacidade") return <PrivacyPage />;
  if (me === undefined) return <BlockLoader full />;
  if (!me) return <AuthPage onLogin={setMe} />;

  const has = (m: string) => isSuper || (tabs.data?.modules ?? []).includes(m);
  return (
    <UnreadProvider>
    <div className="layout">
      <header className="topbar">
        <MochiButton size={50} />
        <strong className="topbar-title">{titleFor(loc.pathname, NAV)}</strong>
        <span className="spacer" />
        <BellButton />
        <button className="icon-btn" onClick={toggleTheme} aria-label="Trocar tema"><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
      </header>
      <aside className="sidebar">
        <div className="brand">
          <MochiButton size={42} />
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
              <div className="role-tag">{me.owner ? "Dono da stack" : isSuper ? "Super admin" : "Admin"} · <span className="app-version">v{__APP_VERSION__}</span></div>
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
          <Route path="/notificacoes" element={<NotificationsPage />} />
          <Route path="/documentos" element={<DocumentsPage isSuper={isSuper} />} />
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

      <WardrobeHost />

      {update && (
        <div className="update-pill" role="status">
          <span>Nova versão do Planejai</span>
          <button className="btn btn-sm btn-brand" onClick={() => { haptic(10); void applyUpdate(); }}>Atualizar</button>
        </div>
      )}

      <nav className="tabbar" aria-label="Navegação">
        <div className="tabbar-pill">
          <div className="tabbar-scroll" ref={tabsRef}>
            {links.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.to === "/"} className="tab" onPointerEnter={() => preload(t.to)}>
                <span className="tab-ico"><Icon name={t.icon} size={21} />{t.badge === "notif" && <UnreadDot className="tab-dot" />}</span>
                <span className="tab-label">{t.short ?? t.label}</span>
              </NavLink>
            ))}
          </div>
          <button className={`tab tab-more ${menu ? "active" : ""}`} onClick={() => setMenu(true)}>
            <span className="tab-ico"><Icon name="more" size={21} /><UnreadDot className="tab-dot" /></span>
            <span className="tab-label">Mais</span>
          </button>
        </div>
      </nav>

      {menu && (
        <Modal title="Menu" onClose={() => setMenu(false)} className="more-sheet">
          {!isStandalone() && (installable || isIos()) && (
            <div className="install-card">
              <img className="brand-logo app-icon" src="/icons/logo-256.png" alt="" width={40} height={40} />
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
              <div className="role-tag">{me.owner ? "Dono da stack" : isSuper ? "Super admin" : "Admin"} · <span className="app-version">v{__APP_VERSION__}</span></div>
            </div>
          </div>
          <div className="more-grid">
            {links.map((item) => (
              <button key={item.to} className={`more-tile ${loc.pathname === item.to ? "active" : ""}`} onClick={() => { setMenu(false); nav(item.to); }}>
                <Icon name={item.icon} size={26} />
                <span>{item.short ?? item.label}</span>
              </button>
            ))}
            <button className="more-tile" onClick={() => { setMenu(false); openWardrobe(); }}>
              <MochiIcon size={40} />
              <span>Mochi</span>
            </button>
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
    </UnreadProvider>
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
          <NavLink key={item.to} to={item.to} end={item.to === "/"} title={item.label} onPointerEnter={() => preload(item.to)} data-count={item.badge === "clients" && pending > 0 ? pending : undefined}>
            <Icon name={item.icon} />
            <span className="label">{item.label}</span>
            {item.badge === "clients" && pending > 0 && <span className="count">{pending}</span>}
            {item.badge === "notif" && <UnreadDot className="nav-dot" count />}
          </NavLink>
        ),
      )}
    </nav>
  );
}
