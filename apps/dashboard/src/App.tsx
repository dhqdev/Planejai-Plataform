import { createContext, lazy, useCallback, Suspense, useContext, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { createPortal, flushSync } from "react-dom";
import { api } from "./api";
import { BlockLoader } from "./BlockLoader";
import { Empty, Loading } from "./components";
import { Guard } from "./Guard";
import { clearApiCache, prefetchApi, useApi } from "./hooks";
import { AgentFace, type Face } from "./faces";
import { Icon } from "./icons";
import { UserMascote } from "./mascote/UserMascote";
import { MascoteStroll } from "./mascote/Stroll";
import { MascoteButton, WardrobeHost } from "./mascote/Wardrobe";
import { useUnread } from "./notify";
import { AuthPage } from "./pages/Login";
import { PrivacyPage } from "./pages/Privacy";
import { OnboardingFlow, type Onboarding } from "./pages/Onboarding";
import { PullToRefresh } from "./PullToRefresh";
import { useInstallAction } from "./Install";
import { haptic, isStandalone } from "./touch";
import { applyUpdate, onUpdateAvailable } from "./update";
import "./styles/impersonacao.css";

// Cada tela é um pedaço à parte: baixa só quando abre (o app inicia leve no celular)
const load = {
  agents: () => import("./pages/Agents"),
  studio: () => import("./pages/TeamStudio"),
  billing: () => import("./pages/Billing"),
  payments: () => import("./pages/Payments"),
  calendar: () => import("./pages/Calendar"),
  clients: () => import("./pages/Clients"),
  dashboard: () => import("./pages/Dashboard"),
  documents: () => import("./pages/Documents"),
  errands: () => import("./pages/Errands"),
  esteira: () => import("./pages/Esteira"),
  skills: () => import("./pages/Skills"),
  blogAdmin: () => import("./pages/BlogAdmin"),
  contacts: () => import("./pages/Contacts"),
  convites: () => import("./pages/Convites"),
  executions: () => import("./pages/Executions"),
  finance: () => import("./pages/Finance"),
  integrations: () => import("./pages/Integrations"),
  invites: () => import("./pages/Invites"),
  models: () => import("./pages/Models"),
  notifications: () => import("./pages/Notifications"),
  alarm: () => import("./pages/Alarm"),
  profile: () => import("./pages/Profile"),
  conta: () => import("./pages/Conta"),
  queues: () => import("./pages/Queues"),
  resources: () => import("./pages/Resources"),
  settings: () => import("./pages/Settings"),
  specialists: () => import("./pages/Specialists"),
  team: () => import("./pages/Team"),
  watches: () => import("./pages/Watches"),
  whatsapp: () => import("./pages/WhatsApp"),
};

/** Tela sob demanda. Se o pedaço não baixar (sem internet), mostra um aviso no lugar em vez de derrubar o app. */
function page<P>(pick: () => Promise<ComponentType<P>>) {
  return lazy(() => pick().then((c) => ({ default: c }), () => ({ default: PageUnavailable as ComponentType<P> })));
}
/** Landing pública: só baixa para quem abre "/" sem estar logado. */
const Landing = page(() => import("./pages/Landing").then((m) => m.LandingPage));
const Pricing = page(() => import("./pages/Pricing").then((m) => m.PricingPage));
/** Blog público (/blog e /blog/:slug): abre com ou sem login. */
const Blog = page(() => import("./pages/Blog").then((m) => m.BlogPage));
const BlogAdminPage = page(() => load.blogAdmin().then((m) => m.BlogAdminPage));

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
const TeamStudioPage = page(() => load.studio().then((m) => m.TeamStudioPage));
const BillingPage = page(() => load.billing().then((m) => m.BillingPage));
const PaymentsPage = page(() => load.payments().then((m) => m.PaymentsPage));
const ClientsPage = page(() => load.clients().then((m) => m.ClientsPage));
const DashboardPage = page(() => load.dashboard().then((m) => m.DashboardPage));
const ExecutionDetailPage = page(() => load.executions().then((m) => m.ExecutionDetailPage));
const ExecutionsPage = page(() => load.executions().then((m) => m.ExecutionsPage));
const FinancePage = page(() => load.finance().then((m) => m.FinancePage));
const IntegrationsPage = page(() => load.integrations().then((m) => m.IntegrationsPage));
const InvitesPage = page(() => load.invites().then((m) => m.InvitesPage));
const SpecialistsPage = page(() => load.specialists().then((m) => m.SpecialistsPage));
const SpecialistPage = page(() => load.specialists().then((m) => m.SpecialistPage));
const ModelsPage = page(() => load.models().then((m) => m.ModelsPage));
const ProfilePage = page(() => load.profile().then((m) => m.ProfilePage));
const ContaPage = page(() => load.conta().then((m) => m.ContaPage));
const CalendarPage = page(() => load.calendar().then((m) => m.CalendarPage));
const SettingsPage = page(() => load.settings().then((m) => m.SettingsPage));
const WatchesPage = page(() => load.watches().then((m) => m.WatchesPage));
const QueuesPage = page(() => load.queues().then((m) => m.QueuesPage));
const ServerPage = page(() => load.resources().then((m) => m.ServerPage));
const StoragePage = page(() => load.resources().then((m) => m.StoragePage));
const TeamPage = page(() => load.team().then((m) => m.TeamPage));
const CustomTabPage = page(() => load.dashboard().then((m) => m.CustomTabPage));
const NotificationsPage = page(() => load.notifications().then((m) => m.NotificationsPage));
const AlarmPage = page(() => load.alarm().then((m) => m.AlarmPage));
const DocumentsPage = page(() => load.documents().then((m) => m.DocumentsPage));
const ErrandsPage = page(() => load.errands().then((m) => m.ErrandsPage));
const EsteiraPage = page(() => load.esteira().then((m) => m.EsteiraPage));
const EsteiraCustosPage = page(() => load.esteira().then((m) => m.EsteiraCustosPage));
const SkillsPage = page(() => load.skills().then((m) => m.SkillsPage));
const ContactsPage = page(() => load.contacts().then((m) => m.ContactsPage));
const ConvitesPage = page(() => load.convites().then((m) => m.ConvitesPage));
const WhatsAppPage = page(() => load.whatsapp().then((m) => m.WhatsAppPage));

/** Qual pedaço cada rota do menu abre: para baixar antes do toque (e deixar pronto para abrir sem internet). */
const ROUTE_CHUNK: Record<string, () => Promise<unknown>> = {
  "/": load.dashboard,
  "/notificacoes": load.notifications,
  "/executions": load.executions,
  "/queues": load.queues,
  "/servidor": load.resources,
  "/armazenamento": load.resources,
  "/clients": load.clients,
  "/invites": load.invites,
  "/agents": load.agents,
  "/whatsapp": load.whatsapp,
  "/integrations": load.integrations,
  "/models": load.models,
  "/finance": load.finance,
  "/agenda": load.calendar,
  "/watches": load.watches,
  "/recados": load.errands,
  "/contatos": load.contacts,
  "/convites": load.convites,
  "/documentos": load.documents,
  "/settings": load.settings,
  "/profile": load.profile,
  "/conta": load.conta,
  "/plano": load.billing,
  "/pagamentos": load.payments,
  "/time": load.team,
  "/esteira": load.esteira,
  "/esteira-custos": load.esteira,
  "/esteira-skills": load.skills,
  "/blog-posts": load.blogAdmin,
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
  impersonating?: { name: string | null } | null;
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
  [{ to: "/servidor", label: "Servidor" }, { to: "/armazenamento", label: "Armazenamento" }],
  [{ to: "/esteira", label: "Chamados" }, { to: "/esteira-custos", label: "Custos" }, { to: "/esteira-skills", label: "Skills" }],
];
const groupOf = (path: string) => GROUPS.find((g) => g.some((t) => t.to === "/" + (path.split("/")[1] ?? "")));

/** Itens de dia a dia: iguais para o dono e para os clientes (cada um vê só os próprios dados). */
const MY_DAY: NavItem[] = [
  { to: "/", label: "Início", icon: "home" },
  { to: "/agenda", label: "Agenda", icon: "calendar" },
  { to: "/finance", label: "Finanças", icon: "wallet" },
  { to: "/watches", label: "Acompanhamentos", icon: "eye", short: "De olho" },
  { to: "/recados", label: "Recados", icon: "send" },
  { to: "/contatos", label: "Contatos", icon: "users" },
  { to: "/documentos", label: "Documentos", icon: "file" },
  { to: "/especialistas", label: "Especialistas", icon: "sparkle" },
];

/** Barra de baixo do celular: só as telas do dia a dia; o resto fica em listas na Conta (último item). */
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
  { to: "/servidor", label: "Servidor", icon: "cpu" },
  { to: "/blog-posts", label: "Blog", icon: "book" },
  { to: "/settings", label: "Configurações", icon: "settings", short: "Ajustes" },
  { section: "Conta" },
  { to: "/convites", label: "Convites", icon: "user-plus" },
  { to: "/notificacoes", label: "Notificações", icon: "bell", badge: "notif", short: "Avisos" },
  { to: "/profile", label: "Minha conta", icon: "user" },
];

