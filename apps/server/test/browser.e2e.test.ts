import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * O "computador" do Pesquisador: abre um site, clica, digita, e a navegação sai gravada em MP4.
 * Roda quando há um Chrome local (CHROME_PATH); em produção o navegador é o browserless da stack.
 */
const enabled = Boolean(process.env.CHROME_PATH && process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("navegador com gravação", () => {
  let server: http.Server;
  let base = "";
  const seen: string[] = [];
  beforeAll(async () => {
    await (await import("../src/db/migrate.js")).migrate(() => {});
    server = http
      .createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (req.url?.startsWith("/checkout")) {
          const pay = new URL(req.url, "http://x").searchParams.get("pay");
          res.end(
            `<label><input type="radio" name="p" ${pay === "card" ? "checked" : ""}> Cartão de crédito final 4242</label>` +
              `<label><input type="radio" name="p" ${pay === "pix" ? "checked" : ""}> Pix</label>` +
              `<button onclick="document.title='pedido'">Finalizar compra</button><button>Comprar agora</button>` +
              `<input type="text" placeholder="Pergunte ao vendedor"><a href="http://localhost:${(server.address() as any).port}/fora">outro site</a>`,
          );
        } else if (req.url?.startsWith("/login")) {
          seen.push(String(req.headers["user-agent"]));
          res.end(`<meta name="viewport" content="width=device-width"><h1>Entrar</h1><input type="password" placeholder="Senha"><button>Entrar</button>`);
        } else if (req.url?.startsWith("/form")) {
          // página com muitos links antes do formulário, aviso de cookies, menu que abre e lista feita de div
          res.end(
            `<div id="ck">Usamos cookies para melhorar sua experiência <button onclick="document.getElementById('ck').remove()">Aceitar</button></div>` +
              `<nav>${Array.from({ length: 60 }, (_, i) => `<a href="/l${i}">Link ${i}</a>`).join(" ")}</nav>` +
              `<button aria-haspopup="menu" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('m').hidden=false">Conta</button>` +
              `<div role="menu" id="m" hidden><a role="menuitem" href="/sessoes?q=pedidos">Meus pedidos</a></div>` +
              `<form action="/sessoes"><label>Nome <input name="nome" required></label><label>Cidade <select name="c"><option>Campinas</option><option>Recife</option></select></label>` +
              `<label><input type="checkbox" name="news"> Quero novidades</label>` +
              `<label>Senha <input type="password" name="s"></label><label>Número do cartão <input name="cc" autocomplete="cc-number"></label>` +
              `<div role="combobox" tabindex="0" aria-label="Sabor" onclick="document.getElementById('lb').hidden=false">escolha</div>` +
              `<ul role="listbox" id="lb" hidden><li role="option" onclick="document.querySelector('[aria-label=Sabor]').innerText='Morango';this.parentNode.hidden=true">Morango</li></ul>` +
              `<button type="button">Pagar agora</button></form><form action="/sessoes"><input name="q" placeholder="Digite para entrar"></form>`,
          );
        } else if (req.url?.startsWith("/longa")) {
          res.end(`<h1>Topo da página</h1><div style="height:4000px">${"<p>enchimento</p>".repeat(5)}</div><h2>Fim com o preço R$ 249,99</h2><button>Adicionar ao carrinho</button>`);
        } else if (req.url?.startsWith("/sessoes")) {
          const filme = new URL(req.url, "http://x").searchParams.get("q");
          res.end(`<h1>Sessões de ${filme}</h1><p>14h30 · 17h00 · 20h15</p>`);
        } else {
          res.end(`<h1>Cinema Teste</h1><form action="/sessoes"><input name="q" placeholder="Buscar filme"><button>Buscar</button></form><a href="/sessoes?q=todos">Ver todas</a>`);
        }
      })
      .listen(0);
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => {
    server?.close();
    await (await import("../src/db/pool.js")).pool.end();
  });

  it("navega como uma pessoa e grava a tela", async () => {
    const { BrowserSession } = await import("../src/agent/browser.js");
    const b = await BrowserSession.open(true);
    try {
      await b.goto(base);
      const s1 = await b.snapshot();
      expect(s1.text).toContain("Cinema Teste");
      const input = s1.elements.match(/\[(\d+)\] campo text: Buscar filme/)?.[1];
      const button = s1.elements.match(/\[(\d+)\] botão: Buscar/)?.[1];
      expect(input && button).toBeTruthy();
      await b.act({ action: "type", ref: Number(input), text: "Duna" });
      await b.act({ action: "click", ref: Number(button) });
      const s2 = await b.snapshot();
      expect(s2.text).toContain("Sessões de Duna");
      expect(s2.text).toContain("20h15");
      expect(b.actions).toEqual([`abrir ${base}`, `digitar "Duna" em [${input}]`, `clicar [${button}]`]);
      const video = await b.stopRecording();
      expect(video).not.toBeNull();
      expect(video!.subarray(4, 8).toString()).toBe("ftyp"); // MP4 de verdade
      expect(video!.length).toBeGreaterThan(1000);
    } finally {
      await b.close();
    }
  }, 60_000);

  it("rolou a página: o texto e a lista começam onde está a tela; item que sumiu volta como lista nova", async () => {
    const { BrowserSession } = await import("../src/agent/browser.js");
    const b = await BrowserSession.open(false);
    try {
      await b.goto(`${base}/longa`);
      expect((await b.snapshot()).text).toContain("Topo da página");
      await b.page.evaluate(() => window.scrollTo(0, 3800));
      const s = await b.snapshot();
      expect(s.text).toContain("R$ 249,99");
      expect(s.text).not.toContain("Topo da página");
      const { browserAction } = await import("../src/agent/tools/research.js");
      const ctx: any = { room: { browser: b, usage: { browserActions: 0 } }, agent: "pesquisador" };
      const r: any = await browserAction.run({ action: "click", ref: 99 }, ctx);
      expect(r.error).toMatch(/não está mais na página/);
      expect(r.clickable ?? r.elements).toBeTruthy();
    } finally {
      await b.close();
    }
  }, 60_000);

  it("vê e preenche formulário, menu e lista; aceita cookies; recusa senha, cartão e botão de pagar", async () => {
    const { BrowserSession } = await import("../src/agent/browser.js");
    const { browserAction } = await import("../src/agent/tools/research.js");
    const b = await BrowserSession.open(false);
    const ctx: any = { room: { browser: b, usage: { browserActions: 0 } }, agent: "pesquisador" };
    const ref = (list: string, re: RegExp) => Number(list.match(new RegExp(`\\[(\\d+)\\] ${re.source}`))?.[1]);
    try {
      await b.goto(`${base}/form`);
      expect(b.actions).toContain("aceitar aviso de cookies");
      let s = await b.snapshot();
      // campos vêm antes dos 60 links, com rótulo do <label>, estado e opções
      expect(s.elements).toMatch(/campo text: Nome \(obrigatório\)/);
      expect(s.elements).toMatch(/lista: Cidade = "Campinas" \(opções: Campinas, Recife\)/);
      expect(s.elements).toMatch(/caixa de marcar: Quero novidades \(desmarcado\)/);
      expect(s.elements).toMatch(/campo senha: Senha/);
      expect(s.elements).toMatch(/campo cartão: Número do cartão/);
      expect(s.elements).toMatch(/botão: Conta \(abre menu\)/);
      expect(s.elements).not.toMatch(/Aceitar/);

      let r: any = await browserAction.run({ action: "type", ref: ref(s.elements, /campo senha/), text: "123456" }, ctx);
      expect(r.error).toMatch(/Senha e dados de cartão/);
      r = await browserAction.run({ action: "type", ref: ref(r.clickable, /campo text: Nome/), text: "4111 1111 1111 1111" }, ctx);
      expect(r.error).toMatch(/cartão/);
      r = await browserAction.run({ action: "click", ref: ref(r.clickable, /botão: Pagar agora/) }, ctx);
      expect(r.error).toMatch(/quem conclui é a pessoa/);

      const list = r.clickable as string;
      r = await browserAction.run(
        { action: "fill", fields: [{ ref: ref(list, /campo text: Nome/), text: "Ana" }, { ref: ref(list, /lista: Cidade/), text: "recife" }] },
        ctx,
      );
      expect(r.clickable).toMatch(/campo text: Nome = "Ana"/);
      expect(r.clickable).toMatch(/lista: Cidade = "Recife"/);
      r = await browserAction.run({ action: "click", ref: ref(r.clickable, /caixa de marcar/) }, ctx);
      expect(r.clickable).toMatch(/Quero novidades \(marcado\)/);
      r = await browserAction.run({ action: "select", ref: ref(r.clickable, /lista: Sabor/), text: "morango" }, ctx);
      expect(r.clickable).toMatch(/lista: Sabor = "Morango"/);

      // menu: abre e o item dele vem primeiro na lista
      r = await browserAction.run({ action: "click", ref: ref(r.clickable, /botão: Conta/) }, ctx);
      expect(r.clickable).toMatch(/^\(aberto na frente: "Meus pedidos"/);
      expect(r.clickable).toMatch(/\[1\] item de menu: Meus pedidos/);

      // "digite para entrar": digita e aperta Enter
      r = await browserAction.run({ action: "type", ref: ref(r.clickable, /campo text: Digite para entrar/), text: "Duna", submit: true }, ctx);
      expect(r.page_text).toContain("Sessões de");
    } finally {
      await b.close();
    }
  }, 90_000);

  it("site abre como um Chrome comum, no tamanho do aparelho", async () => {
    const { BrowserSession } = await import("../src/agent/browser.js");
    for (const device of ["mobile", "desktop"] as const) {
      const b = await BrowserSession.open(false, { device });
      try {
        await b.goto(`${base}/login`);
        const info = await b.page.evaluate(() => ({ ua: navigator.userAgent, webdriver: navigator.webdriver, w: innerWidth, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.languages[0] }));
        expect(info.ua).not.toMatch(/Headless/);
        expect(seen.at(-1)).not.toMatch(/Headless/);
        expect(info.webdriver).toBeFalsy();
        expect(info).toMatchObject({ w: device === "mobile" ? 390 : 1280, tz: "America/Sao_Paulo", lang: "pt-BR" });
        expect(info.ua.includes("Mobile")).toBe(device === "mobile");
      } finally {
        await b.close();
      }
    }
  }, 60_000);
});
