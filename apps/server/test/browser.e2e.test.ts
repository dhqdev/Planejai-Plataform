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

  it("loja abre como um Chrome comum, no tamanho do aparelho, e a senha digitada não aparece para o modelo", async () => {
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
        const ref = Number((await b.snapshot()).elements.match(/\[(\d+)\] campo password/)?.[1]);
        await b.fillSecret(ref, "s3gredo!", "a senha da loja", "password");
        const after = await b.snapshot();
        expect(JSON.stringify(after)).not.toContain("s3gredo");
        expect(b.actions.join(" ")).not.toContain("s3gredo");
        expect(await b.page.$eval("input", (el) => (el as HTMLInputElement).value)).toBe("s3gredo!");
      } finally {
        await b.close();
      }
    }
  }, 60_000);

  it("logado numa loja: só fecha pedido com Pix escolhido, não sai do site e segredo só no campo certo", async () => {
    const { BrowserSession } = await import("../src/agent/browser.js");
    const b = await BrowserSession.open(false);
    b.lockedTo = ["127.0.0.1"];
    try {
      const refOf = async (re: RegExp) => Number((await b.snapshot()).elements.match(re)?.[1]);
      await b.goto(`${base}/checkout?pay=card`);
      await expect(b.act({ action: "click", ref: await refOf(/\[(\d+)\] botão: Finalizar compra/) })).rejects.toThrow(/Pix não está escolhido/);
      await expect(b.act({ action: "click", ref: await refOf(/\[(\d+)\] botão: Comprar agora/) })).rejects.toThrow(/carrinho/);
      await expect(b.fillSecret(await refOf(/\[(\d+)\] campo text: Pergunte/), "s3gredo!", "a senha da loja", "password")).rejects.toThrow(/senha/);
      await expect(b.fillSecret(await refOf(/\[(\d+)\] campo text: Pergunte/), "123456", "o código", "code")).rejects.toThrow(/código/);
      // sair da loja logada é bloqueado
      await b.act({ action: "click", ref: await refOf(/\[(\d+)\] link: outro site/) });
      expect(b.page.url()).toContain("127.0.0.1");
      expect(b.actions.join(" ")).toContain("bloqueado: sair da loja");
      await b.goto(`${base}/checkout?pay=pix`);
      await b.act({ action: "click", ref: await refOf(/\[(\d+)\] botão: Finalizar compra/) });
      expect(await b.page.title()).toBe("pedido");
    } finally {
      await b.close();
    }
  }, 60_000);
});