interface AppTabs {
  all: boolean;
  modules: string[];
  custom: { slug: string; title: string; icon: string; widgets: string[] }[];
  catalog: Record<string, { label: string; icon: string; to: string }>;
  /** especialistas ligados na loja: cada um vira uma aba */
  specialists?: { slug: string; name: string; persona: string; icon: string }[];
}

const specialistTabs = (tabs: AppTabs | null): NavItem[] =>
  (tabs?.specialists ?? []).map((a) => ({ to: `/especialistas/${a.slug}`, label: a.persona, icon: a.icon }));

/** Esteira de desenvolvimento: só o dono da stack (outro super admin não vê; a API também recusa). */
const OWNER_ONLY: NavLinkItem = { to: "/esteira", label: "Esteira", icon: "github" };

/** O dono também liga especialistas para ele: as abas entram antes da Plataforma. */
function superNav(tabs: AppTabs | null, owner = false): NavItem[] {
  const extra = specialistTabs(tabs);
  const base = owner ? SUPER_NAV.flatMap((i) => ("to" in i && i.to === "/servidor" ? [i, OWNER_ONLY] : [i])) : SUPER_NAV;
  if (!extra.length) return base;
  const at = base.findIndex((i) => "section" in i && i.section === "Plataforma");
  return [...base.slice(0, at), { section: "Feito para você" }, ...extra, ...base.slice(at)];
}

