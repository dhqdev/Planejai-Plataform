/**
 * Contrato das integrações externas: confere URL, método, cabeçalhos de autenticação e formato do corpo
 * que cada ferramenta/teste de conexão envia, com fetch simulado (nenhuma chamada real à rede).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CREDS: Record<string, Record<string, string>> = {
  google: { client_id: "gid", client_secret: "gsecret", refresh_token: "grefresh", email: "a@b.com" },
  notion: { token: "ntn_x", default_parent_page_id: "https://www.notion.so/Notas-0123456789abcdef0123456789abcdef" },
  github: { token: "github_pat_x", default_repo: "dono/repo" },
  linear: { api_key: "lin_api_x", default_team_key: "ENG" },
  slack: { bot_token: "xoxb-x" },
  tavily: { api_key: "tvly-x" },
  brave: { api_key: "BSAx" },
  browserless: { url: "http://browserless:3000/", token: "btok" },
  mercadolivre: { client_id: "mlid", client_secret: "mlsecret", refresh_token: "TG-old", user_id: "1" },
  mercadopago: { access_token: "APP_USR-x" },
};
let enabled = new Set(Object.keys(CREDS));

vi.mock("../src/db/pool.js", async () => {
  const { encryptJson } = await import("../src/crypto.js");
  const row = (id: string) => (enabled.has(id) ? { enabled: true, credentials_enc: encryptJson(CREDS[id]) } : null);
  return {
    pool: {},
    query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
    one: vi.fn(async (_sql: string, params: unknown[] = []) => row(String(params[0]))),
    many: vi.fn(async () => []),
  };
});

const { disconnect, getDef } = await import("../src/integrations/registry.js");
const productivity = await import("../src/agent/tools/productivity.js");
const research = await import("../src/agent/tools/research.js");
const communication = await import("../src/agent/tools/communication.js");
const agenda = await import("../src/agent/tools/agenda.js");
const finance = await import("../src/agent/tools/finance.js");

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: any;
  rawBody: unknown;
}
let calls: Call[] = [];
type Route = (url: URL, init: RequestInit) => Response | undefined;
let routes: Route[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function parseBody(init: RequestInit) {
  const b = init.body;
  if (b == null) return undefined;
  if (b instanceof URLSearchParams) return Object.fromEntries(b);
  const s = String(b);
  try {
    return JSON.parse(s);
  } catch {
    return Object.fromEntries(new URLSearchParams(s));
  }
}

beforeEach(() => {
  calls = [];
  routes = [];
  enabled = new Set(Object.keys(CREDS));
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), method: (init.method ?? "GET").toUpperCase(), headers: new Headers(init.headers), body: parseBody(init), rawBody: init.body });
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    throw new Error(`fetch não esperado: ${url}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

const on = (match: (u: URL) => boolean, res: (u: URL, init: RequestInit) => Response) => routes.push((u, i) => (match(u) ? res(u, i) : undefined));
const host = (h: string, path?: string | RegExp) => (u: URL) =>
  u.host === h && (path == null || (typeof path === "string" ? u.pathname === path : path.test(u.pathname)));
const ctx: any = { timezone: "America/Sao_Paulo", user: { id: "u1" }, outbox: { addMedia: () => "m1" } };
const callTo = (pred: (c: Call) => boolean) => {
  const c = calls.find(pred);
  expect(c, "chamada esperada não encontrada").toBeDefined();
  return c!;
};

describe("Google (OAuth, Gmail, Agenda)", () => {
  it("renova o token por refresh_token e chama a Gmail API com Bearer", async () => {
    on(host("oauth2.googleapis.com", "/token"), () => json({ access_token: "ya29.x", expires_in: 3599 }));
    on(host("gmail.googleapis.com", "/gmail/v1/users/me/messages"), () => json({ messages: [{ id: "m1" }] }));
    on(host("gmail.googleapis.com", "/gmail/v1/users/me/messages/m1"), () =>
      json({ id: "m1", snippet: "oi", labelIds: ["UNREAD"], payload: { headers: [{ name: "Subject", value: "Assunto" }] } }),
    );
    const out: any = await communication.gmailSearch.run({ query: "is:unread", max: 5 }, ctx);
    expect(out[0]).toMatchObject({ id: "m1", subject: "Assunto", unread: true });

    const tok = callTo((c) => c.url.startsWith("https://oauth2.googleapis.com/token"));
    expect(tok.method).toBe("POST");
    expect(tok.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(tok.body).toEqual({ client_id: "gid", client_secret: "gsecret", refresh_token: "grefresh", grant_type: "refresh_token" });

    const list = callTo((c) => c.url.includes("/messages?"));
    expect(list.headers.get("authorization")).toBe("Bearer ya29.x");
    expect(new URL(list.url).searchParams.get("q")).toBe("is:unread");
    expect(new URL(list.url).searchParams.get("maxResults")).toBe("5");
    const meta = new URL(callTo((c) => c.url.includes("/messages/m1")).url);
    expect(meta.searchParams.get("format")).toBe("metadata");
    expect(meta.searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject", "Date"]);
  });

  it("gmail_send envia raw RFC 2822 em base64url via POST", async () => {
    on(host("gmail.googleapis.com", "/gmail/v1/users/me/messages/send"), () => json({ id: "s1" }));
    await communication.gmailSend.run({ to: "x@y.com", subject: "Olá", body: "corpo" }, { ...ctx, approvedAction: true });
    const c = callTo((c) => c.url.endsWith("/messages/send"));
    expect(c.method).toBe("POST");
    const raw = Buffer.from(c.body.raw, "base64url").toString();
    expect(raw).toContain("To: x@y.com\r\n");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(raw.endsWith("\r\n\r\ncorpo")).toBe(true);
  });

  it("agenda: lista com timeMin/timeMax ISO e cria evento com start/end + timeZone", async () => {
    on(host("www.googleapis.com", "/calendar/v3/calendars/primary/events"), (_u, init) =>
      init.method === "POST" ? json({ id: "e1", htmlLink: "https://cal/e1" }) : json({ items: [{ id: "e0", summary: "Reunião", start: { dateTime: "x" } }] }),
    );
    const listed: any = await agenda.calendarListEvents.run({ from: "2026-10-10T00:00", to: "2026-10-11T00:00" }, ctx);
    expect(listed[0]).toMatchObject({ id: "e0", title: "Reunião" });
    const l = new URL(calls.find((c) => c.method === "GET")!.url);
    expect(l.searchParams.get("timeMin")).toBe("2026-10-10T03:00:00.000Z");
    expect(l.searchParams.get("singleEvents")).toBe("true");
    expect(l.searchParams.get("orderBy")).toBe("startTime");

    await agenda.calendarCreateEvent.run({ title: "Dentista", start: "2026-10-10T14:00", end: "2026-10-10T15:00" }, ctx);
    const p = calls.find((c) => c.method === "POST")!;
    expect(new URL(p.url).searchParams.get("sendUpdates")).toBe("none");
    expect(p.body).toMatchObject({ summary: "Dentista", start: { dateTime: "2026-10-10T17:00:00.000Z", timeZone: "America/Sao_Paulo" } });
    expect(p.body.conferenceData).toBeUndefined();
  });

  it("agenda: reunião via Meet com convidado (convite e lembrete pelo Google)", async () => {
    on(host("www.googleapis.com", "/calendar/v3/calendars/primary/events"), () =>
      json({ id: "e2", htmlLink: "https://cal/e2", hangoutLink: "https://meet.google.com/abc-defg-hij" }),
    );
    // convidado sem confirmação: não cria
    const ask: any = await agenda.calendarCreateEvent.run({ title: "Reunião", start: "2026-10-10T10:00", attendees: ["darlos@gmail.com"], meet: true }, ctx);
    expect(ask.needs_confirmation).toBe(true);
    expect(calls.length).toBe(0);
    // e-mail que só veio no documento encaminhado não vale como confirmação; digitado por ela vale
    const doc = { inboundText: "[documento] convite.pdf: chame darlos@gmail.com", typedText: "marca a reunião do pdf" };
    expect(((await agenda.calendarCreateEvent.run({ title: "Reunião", start: "2026-10-10T10:00", attendees: ["darlos@gmail.com"] }, { ...ctx, ...doc })) as any).needs_confirmation).toBe(true);
    expect(calls.length).toBe(0);
    const typed: any = await agenda.calendarCreateEvent.run({ title: "Reunião", start: "2026-10-10T10:00", attendees: ["darlos@gmail.com"] }, { ...ctx, typedText: "marca com darlos@gmail.com amanhã" });
    expect(typed.ok).toBe(true);
    calls.length = 0;
    const bad: any = await agenda.calendarCreateEvent.run({ title: "Reunião", start: "2026-10-10T10:00", attendees: ["carlos"] }, { ...ctx, approvedAction: true });
    expect(bad.ok).toBe(false);

    const r: any = await agenda.calendarCreateEvent.run(
      { title: "Reunião com Carlos", start: "2026-10-10T10:00", attendees: ["Darlos@Gmail.com "], meet: true },
      { ...ctx, approvedAction: true },
    );
    expect(r).toMatchObject({ ok: true, meet_link: "https://meet.google.com/abc-defg-hij", invited: ["darlos@gmail.com"] });
    const p = calls.find((c) => c.method === "POST")!;
    const u = new URL(p.url);
    expect(u.searchParams.get("conferenceDataVersion")).toBe("1");
    expect(u.searchParams.get("sendUpdates")).toBe("all");
    expect(p.body.attendees).toEqual([{ email: "darlos@gmail.com" }]);
    expect(p.body.conferenceData.createRequest.conferenceSolutionKey).toEqual({ type: "hangoutsMeet" });
    expect(p.body.conferenceData.createRequest.requestId).toMatch(/^pj-/);
    // sem fim informado: 1 hora
    expect(p.body.end.dateTime).toBe("2026-10-10T14:00:00.000Z");
    expect(p.body.reminders.useDefault).toBe(false);
  });
});

describe("Notion", () => {
  const notionHeaders = (c: Call) => {
    expect(c.headers.get("authorization")).toBe("Bearer ntn_x");
    expect(c.headers.get("notion-version")).toBe("2022-06-28");
  };
  it("test() usa GET /v1/users/me", async () => {
    on(host("api.notion.com", "/v1/users/me"), () => json({ object: "user", name: "Bot" }));
    expect(await getDef("notion")!.test!(CREDS.notion!)).toContain("Bot");
    notionHeaders(calls[0]!);
    expect(calls[0]!.method).toBe("GET");
  });
  it("search, ler blocos e criar página", async () => {
    on(host("api.notion.com", "/v1/search"), () => json({ results: [{ id: "p1", object: "page", url: "u", properties: { Name: { type: "title", title: [{ plain_text: "Doc" }] } } }] }));
    on(host("api.notion.com", "/v1/blocks/p1/children"), () => json({ results: [{ type: "paragraph", paragraph: { rich_text: [{ plain_text: "linha" }] } }] }));
    on(host("api.notion.com", "/v1/pages"), () => json({ id: "new", url: "https://notion.so/new" }));
    expect(await productivity.notionSearch.run({ query: "doc" }, ctx)).toEqual([{ id: "p1", type: "page", title: "Doc", url: "u" }]);
    expect(calls[0]).toMatchObject({ method: "POST", body: { query: "doc", page_size: 10 } });
    notionHeaders(calls[0]!);
    expect(await productivity.notionReadPage.run({ page_id: "p1" }, ctx)).toEqual({ text: "linha" });
    expect(calls[1]!.method).toBe("GET");
    expect(calls[1]!.rawBody).toBeUndefined();
    await productivity.notionCreatePage.run({ title: "Nova", content: "a\nb" }, ctx);
    expect(calls[2]!.body).toMatchObject({
      parent: { page_id: "0123456789abcdef0123456789abcdef" },
      properties: { title: { title: [{ text: { content: "Nova" } }] } },
    });
    expect(calls[2]!.body.children).toHaveLength(2);
    expect(calls[2]!.headers.get("content-type")).toBe("application/json");
  });
});

describe("GitHub", () => {
  const gh = (c: Call) => {
    expect(c.headers.get("authorization")).toBe("Bearer github_pat_x");
    expect(c.headers.get("accept")).toBe("application/vnd.github+json");
    expect(c.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(c.headers.get("user-agent")).toBe("planejai");
  };
  it("test() consulta /user e o repositório padrão", async () => {
    on(host("api.github.com", "/user"), () => json({ login: "dev" }));
    on(host("api.github.com", "/repos/dono/repo"), () => json({ full_name: "dono/repo" }));
    expect(await getDef("github")!.test!(CREDS.github!)).toBe("Conectado como dev · dono/repo");
    calls.forEach(gh);
  });
  it("busca exige is:issue/is:pr: sem qualificador faz as duas buscas", async () => {
    on(host("api.github.com", "/search/issues"), (u) =>
      json({ items: [{ number: u.searchParams.get("q")!.includes("is:pr") ? 2 : 1, title: "t", state: "open", html_url: "h", updated_at: "2026-01-0" + (u.searchParams.get("q")!.includes("is:pr") ? "2" : "1") }] }),
    );
    const out: any = await productivity.githubSearchIssues.run({ query: "repo:dono/repo bug" }, ctx);
    expect(calls.map((c) => new URL(c.url).searchParams.get("q")).sort()).toEqual(["repo:dono/repo bug is:issue", "repo:dono/repo bug is:pr"]);
    expect(out.map((i: any) => i.number)).toEqual([2, 1]);
    calls.forEach(gh);
    calls = [];
    await productivity.githubSearchIssues.run({ query: "is:pr is:open" }, ctx);
    expect(calls).toHaveLength(1);
  });
  it("cria issue com POST JSON", async () => {
    on(host("api.github.com", "/repos/dono/repo/issues"), () => json({ number: 7, html_url: "h" }, 201));
    expect(await productivity.githubCreateIssue.run({ title: "T", body: "B" }, ctx)).toEqual({ ok: true, number: 7, url: "h" });
    expect(calls[0]).toMatchObject({ method: "POST", body: { title: "T", body: "B" } });
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    gh(calls[0]!);
  });
  it("repositório inválido é recusado e fora do padrão pede o sim", async () => {
    expect(await productivity.githubCreateIssue.run({ repo: "../../user/repos", title: "T" }, ctx)).toMatchObject({ ok: false });
    expect(await productivity.githubCreateIssue.run({ repo: "dono/..", title: "T" }, ctx)).toMatchObject({ ok: false });
    expect(await productivity.githubCreateIssue.run({ repo: "outra-pessoa/projeto", title: "T" }, ctx)).toMatchObject({ needs_confirmation: true });
    expect(calls).toHaveLength(0);
  });
});

describe("Linear (GraphQL)", () => {
  it("chave pessoal vai sem Bearer; searchIssues e issueCreate", async () => {
    on(host("api.linear.app", "/graphql"), (_u, init) => {
      const q = JSON.parse(String(init.body)).query as string;
      if (q.includes("viewer")) return json({ data: { viewer: { name: "Ana" } } });
      if (q.includes("searchIssues")) return json({ data: { searchIssues: { nodes: [{ identifier: "ENG-1" }] } } });
      if (q.includes("teams")) return json({ data: { teams: { nodes: [{ id: "t0", key: "OPS" }, { id: "t1", key: "ENG" }] } } });
      return json({ data: { issueCreate: { issue: { identifier: "ENG-2", url: "u" } } } });
    });
    expect(await getDef("linear")!.test!(CREDS.linear!)).toBe("Conectado como Ana");
    expect(await productivity.linearSearchIssues.run({ query: "bug" }, ctx)).toEqual([{ identifier: "ENG-1" }]);
    expect(await productivity.linearCreateIssue.run({ title: "T" }, ctx)).toMatchObject({ ok: true, identifier: "ENG-2" });
    for (const c of calls) {
      expect(c.method).toBe("POST");
      expect(c.headers.get("authorization")).toBe("lin_api_x");
      expect(c.headers.get("content-type")).toBe("application/json");
    }
    expect(calls[1]!.body.variables).toEqual({ q: "bug" });
    expect(calls[3]!.body.variables.input).toEqual({ teamId: "t1", title: "T" });
  });
  it("erro GraphQL vira mensagem clara", async () => {
    on(host("api.linear.app"), () => json({ errors: [{ message: "Authentication required" }] }, 400));
    await expect(productivity.linearSearchIssues.run({ query: "x" }, ctx)).rejects.toThrow("Linear: Authentication required");
  });
});

describe("Slack", () => {
  it("usa form-encoded (métodos de leitura não aceitam JSON) com Bearer", async () => {
    on(host("slack.com", "/api/auth.test"), () => json({ ok: true, team: "Time" }));
    on(host("slack.com", "/api/conversations.list"), () => json({ ok: true, channels: [{ id: "C1", name: "geral", is_member: true }, { id: "C2", is_member: false }] }));
    on(host("slack.com", "/api/conversations.history"), () => json({ ok: true, messages: [{ user: "U", text: "oi", ts: "1" }] }));
    on(host("slack.com", "/api/chat.postMessage"), () => json({ ok: true, ts: "2" }));
    expect(await getDef("slack")!.test!(CREDS.slack!)).toBe("Conectado ao workspace Time");
    expect(await communication.slackListChannels.run({}, ctx)).toEqual([{ id: "C1", name: "geral" }]);
    expect(await communication.slackReadChannel.run({ channel: "C1", limit: 5 }, ctx)).toHaveLength(1);
    expect(await communication.slackSendMessage.run({ channel: "C1", text: "olá" }, { ...ctx, approvedAction: true })).toEqual({ ok: true, ts: "2" });
    for (const c of calls) expect(c.headers.get("authorization")).toBe("Bearer xoxb-x");
    for (const c of calls.slice(1)) {
      expect(c.method).toBe("POST");
      expect(c.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    }
    expect(calls[1]!.body).toEqual({ limit: "200", types: "public_channel,private_channel", exclude_archived: "true" });
    expect(calls[2]!.body).toEqual({ channel: "C1", limit: "5" });
    expect(calls[3]!.body).toEqual({ channel: "C1", text: "olá" });
  });
  it("ok:false vira erro", async () => {
    on(host("slack.com"), () => json({ ok: false, error: "not_in_channel" }));
    await expect(communication.slackReadChannel.run({ channel: "C9" }, ctx)).rejects.toThrow("not_in_channel");
  });
});

describe("Busca na web", () => {
  it("Tavily: POST /search com Bearer", async () => {
    on(host("api.tavily.com", "/search"), () => json({ answer: "a", results: [{ title: "t", url: "u", content: "c" }], images: ["i"] }));
    const out: any = await research.webSearch.run({ query: "cinema hoje", max_results: 3 }, ctx);
    expect(out).toMatchObject({ provider: "tavily", answer: "a", results: [{ title: "t", url: "u", content: "c" }] });
    expect(calls[0]).toMatchObject({ method: "POST", body: { query: "cinema hoje", max_results: 3, include_answer: true, include_images: true } });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer tvly-x");
    await getDef("tavily")!.test!(CREDS.tavily!);
  });
  it("Brave: GET /res/v1/web/search com X-Subscription-Token", async () => {
    enabled.delete("tavily");
    await disconnect("tavily"); // limpa o cache de credenciais
    on(host("api.search.brave.com", "/res/v1/web/search"), () => json({ web: { results: [{ title: "t", url: "u", description: "d" }] } }));
    const out: any = await research.webSearch.run({ query: "celular", max_results: 4 }, ctx);
    expect(out).toEqual({ provider: "brave", results: [{ title: "t", url: "u", content: "d" }] });
    const u = new URL(calls[0]!.url);
    expect(Object.fromEntries(u.searchParams)).toEqual({ q: "celular", count: "4", country: "BR", search_lang: "pt-br" });
    expect(calls[0]!.headers.get("x-subscription-token")).toBe("BSAx");
    expect(calls[0]!.headers.get("accept")).toBe("application/json");
  });
});

describe("Browserless", () => {
  it("test(), /chromium/content e /chromium/screenshot com ?token=", async () => {
    on(host("browserless:3000", "/json/version"), () => json({ Browser: "Chrome/1" }));
    on(host("browserless:3000", "/chromium/content"), () => new Response("<p>oi</p>"));
    on(host("browserless:3000", "/chromium/screenshot"), () => new Response(new Uint8Array([1, 2, 3])));
    expect(await getDef("browserless")!.test!(CREDS.browserless!)).toBe("Navegador pronto (Chrome/1)");
    expect(calls[0]!.url).toBe("http://browserless:3000/json/version?token=btok");
    expect(await research.fetchUrl.run({ url: "https://ex.com" }, ctx)).toMatchObject({ text: "oi" });
    expect(calls[1]).toMatchObject({ url: "http://browserless:3000/chromium/content?token=btok", method: "POST", body: { url: "https://ex.com" } });
    await research.screenshotUrl.run({ url: "https://ex.com" }, ctx);
    expect(calls[2]!.body).toMatchObject({ url: "https://ex.com", options: { type: "jpeg", fullPage: false }, viewport: { width: 1280, height: 900 } });
  });
});

describe("Mercado Livre", () => {
  it("renova token (form-encoded) e busca anúncios com Bearer", async () => {
    on(host("api.mercadolibre.com", "/oauth/token"), () => json({ access_token: "APP_USR-tok", refresh_token: "TG-new", expires_in: 21600 }));
    on(host("api.mercadolibre.com", "/sites/MLB/search"), () =>
      json({ paging: { total: 1 }, results: [{ title: "Celular", price: 999, condition: "new", shipping: { free_shipping: true }, permalink: "p" }] }),
    );
    const out: any = await research.mercadolivreSearch.run({ query: "celular", sort: "price_asc" }, ctx);
    expect(out).toMatchObject({ source: "anuncios", total: 1, items: [{ title: "Celular", price: 999, free_shipping: true, link: "p" }] });
    const tok = callTo((c) => c.url.endsWith("/oauth/token"));
    expect(tok.method).toBe("POST");
    expect(tok.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(tok.body).toEqual({ grant_type: "refresh_token", client_id: "mlid", client_secret: "mlsecret", refresh_token: "TG-old" });
    const s = callTo((c) => c.url.includes("/sites/MLB/search"));
    expect(s.headers.get("authorization")).toBe("Bearer APP_USR-tok");
    expect(Object.fromEntries(new URL(s.url).searchParams)).toEqual({ q: "celular", limit: "8", sort: "price_asc" });
  });

  it("403 na busca de anúncios cai para o catálogo (/products/search + /products/{id}/items)", async () => {
    on(host("api.mercadolibre.com", "/sites/MLB/search"), () => json({ message: "forbidden", status: 403 }, 403));
    on(host("api.mercadolibre.com", "/products/search"), () => json({ paging: { total: 2 }, results: [{ id: "MLB1", name: "iPhone", pictures: [{ url: "img" }] }] }));
    on(host("api.mercadolibre.com", "/products/MLB1/items"), () =>
      json({ results: [{ price: 5000, condition: "new", shipping: { free_shipping: true } }, { price: 4500, condition: "new", shipping: { free_shipping: false } }] }),
    );
    const out: any = await research.mercadolivreSearch.run({ query: "iphone", limit: 3 }, ctx);
    expect(out).toEqual({
      source: "catalogo",
      total: 2,
      items: [{ title: "iPhone", price: 4500, original_price: undefined, condition: "new", free_shipping: false, offers: 2, link: "https://www.mercadolivre.com.br/p/MLB1", thumbnail: "img" }],
    });
    const cat = new URL(callTo((c) => c.url.includes("/products/search")).url);
    expect(Object.fromEntries(cat.searchParams)).toEqual({ status: "active", site_id: "MLB", q: "iphone", limit: "3" });
    for (const c of calls) expect(c.headers.get("authorization")).toMatch(/^Bearer /);
  });

  it("403 também no catálogo devolve erro claro", async () => {
    on(host("api.mercadolibre.com"), () => json({ message: "forbidden" }, 403));
    const out: any = await research.mercadolivreSearch.run({ query: "tv" }, ctx);
    expect(out.error).toContain("403");
  });

  it("test() usa /users/me", async () => {
    on(host("api.mercadolibre.com", "/users/me"), () => json({ nickname: "LOJA" }));
    expect(await getDef("mercadolivre")!.test!(CREDS.mercadolivre!)).toBe("Conectado como LOJA");
  });
});

describe("Pagamentos", () => {
  it("Mercado Pago: test() e POST /checkout/preferences com idempotência", async () => {
    on(host("api.mercadopago.com", "/users/me"), () => json({ nickname: "VEND" }));
    on(host("api.mercadopago.com", "/checkout/preferences"), () => json({ id: "pref1", init_point: "https://mp/pay" }, 201));
    expect(await getDef("mercadopago")!.test!(CREDS.mercadopago!)).toBe("Conectado como VEND");
    const out = await finance.createPaymentLink.run({ title: "Aula", amount: 50.5, quantity: 2 }, { ...ctx, approvedAction: true });
    expect(out).toEqual({ provider: "mercadopago", url: "https://mp/pay", id: "pref1" });
    const c = calls[1]!;
    expect(c.method).toBe("POST");
    expect(c.headers.get("authorization")).toBe("Bearer APP_USR-x");
    expect(c.headers.get("x-idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(c.body).toEqual({ items: [{ title: "Aula", quantity: 2, unit_price: 50.5, currency_id: "BRL" }] });
  });
});
