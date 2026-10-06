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
  beforeAll(async () => {
    await (await import("../src/db/migrate.js")).migrate(() => {});
    server = http
      .createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        if (req.url?.startsWith("/sessoes")) {
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
});
