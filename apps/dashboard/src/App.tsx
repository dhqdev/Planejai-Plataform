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
import { Welcome, type Onboarding } from "./pages/Welcome";
import { PullToRefresh } from "./PullToRefresh";
import { canInstall, haptic, isIos, isStandalone, onInstallAvailable, promptInstall } from "./touch";
import { applyUpdate, onUpdateAvailable } from "./update";

// Cada tela é um pedaço à parte: baixa só quando abre (o app inicia leve no celular)
const load = {
  agents: () => import("./pages/Agents"),
  billing: () => import("./pages/Billing"),
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
const BillingPage = page(() => load.billing().then((m) => m.BillingPage));
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
  "/assinatura": load.billing,
  "/time": load.team,
};
function preload(to: string) {
  ROUTE_CHUNK[to]?.().catch(() => {});
}

/** Barra de status do celular na cor do fundo do tema escolhido (as duas metas: claro e escuro do sistema). */
export function syncThemeColor() {
  const color = document.documentElement.dataset.theme === "dark" ? "#0a0a0b" : "#fafaf9";
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", color));
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

/**
 * Telas irmãs ficam juntas: um item no menu e abas no topo da tela (ex.: Execuções e Filas).
 * Assim o menu fica curto e cada grupo responde a uma pergunta só ("o que rodou?", "quem usa?").
 */
const GROUPS: { to: string; label: string }[][] = [
  [{ to: "/executions", label: "Execuções" }, { to: "/queues", label: "Filas" }],
  [{ to: "/clients", label: "Clientes" }, { to: "/invites", label: "Convites" }],
  [{ to: "/agents", label: "Agentes" }, { to: "/models", label: "Modelos" }],
  [{ to: "/whatsapp", label: "WhatsApp" }, { to: "/integrations", label: "Integrações" }],
  [{ to: "/profile", label: "Minha conta" }, { to: "/memories", label: "O que ele sabe" }],
];
const groupOf = (path: string) => GROUPS.find((g) => g.some((t) => t.to === "/" + (path.split("/")[1] ?? "")));

/** Itens de dia a dia: iguais para o dono e para os clientes (cada um vê só os próprios dados). */
const MY_DAY: NavItem[] = [
  { to: "/", label: "Início", icon: "home" },
  { to: "/agenda", label: "Agenda", icon: "calendar" },
  { to: "/finance", label: "Finanças", icon: "wallet" },
  { to: "/watches", label: "Acompanhamentos", icon: "eye", short: "De olho" },
  { to: "/documentos", label: "Documentos", icon: "file" },
];

/** Barra de baixo do celular: só as telas do dia a dia; o resto fica organizado por seção no "Mais". */
const PHONE_TABS = ["/", "/agenda", "/finance"];

/** Super admin (dono da stack): o dia a dia dele e, abaixo, a operação da plataforma. */
const SUPER_NAV: NavItem[] = [
  { section: "Meu dia" },
  ...MY_DAY,
  { section: "Plataforma" },
  { to: "/executions", label: "Execuções", icon: "activity" },
  { to: "/clients", label: "Pessoas", icon: "users", badge: "clients" },
  { to: "/agents", label: "Agentes", icon: "brain" },
  { to: "/whatsapp", label: "Conexões", icon: "plug" },
  { to: "/settings", label: "Configurações", icon: "settings", short: "Ajustes" },
  { section: "Conta" },
  { to: "/notificacoes", label: "Notificações", icon: "bell", badge: "notif", short: "Avisos" },
  { to: "/profile", label: "Minha conta", icon: "user" },
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
function adminNav(tabs: AppTabs | null, billing = false): NavItem[] {
  const extra: NavItem[] = [
    ...(tabs?.modules ?? []).map((m) => tabs!.catalog[m]).filter(Boolean).map((m) => ({ to: m!.to, label: m!.label, icon: m!.icon })),
    ...(tabs?.custom ?? []).map((t) => ({ to: `/aba/${t.slug}`, label: t.title, icon: t.icon })),
  ];
  return [
    { section: "Meu dia" },
    ...MY_DAY,
    ...(extra.length ? [{ section: "Feito para você" }, ...extra] : []),
    { section: "Conta" },
    { to: "/notificacoes", label: "Notificações", icon: "bell", badge: "notif", short: "Avisos" },
    // só aparece quando o dono ligou a cobrança
    ...(billing ? [{ to: "/assinatura", label: "Assinatura", icon: "card" }] : []),
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
  const billing = useApi<{ plan: { enabled: boolean } }>(me && !isSuper ? "/api/billing" : null);
  const NAV = !me ? NO_NAV : isSuper ? SUPER_NAV : adminNav(tabs.data ?? null, billing.data?.plan.enabled);
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

  // perguntas de boas-vindas: abrem sozinhas na primeira entrada de quem acabou de se cadastrar (e pelo Perfil, quando quiser)
  const [welcome, setWelcome] = useState<Onboarding | null>(null);
  useEffect(() => {
    if (!me) return;
    api<Onboarding>("/api/me/onboarding").then((d) => d.due && setWelcome(d), () => {});
    const open = () => api<Onboarding>("/api/me/onboarding").then(setWelcome, () => {});
    window.addEventListener("pj:welcome", open);
    return () => window.removeEventListener("pj:welcome", open);
  }, [me?.id]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    syncThemeColor();
    try {
      localStorage.setItem("pj-theme", next);
    } catch {
      /* sem storage */
    }
    setTheme(next);
  };

  // termos e privacidade abrem sem login (link do cadastro e do convite no WhatsApp)
  if (loc.pathname === "/privacidade") return <PrivacyPage />;
  if (me === undefined) return <BlockLoader />;
  if (!me) return <AuthPage onLogin={setMe} />;

  const has = (m: string) => isSuper || (tabs.data?.modules ?? []).includes(m);
  // barra do celular: 3 abas fixas e o "Mais" (ativo no modal ou em qualquer outra tela)
  const phoneTabs = links.filter((t) => PHONE_TABS.includes(t.to));
  const here = phoneTabs.findIndex((t) => t.to === "/" + (loc.pathname.split("/")[1] ?? "") || groupOf(loc.pathname)?.[0]?.to === t.to);
  const tabIndex = menu || here < 0 ? phoneTabs.length : here;
  return (
    <UnreadProvider>
    <div className="layout">
      <header className="topbar">
        <strong className="topbar-title">{titleFor(loc.pathname, NAV)}</strong>
        <span className="spacer" />
        <BellButton />
      </header>
      <aside className="sidebar">
        <div className="brand">
          <MochiButton size={30} />
          <div>
            Planejai
            <small>{isSuper ? "Super admin" : "Painel"}</small>
          </div>
        </div>
        <Nav items={NAV} isSuper={isSuper} />
        <div className="sidebar-foot">
          <div className="me">
            <div className="avatar">{(me.name ?? me.email).slice(0, 1).toUpperCase()}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="me-name">{me.name ?? me.email}</div>
              <div className="role-tag">{me.owner ? "Dono da stack" : isSuper ? "Super admin" : "Admin"} · <span className="app-version">v{__APP_VERSION__}</span></div>
            </div>
            <div className="me-actions">
              <button className="icon-btn sm ghost" onClick={toggleTheme} aria-label={theme === "dark" ? "Tema claro" : "Tema escuro"} title={theme === "dark" ? "Tema claro" : "Tema escuro"}>
                <Icon name={theme === "dark" ? "sun" : "moon"} size={15} />
              </button>
              <button
                className="icon-btn sm ghost"
                onClick={async () => {
                  await api("/api/auth/logout", { method: "POST" });
                  setMe(null);
                }}
                aria-label="Sair"
                title="Sair"
              >
                <Icon name="logout" size={15} />
              </button>
            </div>
          </div>
        </div>
      </aside>
      <main className="main" ref={mainRef}>
        <PullToRefresh target={mainRef} />
        <Suspense fallback={<Loading />}>
        {isSuper && <SubTabs path={loc.pathname} />}
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
            <Route path="/assinatura" element={<BillingPage />} />
          )}
          <Route path="/profile" element={<ProfilePage me={me} />} />
          <Route path="/notificacoes" element={<NotificationsPage />} />
          <Route path="/documentos" element={<DocumentsPage />} />
          <Route path="/" element={<DashboardPage me={me} theme={theme} onTheme={toggleTheme} />} />
          {has("convites") && <Route path="/invites" element={<InvitesPage isSuper={isSuper} />} />}
          {has("meu_time") && <Route path="/time" element={<TeamPage />} />}
          {(tabs.data?.custom ?? []).map((t) => (
            <Route key={t.slug} path={`/aba/${t.slug}`} element={<CustomTabPage me={me} tab={t} />} />
          ))}
          <Route path="/watches" element={<WatchesPage />} />
          <Route path="/finance" element={<FinancePage />} />
          <Route path="/agenda" element={<CalendarPage isSuper={isSuper} />} />
          <Route path="/reminders" element={<Navigate to="/agenda" replace />} />
          {has("memorias") && <Route path="/memories" element={<MemoriesPage />} />}
          <Route path="*" element={tabs.loading && !isSuper ? <Loading /> : <Navigate to="/" />} />
        </Routes>
        </div>
        </Suspense>
      </main>

      <WardrobeHost />
      {welcome && <Welcome data={welcome} name={me.name} onDone={() => (setWelcome(null), window.dispatchEvent(new Event("pj:welcome-done")))} />}

      {update && (
        <div className="update-pill" role="status">
          <span>Nova versão do Planejai</span>
          <button className="btn btn-sm btn-brand" onClick={() => { haptic(10); void applyUpdate(); }}>Atualizar</button>
        </div>
      )}

      <nav className="tabbar" aria-label="Navegação">
        <div className="tabbar-pill">
          <div className="tabbar-scroll" ref={tabsRef}>
            {phoneTabs.map((t, i) => (
              <NavLink key={t.to} to={t.to} end={t.to === "/"} aria-label={t.short ?? t.label} title={t.short ?? t.label} className={`tab${tabIndex === i ? " active" : ""}`} onClick={() => haptic(6)} onPointerEnter={() => preload(t.to)}>
                <span className="tab-ico" key={tabIndex === i ? "on" : "off"}><Icon name={t.icon} size={22} />{t.badge === "notif" && <UnreadDot className="tab-dot" />}</span>
                <span className="tab-label">{t.short ?? t.label}</span>
              </NavLink>
            ))}
          </div>
          <button className={`tab tab-more${tabIndex === phoneTabs.length ? " active" : ""}`} aria-label="Mais" title="Mais" onClick={() => { haptic(); setMenu(true); }}>
            <span className="tab-ico" key={tabIndex === phoneTabs.length ? "on" : "off"}><Icon name="apps" size={22} /><UnreadDot className="tab-dot" /></span>
            <span className="tab-label">Mais</span>
          </button>
        </div>
      </nav>

      {menu && (
        <Modal title="Mais" onClose={() => setMenu(false)} className="more-sheet">
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
          {sectionsOf(NAV).map((sec) => {
            const items = sec.items.filter((it) => !PHONE_TABS.includes(it.to));
            const last = sec.title === "Conta";
            if (!items.length && !last) return null;
            const go = (to: string) => { setMenu(false); nav(to); };
            return (
              <section key={sec.title} className="more-section">
                <h4>{sec.title}</h4>
                <div className="more-list">
                  {items.map((item) => (
                    <button key={item.to} className={`sheet-item ${isOn(loc.pathname, item.to) ? "active" : ""}`} onClick={() => go(item.to)}>
                      <span className="ico-box tab-ico"><Icon name={item.icon} size={18} />{item.badge === "notif" && <UnreadDot className="tab-dot" />}</span>
                      <span>{item.label}</span>
                      <Icon name="chevron-right" size={16} className="chev" />
                    </button>
                  ))}
                  {last && (
                    <>
                      <button className="sheet-item" onClick={() => { setMenu(false); openWardrobe(); }}>
                        <span className="ico-box"><MochiIcon size={22} /></span>
                        <span>Roupinha do Mochi</span>
                      </button>
                      <button className="sheet-item" onClick={toggleTheme}>
                        <span className="ico-box"><Icon name={theme === "dark" ? "sun" : "moon"} size={18} /></span>
                        <span>{theme === "dark" ? "Tema claro" : "Tema escuro"}</span>
                      </button>
                      <button className="sheet-item danger" onClick={async () => { await api("/api/auth/logout", { method: "POST" }); setMenu(false); setMe(null); }}>
                        <span className="ico-box"><Icon name="logout" size={18} /></span>
                        <span>Sair</span>
                      </button>
                    </>
                  )}
                </div>
              </section>
            );
          })}
        </Modal>
      )}
    </div>
    </UnreadProvider>
  );
}

/** Itens do menu agrupados pela seção (Meu dia, Plataforma, Conta…), para o "Mais" do celular. */
function sectionsOf(items: NavItem[]) {
  const out: { title: string; items: NavLinkItem[] }[] = [];
  for (const it of items) {
    if ("section" in it) out.push({ title: it.section, items: [] });
    else (out[out.length - 1] ?? (out[out.length] = { title: "Menu", items: [] })).items.push(it);
  }
  return out;
}

/** Tela aberta é este item ou uma irmã dele (Filas conta como Execuções). */
const isOn = (path: string, to: string) => {
  const base = "/" + (path.split("/")[1] ?? "");
  return base === to || groupOf(path)?.[0]?.to === to;
};

function titleFor(path: string, items: NavItem[]) {
  const base = "/" + (path.split("/")[1] ?? "");
  const hit = (items.find((i) => "to" in i && i.to === path) ?? items.find((i) => "to" in i && i.to === base)) as { label: string } | undefined;
  return hit?.label ?? groupOf(path)?.find((t) => t.to === base)?.label ?? "Planejai";
}

function Nav({ items, isSuper }: { items: NavItem[]; isSuper: boolean }) {
  const loc = useLocation();
  // item do grupo fica marcado também nas telas irmãs (Filas acende Execuções)
  const inGroup = (to: string) => Boolean(groupOf(loc.pathname)?.[0]?.to === to);
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
          <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => (isActive || inGroup(item.to) ? "active" : "")} title={item.label} onPointerEnter={() => preload(item.to)} data-count={item.badge === "clients" && pending > 0 ? pending : undefined}>
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

/** Abas das telas irmãs (ex.: Execuções | Filas), no topo da tela do grupo. */
function SubTabs({ path }: { path: string }) {
  const group = groupOf(path);
  const nav = useNavigate();
  if (!group) return null;
  const base = "/" + (path.split("/")[1] ?? "");
  return (
    <div className="subtabs-bar">
      <div className="subtabs" role="tablist">
        {group.map((t) => (
          <button key={t.to} role="tab" aria-selected={t.to === base} className={t.to === base ? "active" : ""} onPointerEnter={() => preload(t.to)} onClick={() => { haptic(5); nav(t.to); }}>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}