/**
 * Cliente começa só com o essencial (Início, Agenda, Finanças e De olho). Módulos e abas sob medida
 * aparecem quando a reunião noturna do time libera para a pessoa.
 */
function adminNav(tabs: AppTabs | null, billing = false, paid = false): NavItem[] {
  const extra: NavItem[] = [
    ...(tabs?.modules ?? []).map((m) => tabs!.catalog[m]).filter(Boolean).map((m) => ({ to: m!.to, label: m!.label, icon: m!.icon })),
    ...(tabs?.custom ?? []).map((t) => ({ to: `/aba/${t.slug}`, label: t.title, icon: t.icon })),
    ...specialistTabs(tabs),
  ];
  return [
    { section: "Meu dia" },
    ...MY_DAY,
    // blog público só para ler (a gestão é do dono, em Plataforma > Blog); pedido do David em 2026-10-16
    { to: "/blog", label: "Blog", icon: "book" },
    ...(extra.length ? [{ section: "Feito para você" }, ...extra] : []),
    { section: "Conta" },
    { to: "/convites", label: "Convites", icon: "user-plus" },
    { to: "/notificacoes", label: "Notificações", icon: "bell", badge: "notif", short: "Avisos" },
    // só aparece quando o dono ligou a cobrança
    ...(billing ? [{ to: "/plano", label: "Meu plano", icon: "card", short: "Plano" }] : []),
    // quem já pagou alguma vez: cobranças, cartão e assinatura (não confundir com Finanças, que são os gastos da pessoa)
    ...(billing && paid ? [{ to: "/pagamentos", label: "Pagamentos", icon: "receipt", short: "Pagamentos" }] : []),
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
export function BellButton() {
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
  const install = useInstallAction();
  const loc = useLocation();
  const motion = useRouteMotion(loc.pathname);
  // seta de voltar: no celular em toda tela que não é aba da barra (todas se abrem pela Conta); no notebook
  // nas telas abertas pela Conta (ela navega com state.from = "conta", que o voltar do navegador preserva)
  const top = "/" + (loc.pathname.split("/")[1] ?? "");
  const back: "conta" | "phone" | null = (loc.state as { from?: string } | null)?.from === "conta" ? "conta" : [...PHONE_TABS, "/conta"].includes(top) ? null : "phone";
  const goBack = () => {
    haptic(5);
    if (((history.state as { idx?: number } | null)?.idx ?? 0) > 0) nav(-1);
    else nav("/conta");
  };
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
  const tabs = useApi<AppTabs>(me ? `/api/me/tabs?for=${me.id}` : null);
  const isSuper = me?.role === "superadmin";
  const billing = useApi<{ pricing: { enabled: boolean }; paid?: boolean }>(me && !isSuper ? "/api/billing" : null);
  const NAV = !me ? NO_NAV : isSuper ? superNav(tabs.data ?? null, me.owner) : adminNav(tabs.data ?? null, billing.data?.pricing?.enabled, billing.data?.paid);
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

  // primeira conversa com o mascote: como o Planejai funciona (tour, uma vez por conta) e as perguntas de boas-vindas,
  // juntas numa tela só. `?tour=1` ou o evento pj:tour reabrem o tour; pj:welcome (Minha conta) reabre as perguntas.
  const [onb, setOnb] = useState<{ data: Onboarding | null; tour: boolean } | null>(null);
  useEffect(() => {
    if (!me) return;
    const forced = new URLSearchParams(location.search).has("tour");
    api<Onboarding>("/api/me/onboarding").then(
      (d) => {
        const tour = !!d.tour || forced;
        if (d.due || tour) setOnb({ data: d.due ? d : null, tour });
      },
      () => forced && setOnb({ data: null, tour: true }),
    );
    const open = () => api<Onboarding>("/api/me/onboarding").then((d) => setOnb({ data: d, tour: false }), () => {});
    const openTour = () => setOnb({ data: null, tour: true });
    window.addEventListener("pj:welcome", open);
    window.addEventListener("pj:tour", openTour);
    return () => (window.removeEventListener("pj:welcome", open), window.removeEventListener("pj:tour", openTour));
  }, [me?.id]);

  const toggleTheme = (e?: { clientX: number; clientY: number }) => {
    const next = theme === "dark" ? "light" : "dark";
    const apply = () => {
      document.documentElement.dataset.theme = next;
      flushSync(() => setTheme(next));
    };
    try {
      localStorage.setItem("pj-theme", next);
    } catch {
      /* sem storage */
    }
    // tema novo abre num círculo a partir do botão (navegador sem View Transitions troca na hora)
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
    if (!doc.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return apply();
    const x = e?.clientX || innerWidth / 2;
    const y = e?.clientY || innerHeight / 2;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    doc
      .startViewTransition(apply)
      .ready.then(() =>
        document.documentElement.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
          { duration: 520, easing: "cubic-bezier(.4,0,.2,1)", pseudoElement: "::view-transition-new(root)" },
        ),
      )
      .catch(() => {});
  };

  // termos e privacidade abrem sem login (link do cadastro e do convite no WhatsApp)
  if (loc.pathname === "/privacidade") return <PrivacyPage />;
  // página de preços: aberta pelo "Planos" da landing, com ou sem login
  if (loc.pathname === "/precos") return <Suspense fallback={<BlockLoader />}><Pricing /></Suspense>;
  // sem login o blog abre sozinho; logado, ele abre dentro da moldura do app (rota /blog/* mais abaixo)
  if (!me && (loc.pathname === "/blog" || loc.pathname.startsWith("/blog/"))) return <Suspense fallback={<BlockLoader />}><Blog loggedIn={Boolean(me)} /></Suspense>;
  if (me === undefined) return <BlockLoader />;
  if (!me && loc.pathname === "/" && !isStandalone()) return <Suspense fallback={<BlockLoader />}><Landing /></Suspense>;
  if (!me) return <AuthPage onLogin={setMe} />;

  // Plataforma (só o super admin) vai para a barra de cima; Avisos e Minha conta descem para o pé do trilho
  const platform = sectionsOf(NAV).find((sec) => sec.title === "Plataforma")?.items ?? [];
  // especialistas ligados ficam juntos dentro do item Especialistas do trilho (abre um menu ao lado)
  const team = links.filter((l) => l.to.startsWith("/especialistas/"));
  const rail = NAV.filter((i) => !("to" in i && (platform.includes(i) || team.includes(i) || i.to === "/notificacoes" || i.to === "/profile")) && !("section" in i && i.section === "Plataforma"));
  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" });
    setMe(null);
  };
  const has = (m: string) => isSuper || (tabs.data?.modules ?? []).includes(m);
  // barra do celular: 3 abas fixas e a Conta (acesa também em qualquer tela que se abre por ela)
  const phoneTabs = links.filter((t) => PHONE_TABS.includes(t.to));
  const here = phoneTabs.findIndex((t) => t.to === "/" + (loc.pathname.split("/")[1] ?? "") || groupOf(loc.pathname)?.[0]?.to === t.to);
  const tabIndex = here < 0 ? phoneTabs.length : here;
  return (
    <UnreadProvider>
    <div className={`layout${me?.impersonating ? " impersonating" : ""}`}>
      <a className="skip-link" href="#conteudo" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>Pular para o conteúdo</a>
      <header className="topbar">
        {back ? (
          <button type="button" className="icon-btn topbar-back" onClick={goBack} aria-label="Voltar"><Icon name="chevron-left" size={22} /></button>
        ) : (
          <MascoteButton size={50} />
        )}
        <strong className="topbar-title">{titleFor(loc.pathname, NAV)}</strong>
        <span className="spacer" />
        <BellButton />
        <button className="icon-btn" onClick={toggleTheme} aria-label="Trocar tema"><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
      </header>
      {/* notebook e iPad: barra de cima e trilho lateral são uma moldura só; o conteúdo fica num painel encaixado nela */}
      <header className="frame-top">
        <div className="frame-brand">
          <MascoteButton size={58} />
          {isSuper && <span className="frame-role">Super admin</span>}
        </div>
        <span className="spacer" />
        {platform.length > 0 && (
          <nav className="frame-links" aria-label="Plataforma">
            {platform.map((item) => (
              <NavLink key={item.to} to={item.to} className={isOn(loc.pathname, item.to) ? "frame-link active" : "frame-link"} title={item.label} onPointerEnter={() => preload(item.to)}>
                <Icon name={item.icon} size={17} />
                <span className="label">{item.short ?? item.label}</span>
                {item.badge === "clients" && <PendingCount />}
              </NavLink>
            ))}
          </nav>
        )}
        <div className="frame-acts">
          {install.mode === "prompt" && (
            <button className="frame-act" onClick={install.run} aria-label="Instalar o app" title="Instalar o app">
              <Icon name="download" size={18} />
            </button>
          )}
          <button className="frame-act" onClick={toggleTheme} aria-label={theme === "dark" ? "Tema claro" : "Tema escuro"} title={theme === "dark" ? "Tema claro" : "Tema escuro"}>
            <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
          </button>
          <button className="frame-act" onClick={logout} aria-label="Sair" title="Sair">
            <Icon name="logout" size={18} />
          </button>
        </div>
      </header>
      <aside className="sidebar">
        <Nav items={rail} team={team} me={me} meTitle={`${me.name ?? me.email} · ${me.owner ? "Dono da stack" : isSuper ? "Super admin" : "Admin"} · v${__APP_VERSION__}`} />
      </aside>
      <main className="main" id="conteudo" tabIndex={-1} ref={mainRef}>
        {me?.impersonating && (
          <div className="impersonate-banner" role="status">
            <span>
              Você está na conta de <strong>{me.name || me.email}</strong>
            </span>
            <button
              className="impersonate-btn"
              onClick={async () => {
                await api("/api/auth/stop-impersonate", { method: "POST" });
                window.location.reload();
              }}
            >
              Voltar para minha conta
            </button>
          </div>
        )}
        <PullToRefresh target={mainRef} />
        <Suspense fallback={<Loading />}>
        {isSuper && <SubTabs path={loc.pathname} />}
        <div className={`route-fade route-${motion}`} key={loc.pathname}>
        {back === "conta" && loc.pathname !== "/plano" && (
          <button type="button" className="page-back" onClick={goBack}><Icon name="chevron-left" size={18} />Conta</button>
        )}
        <Guard>
        <Routes>
          {isSuper ? (
            <>
              <Route path="/executions" element={<ExecutionsPage />} />
              <Route path="/executions/:id" element={<ExecutionDetailPage />} />
              <Route path="/queues" element={<QueuesPage />} />
              <Route path="/servidor" element={<ServerPage />} />
              <Route path="/armazenamento" element={<StoragePage />} />
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/whatsapp" element={<WhatsAppPage />} />
              <Route path="/agents" element={<AgentsPage />} />
              <Route path="/agents/mapa" element={<TeamStudioPage />} />
              <Route path="/integrations" element={<IntegrationsPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/blog-posts" element={<BlogAdminPage />} />
              {me.owner && <Route path="/esteira" element={<EsteiraPage />} />}
              {me.owner && <Route path="/esteira-custos" element={<EsteiraCustosPage />} />}
              {me.owner && <Route path="/esteira-skills" element={<SkillsPage />} />}
            </>
          ) : (
            <>
              <Route path="/plano" element={<BillingPage />} />
              <Route path="/pagamentos" element={<PaymentsPage />} />
              <Route path="/assinatura" element={<Navigate to="/plano" replace />} />
            </>
          )}
          <Route path="/blog/*" element={<Blog loggedIn embedded />} />
          <Route path="/profile" element={<ProfilePage me={me} />} />
          <Route path="/conta" element={<ContaRoute me={me} sections={sectionsOf(NAV).map((sec) => ({ ...sec, items: sec.items.filter((it) => !PHONE_TABS.includes(it.to)) }))} theme={theme} onTheme={toggleTheme} onLogout={logout} />} />
          <Route path="/notificacoes" element={<NotificationsPage />} />
          <Route path="/alarme" element={<AlarmPage />} />
          <Route path="/documentos" element={<DocumentsPage />} />
          <Route path="/" element={<DashboardPage me={me} theme={theme} onTheme={toggleTheme} />} />
          {/* /invites é a visão do dono (todos os convites); cliente cai na aba Convites dele */}
          <Route path="/invites" element={isSuper ? <InvitesPage isSuper /> : <Navigate to="/convites" replace />} />
          <Route path="/convites" element={<ConvitesPage />} />
          {has("meu_time") && <Route path="/time" element={<TeamPage />} />}
          {(tabs.data?.custom ?? []).map((t) => (
            <Route key={t.slug} path={`/aba/${t.slug}`} element={<CustomTabPage me={me} tab={t} />} />
          ))}
          <Route path="/watches" element={<WatchesPage />} />
          <Route path="/recados" element={<ErrandsPage />} />
          <Route path="/contatos" element={<ContactsPage />} />
          <Route path="/compras" element={<Navigate to="/watches" replace />} />
          <Route path="/finance" element={<FinancePage />} />
          <Route path="/agenda" element={<CalendarPage isSuper={isSuper} />} />
          <Route path="/reminders" element={<Navigate to="/agenda" replace />} />
          {/* o que ele sabe e as reuniões moram em Minha conta, numa tela só; os endereços antigos rolam até a seção */}
          <Route path="/memories" element={<Navigate to={{ pathname: "/profile", hash: "#sabe" }} replace />} />
          <Route path="/reunioes" element={<Navigate to={{ pathname: "/profile", hash: "#reunioes" }} replace />} />
          <Route path="/especialistas" element={<SpecialistsPage />} />
          <Route path="/especialistas/:slug" element={<SpecialistPage />} />
          <Route path="*" element={tabs.loading && !isSuper ? <Loading /> : <Navigate to="/" />} />
        </Routes>
        </Guard>
        </div>
        </Suspense>
      </main>

      <WardrobeHost />
      <MascoteStroll />
      {onb && (
        <OnboardingFlow
          data={onb.data}
          tour={onb.tour}
          name={me.name}
          onDone={(answered) => {
            setOnb(null);
            if (answered) window.dispatchEvent(new Event("pj:welcome-done"));
            if (location.search.includes("tour")) history.replaceState(null, "", location.pathname);
          }}
        />
      )}

      {update && (
        <div className="update-pill" role="status">
          <span>Nova versão do Planejai</span>
          <button className="btn btn-sm btn-brand" onClick={() => { haptic(10); void applyUpdate(); }}>Atualizar</button>
        </div>
      )}

      <nav className="tabbar" aria-label="Navegação">
        <div className="tabbar-pill" style={{ ["--i" as any]: tabIndex }}>
          {/* fundo que desliza até a aba ativa */}
          <span className="tab-glider" aria-hidden />
          <div className="tabbar-scroll" ref={tabsRef}>
            {phoneTabs.map((t, i) => (
              <NavLink key={t.to} to={t.to} end={t.to === "/"} aria-label={t.short ?? t.label} title={t.short ?? t.label} className={`tab${tabIndex === i ? " active" : ""}`} onClick={() => haptic(6)} onPointerEnter={() => preload(t.to)}>
                <span className="tab-ico" key={tabIndex === i ? "on" : "off"}><Icon name={t.icon} size={23} />{t.badge === "notif" && <UnreadDot className="tab-dot" />}</span>
                <span className="tab-label">{t.short ?? t.label}</span>
              </NavLink>
            ))}
          </div>
          <NavLink to="/conta" className={`tab tab-more${tabIndex === phoneTabs.length ? " active" : ""}`} aria-label="Conta" title="Conta" onClick={() => haptic(6)} onPointerEnter={() => preload("/conta")}>
            <span className="tab-ico" key={tabIndex === phoneTabs.length ? "on" : "off"}><Icon name="user" size={23} /><UnreadDot className="tab-dot" /></span>
            <span className="tab-label">Conta</span>
          </NavLink>
        </div>
      </nav>

      {install.sheet}
    </div>
    </UnreadProvider>
  );
}

/**
 * Jeito da transição entre telas (CSS em styles/transicao.css): abrir uma tela a partir de outra entra da
 * direita ("push"), voltar (botão voltar, gesto do Android) entra da esquerda ("pop") e trocar de aba na
 * barra ou entre telas irmãs só esmaece ("tab"). O caminho anterior fica num ref, então o cálculo é feito
 * uma vez por troca de endereço.
 */
function useRouteMotion(path: string) {
  const type = useNavigationType();
  const ref = useRef({ path, kind: "tab" as "tab" | "push" | "pop" });
  if (ref.current.path !== path) {
    const top = (p: string) => "/" + (p.split("/")[1] ?? "");
    const flat = (p: string) => [...PHONE_TABS, "/conta"].includes(top(p));
    const from = ref.current.path;
    const siblings = groupOf(from) && groupOf(from) === groupOf(path);
    const kind = type === "POP" ? "pop" : flat(path) || siblings ? "tab" : "push";
    ref.current = { path, kind };
  }
  return ref.current.kind;
}

/** Conta com o número de avisos não lidos (o provedor fica dentro do App, então lê aqui). */
function ContaRoute(props: Omit<Parameters<typeof ContaPage>[0], "unread">) {
  return <ContaPage {...props} unread={useContext(UnreadContext)} />;
}

/** Itens do menu agrupados pela seção (Meu dia, Plataforma, Conta…), para as listas da Conta no celular. */
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
  if (base === "/conta") return "Conta";
  const hit = (items.find((i) => "to" in i && i.to === path) ?? items.find((i) => "to" in i && i.to === base)) as { label: string } | undefined;
  return hit?.label ?? groupOf(path)?.find((t) => t.to === base)?.label ?? "Planejai";
}

/** Pendentes de aprovação em Pessoas (só o super admin consulta). */
function PendingCount() {
  const clients = useApi<any[]>("/api/clients", { poll: 60000 });
  const pending = (clients.data ?? []).filter((c) => c.status === "pending" || c.account_status === "pending").length;
  return pending > 0 ? <span className="count">{pending}</span> : null;
}

/**
 * Trilho lateral: ícone com o nome curto embaixo, grupos separados por um fio. No pé ficam Avisos e a conta
 * (o mascote da pessoa), como nos apps de trabalho.
 */
function Nav({ items, team, me, meTitle }: { items: NavItem[]; team: NavLinkItem[]; me: Me; meTitle: string }) {
  const loc = useLocation();
  const [open, setOpen] = useState<{ top: number } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  // item do grupo fica marcado também nas telas irmãs (Filas acende Execuções)
  const cls = (to: string) => ({ isActive }: { isActive: boolean }) => (isActive || groupOf(loc.pathname)?.[0]?.to === to ? "active" : "");
  return (
    <nav className="nav">
      {items.map((item, i) =>
        "section" in item ? (
          // fio entre grupos; nada no começo nem antes de um grupo vazio
          i > 0 && items[i + 1] && "to" in items[i + 1]! && <span className="nav-sep" key={i} role="separator" aria-label={item.section} />
        ) : (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={(st) => `${cls(item.to)(st)}${item.to === "/especialistas" && team.length ? " nav-group" : ""}${open && item.to === "/especialistas" ? " open" : ""}`}
            title={item.label}
            aria-expanded={item.to === "/especialistas" && team.length ? Boolean(open) : undefined}
            onPointerEnter={() => preload(item.to)}
            onClick={(e) => {
              // com especialistas ligados, o item não navega: abre o menu com eles ao lado do trilho
              if (item.to !== "/especialistas" || !team.length) return;
              e.preventDefault();
              haptic(6);
              setOpen(open ? null : { top: e.currentTarget.getBoundingClientRect().top });
            }}
          >
            <span className="nav-ico">
              <Icon name={item.icon} size={22} />
              {item.to === "/especialistas" && team.length > 0 && <span className="nav-chev" aria-hidden><Icon name="chevron-right" size={10} /></span>}
            </span>
            <span className="label">{item.short ?? item.label}</span>
          </NavLink>
        ),
      )}
      {open && <TeamFlyout top={open.top} team={team} onClose={close} />}
      <span className="nav-grow" aria-hidden />
      <NavLink to="/notificacoes" className={cls("/notificacoes")} title="Notificações" onPointerEnter={() => preload("/notificacoes")}>
        <span className="nav-ico"><Icon name="bell" size={22} /><UnreadDot className="nav-dot" count /></span>
        <span className="label">Avisos</span>
      </NavLink>
      <NavLink to="/conta" className={(st) => (st.isActive || loc.pathname === "/profile" ? "active" : "")} title={meTitle} onPointerEnter={() => preload("/conta")}>
        <span className="nav-ico nav-me"><UserMascote me name={me.name ?? me.email} size={30} /></span>
        <span className="label">Conta</span>
      </NavLink>
    </nav>
  );
}

type StoreItem = { slug: string; persona: string; focus: string; active: boolean; face: Face };

/**
 * Menu dos especialistas, aberto ao lado do trilho: cada agente ligado com o rosto e o assunto, e no fim a
 * página de todos. Fecha ao escolher, ao clicar fora ou com Esc.
 */
function TeamFlyout({ top, team, onClose }: { top: number; team: NavLinkItem[]; onClose: () => void }) {
  const nav = useNavigate();
  const loc = useLocation();
  const box = useRef<HTMLDivElement>(null);
  const store = useApi<{ items: StoreItem[] }>("/api/store");
  const bySlug = new Map((store.data?.items ?? []).map((it) => [it.slug, it]));
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!box.current?.contains(t) && !t.closest?.(".nav-group")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    box.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const go = (to: string) => {
    onClose();
    nav(to);
  };
  // não passa do pé da tela: sobe o que for preciso
  const y = Math.max(72, Math.min(top - 8, innerHeight - 24 - (team.length + 1) * 56 - 52));
  // vai para o body: dentro do trilho ficaria por baixo do painel do conteúdo
  return createPortal(
    <div className="team-fly" ref={box} role="menu" aria-label="Especialistas" style={{ top: y }}>
      <div className="team-fly-head">Seu time</div>
      {team.map((t) => {
        const it = bySlug.get(t.to.slice("/especialistas/".length));
        return (
          <button key={t.to} role="menuitem" className={`team-fly-item${loc.pathname === t.to ? " active" : ""}`} onPointerEnter={() => preload("/especialistas")} onClick={() => go(t.to)}>
            {it ? <AgentFace face={it.face} size={36} /> : <span className="team-fly-ico"><Icon name={t.icon} size={18} /></span>}
            <span className="team-fly-text">
              <strong>{t.label}</strong>
              {it?.focus && <small>{it.focus}</small>}
            </span>
          </button>
        );
      })}
      <button role="menuitem" className={`team-fly-all${loc.pathname === "/especialistas" ? " active" : ""}`} onClick={() => go("/especialistas")}>
        <Icon name="sparkle" size={16} />
        <span>Todos os especialistas</span>
        <Icon name="chevron-right" size={14} />
      </button>
    </div>,
    document.body,
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
