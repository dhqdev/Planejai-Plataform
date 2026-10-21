import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Uber pelo WhatsApp (beta): o robô entra pelo número (código por SMS que a pessoa manda, ou por e-mail lido do Gmail),
 * lê as opções, manda a lista sem IA, pede só depois do sim e não pede se o preço subiu. A "Uber" aqui é uma página
 * falsa local; o site de verdade não abre no ambiente de teste.
 */
const enabled = Boolean(process.env.CHROME_PATH && process.env.TEST_DATABASE_URL);

const sent: string[] = [];
let onSent: ((text: string) => void) | null = null;
vi.mock("../src/social.js", async (orig) => ({
  ...(await orig<typeof import("../src/social.js")>()),
  notifyUser: vi.fn(async (_id: string, text: string) => {
    sent.push(text);
    onSent?.(text);
  }),
}));
let gmailCode: string | null = null;
vi.mock("../src/integrations/registry.js", async (orig) => {
  const real = await orig<typeof import("../src/integrations/registry.js")>();
  return { ...real, isConnected: vi.fn(async (id: string) => (id === "google" ? gmailCode !== null : real.isConnected(id))) };
});
vi.mock("../src/integrations/google.js", async (orig) => ({
  ...(await orig<typeof import("../src/integrations/google.js")>()),
  googleApi: vi.fn(async (url: string) => {
    if (url.includes("/messages?")) return { messages: [{ id: "m1" }] };
    return {
      internalDate: String(Date.now()),
      snippet: `Seu código da Uber é ${gmailCode}. Não compartilhe.`,
      payload: { headers: [{ name: "Subject", value: "Código Uber" }], mimeType: "text/plain", body: { data: Buffer.from(`Código ${gmailCode}`).toString("base64url") } },
    };
  }),
}));

describe("uber: leitura de preço, código e escolha", () => {
  it("preço vira centavos, código sai do SMS e a escolha acha a opção", async () => {
    const { parsePrice, extractCode, pickOption } = await import("../src/agent/uber-robot.js");
    expect(parsePrice("R$ 23,40")).toEqual({ min: 2340, max: null });
    expect(parsePrice("R$ 1.023,40")).toEqual({ min: 102340, max: null });
    expect(parsePrice("R$ 20,50-25,90")).toEqual({ min: 2050, max: 2590 });
    expect(parsePrice("4 min")).toBeNull();
    expect(extractCode("Seu código Uber é 3728. Não compartilhe.")).toBe("3728");
    expect(extractCode("[#] 2026 Uber: use 4821 para entrar")).toBe("4821");
    expect(extractCode("sem número")).toBeNull();
    const opts = [
      { n: 1, name: "UberX", price_cents: 2340, price_max_cents: null, price_text: "R$ 23,40", eta: "4 min" },
      { n: 2, name: "Comfort", price_cents: 3190, price_max_cents: null, price_text: "R$ 31,90", eta: "6 min" },
      { n: 3, name: "Uber Flash", price_cents: 2000, price_max_cents: null, price_text: "R$ 20,00", eta: null },
    ];
    expect(pickOption(opts, "2")?.name).toBe("Comfort");
    expect(pickOption(opts, "o comfort")?.name).toBe("Comfort");
    expect(pickOption(opts, "uberx")?.name).toBe("UberX");
    expect(pickOption(opts, "flash")?.name).toBe("Uber Flash");
    expect(pickOption(opts, "9")).toBeNull();
    const { uberLink, optionsMessage } = await import("../src/uber.js");
    expect(uberLink("Plaza das Flores, Campinas", "Shopping Dom Pedro")).toContain("dropoff%5Bformatted_address%5D=Shopping+Dom+Pedro");
    expect(uberLink(null, "Dom Pedro")).toContain("pickup=my_location");
    const msg = optionsMessage({ pickup: "a", dropoff: "b", pickup_label: "Plaza das Flores", dropoff_label: "Dom Pedro" }, opts);
    expect(msg).toContain("1. *UberX* · R$ 23,40 · chega em 4 min");
    expect(msg).toContain("beta");
  });
});

describe.skipIf(!enabled)("uber pelo WhatsApp (beta, e2e)", () => {
  let server: http.Server;
  let db: typeof import("../src/db/pool.js");
  let uber: typeof import("../src/uber.js");
  let tools: typeof import("../src/agent/tools/uber.js");
  let user: any;
  let conv: any;
  let price = "23,40";
  let codeBy: "sms" | "email" = "sms";
  let captchaOn = false;
  const typedPhones: string[] = [];
  let requests = 0;

  const home = () => `<!doctype html><meta name="viewport" content="width=device-width">
<input placeholder="Local de partida" id="p" oninput="sug('p')"><input placeholder="Para onde?" id="d" oninput="sug('d')">
<ul role="listbox" id="lb"></ul><button onclick="prices()">Ver preços</button><div id="opts"></div>
<script>
let target;
function sug(id){target=id;const v=document.getElementById(id).value;document.getElementById('lb').innerHTML='<li role="option" onclick="pick(this)">'+v+' - Campinas, SP</li>';}
function pick(li){document.getElementById(target).value=li.textContent;document.getElementById('lb').innerHTML='';}
function prices(){document.getElementById('opts').innerHTML='<ul><li tabindex="0" onclick="sel(\\'UberX\\')"><div>UberX</div><div>4 min</div><div>R$ ${price}</div></li><li tabindex="0" onclick="sel(\\'Comfort\\')"><div>Comfort</div><div>6 min</div><div>R$ 31,90</div></li></ul><button id="go" onclick="req()">Escolher</button>';}
function sel(n){document.getElementById('go').textContent='Escolher '+n;}
function req(){fetch('/requested');document.body.innerHTML='<p>Procurando motorista</p>';setTimeout(()=>{document.body.innerHTML='<p>João chega em 4 min</p><p>Onix prata</p><p>ABC1D23</p><button>Cancelar corrida</button>'},800);}
</script>`;

  const login = () => `<!doctype html><meta name="viewport" content="width=device-width">
<div id="captcha-root"></div><iframe src="/captcha-frame" title="captcha" style="${captchaOn ? "width:300px;height:150px" : "width:0;height:0;border:0"}"></iframe>
<h1>Qual é o seu número de celular ou e-mail?</h1><input type="tel" placeholder="Número de celular ou e-mail" id="ph"><button onclick="next()">Continuar</button>
<script>
function next(){fetch('/send?ph='+encodeURIComponent(document.getElementById('ph').value));
document.body.innerHTML='<p>Digite o código de 4 dígitos que enviamos ${codeBy === "sms" ? "por SMS para o seu celular" : "para o seu e-mail d***@gmail.com"}</p>'+[0,1,2,3].map(()=>'<input maxlength="1" inputmode="numeric" oninput="mv(this)">').join('')+'<button onclick="check()">Verificar</button>';}
function mv(el){if(el.value&&el.nextElementSibling&&el.nextElementSibling.tagName==='INPUT')el.nextElementSibling.focus();}
function check(){const c=[...document.querySelectorAll('input')].map(i=>i.value).join('');fetch('/verify?c='+c).then(r=>r.ok?location.reload():document.body.insertAdjacentHTML('beforeend','<p>código incorreto</p>'));}
</script>`;

  beforeAll(async () => {
    server = http
      .createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        if (u.pathname === "/send") {
          typedPhones.push(u.searchParams.get("ph") ?? "");
          return res.end("ok");
        }
        if (u.pathname === "/verify") {
          const ok = u.searchParams.get("c") === (codeBy === "sms" ? "1234" : "5678");
          res.writeHead(ok ? 200 : 400, ok ? { "set-cookie": "sid=ok; Path=/; Max-Age=86400" } : {});
          return res.end();
        }
        if (u.pathname === "/requested") {
          requests++;
          return res.end();
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(/sid=ok/.test(req.headers.cookie ?? "") ? home() : login());
      })
      .listen(0);
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const robot = await import("../src/agent/uber-robot.js");
    robot.UBER.base = `http://127.0.0.1:${(server.address() as any).port}/go/home`;
    uber = await import("../src/uber.js");
    tools = await import("../src/agent/tools/uber.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    user = await upsertUser("5519955554444", "Davi");
    conv = await upsertConversation(user.id, "playground", "5519955554444");
    const { config } = await import("../src/config.js");
    config.OWNER_PHONES = [user.phone];
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/queue/boss.js")).stopBoss().catch(() => {});
  });

  const ctx = (extra: Record<string, unknown> = {}) => ({ user, conversation: conv, agent: "cto", toolCall: { name: "uber_request", args: {} }, ...extra }) as any;
  const latest = () => db.one<any>("SELECT * FROM uber_rides WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [user.id]);

  it("cota: entra pelo número com o código do SMS (sem IA), lê as opções e manda a lista", async () => {
    // a pessoa responde o código no WhatsApp: o ingest entrega direto ao robô
    onSent = (text) => {
      if (/SMS/.test(text)) setTimeout(() => void uber.handleUberCode(user.id, " 1234 "), 300);
    };
    const r: any = await tools.uberQuote.run({ pickup: "Plaza das Flores", dropoff: "Shopping Dom Pedro" }, ctx());
    expect(r).toMatchObject({ ok: true, queued: true });
    expect(r.message).toContain("beta");
    // a mesma pessoa não abre duas corridas ao mesmo tempo
    expect(await tools.uberQuote.run({ pickup: "a", dropoff: "b" }, ctx())).toMatchObject({ ok: false, busy: true });

    const ride = await latest();
    await uber.runUberJob({ rideId: ride.id, action: "quote" });
    expect(typedPhones).toEqual(["+5519955554444"]);
    const done = await latest();
    expect(done.status).toBe("opcoes");
    expect(done.options.map((o: any) => [o.name, o.price_cents, o.eta])).toEqual([
      ["UberX", 2340, "4 min"],
      ["Comfort", 3190, "6 min"],
    ]);
    expect(done.pickup_label).toBe("Plaza das Flores - Campinas, SP");
    const list = sent.at(-1)!;
    expect(list).toContain("1. *UberX* · R$ 23,40 · chega em 4 min");
    expect(list).toContain("Para: Shopping Dom Pedro - Campinas, SP");
    // sessão cifrada, código não fica guardado e o robô parou de esperar
    const s = await db.one<any>("SELECT * FROM uber_sessions WHERE user_id = $1", [user.id]);
    expect(s).toMatchObject({ status: "ok", waiting_code: null, code_enc: null });
    expect(s.state_enc).not.toContain("sid");
    // fora da espera, "1234" é mensagem comum
    expect(await uber.handleUberCode(user.id, "1234")).toBe(false);
  });

  it("pede só depois do sim, com o resumo do servidor, e manda a placa", async () => {
    const before = sent.length;
    const wait: any = await tools.uberRequest.run({ option: "uberx" }, ctx());
    expect(wait.needs_confirmation).toBe(true);
    const pending = await db.one<any>("SELECT summary FROM pending_actions WHERE conversation_id = $1 AND tool = 'uber_request' AND status = 'pending'", [conv.id]);
    expect(pending.summary).toContain("*UberX*");
    expect(pending.summary).toContain("R$ 23,40");
    expect((await latest()).status).toBe("opcoes");

    expect(await tools.uberRequest.run({ option: "uberx" }, ctx({ approvedAction: true }))).toMatchObject({ ok: true, queued: true });
    const ride = await latest();
    expect(ride.status).toBe("pedindo");
    await uber.runUberJob({ rideId: ride.id, action: "request" });
    expect(requests).toBe(1);
    const done = await latest();
    expect(done.status).toBe("pedida");
    expect(done.driver.plate).toBe("ABC1D23");
    expect(done.driver.car).toBe("Onix prata");
    // sessão salva valeu: não pediu código de novo
    expect(sent.slice(before).some((t) => /código/.test(t))).toBe(false);
    expect(sent.at(-1)).toContain("Placa: *ABC1D23*");
  });

  it("preço subiu depois da escolha: não pede e mostra a lista nova", async () => {
    price = "23,40";
    await tools.uberQuote.run({ pickup: "Casa", dropoff: "Trabalho" }, ctx());
    await uber.runUberJob({ rideId: (await latest()).id, action: "quote" });
    await tools.uberRequest.run({ option: "1" }, ctx({ approvedAction: true }));
    price = "33,40";
    await uber.runUberJob({ rideId: (await latest()).id, action: "request" });
    expect(requests).toBe(1);
    const ride = await latest();
    expect(ride.status).toBe("opcoes");
    expect(ride.chosen).toBeNull();
    expect(sent.at(-1)).toContain("subiu de R$ 23,40 para R$ 33,40");
  });

  it("código por e-mail sai sozinho do Gmail ligado", async () => {
    await uber.forgetUber(user.id);
    codeBy = "email";
    gmailCode = "5678";
    price = "23,40";
    const before = sent.length;
    await tools.uberQuote.run({ pickup: "Casa", dropoff: "Trabalho" }, ctx());
    await uber.runUberJob({ rideId: (await latest()).id, action: "quote" });
    expect((await latest()).status).toBe("opcoes");
    // não precisou pedir o código para a pessoa
    expect(sent.slice(before).some((t) => /e-mail/.test(t))).toBe(false);
  });

  it("captcha de verdade na tela: desiste, manda o link e o print só para o dono", async () => {
    await uber.forgetUber(user.id);
    captchaOn = true;
    const before = sent.length;
    await tools.uberQuote.run({ pickup: "Casa", dropoff: "Trabalho" }, ctx());
    await uber.runUberJob({ rideId: (await latest()).id, action: "quote" });
    captchaOn = false;
    expect((await latest()).status).toBe("erro");
    const out = sent.slice(before);
    expect(out[0]).toContain("verificação de robô");
    expect(out[0]).toContain("m.uber.com/ul/");
    expect(out[1]).toContain("Print da tela");
  });

  it("Atalho do iPhone: token pessoal entrega o código do SMS; token errado não", async () => {
    const token = await uber.newShortcutToken(user.id);
    expect(await uber.handleShortcutCode("x".repeat(30), "Uber 1111")).toMatchObject({ ok: false });
    // ninguém esperando: aceita o token, mas não usa
    expect(await uber.handleShortcutCode(token, "Seu código Uber é 4821")).toEqual({ ok: true, used: false });
    await db.query("UPDATE uber_sessions SET waiting_code = 'sms', waiting_since = now() WHERE user_id = $1", [user.id]);
    expect(await uber.handleShortcutCode(token, "Promoção do Banco 9999")).toEqual({ ok: true, used: false });
    expect(await uber.handleShortcutCode(token, "Seu código Uber é 4821. Não compartilhe.")).toEqual({ ok: true, used: true });
  });

  it("beta desligada (ou só para o dono): manda o link do app em vez de entrar na conta", async () => {
    const { saveSettings } = await import("../src/settings.js");
    await saveSettings({ uberAccess: "off" });
    const r: any = await tools.uberQuote.run({ pickup: "Casa", dropoff: "Dom Pedro" }, ctx());
    expect(r).toMatchObject({ ok: false, not_enabled: true });
    expect(r.link).toMatch(/^https:\/\/m\.uber\.com\/ul\/\?action=setPickup/);
    await expect(saveSettings({ uberAccess: "talvez" as any })).rejects.toThrow();
    await saveSettings({ uberAccess: "owner" });
  });
});
