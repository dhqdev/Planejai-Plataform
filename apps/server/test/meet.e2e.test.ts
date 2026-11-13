import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Secretária de reuniões: o painel manda trechos de áudio, cada um vira texto (o áudio sai do banco), o fim
 * escreve a ata no formato do redator, gera o PDF, guarda em Documentos e manda no WhatsApp. Uma execução só.
 */
process.env.OPENROUTER_API_KEY ||= "sk-test";
const enabled = Boolean(process.env.TEST_DATABASE_URL);

const ATA = `SUBTÍTULO: Lançamento do app com Ana e Bruno
## Resumo
A reunião definiu a data do lançamento.
## Tópicos discutidos
- Data do lançamento
## Decisões
- Lançar dia 20
## Tarefas e responsáveis
| Tarefa | Quem | Prazo |
| --- | --- | --- |
| Revisar a loja | Ana | 18/10 |
## Sugestões
- Testar o cadastro antes
IMAGEM: foguete
## Pontos em aberto
- Preço do plano anual`;

const calls: any[] = [];
const sent: any[] = [];
vi.mock("../src/llm/openrouter.js", async (orig) => ({
  ...(await orig<typeof import("../src/llm/openrouter.js")>()),
  chatCompletion: vi.fn(async (_choice: any, req: any) => {
    calls.push(req);
    const audio = Array.isArray(req.messages[0].content) && req.messages[0].content.find((c: any) => c.type === "input_audio");
    if (audio) {
      const n = calls.filter((c) => Array.isArray(c.messages[0].content)).length;
      return { message: { content: n === 2 ? "[silêncio]" : "Ana: vamos lançar dia 20.\nBruno: fechado, eu cuido da loja até dia 18." }, model: "fake/omni", tokensIn: 500, tokensOut: 40, costUsd: 0.0004 };
    }
    return { message: { content: ATA }, model: "fake/writer", tokensIn: 900, tokensOut: 400, costUsd: 0.001 };
  }),
}));
vi.mock("../src/pdf.js", async (orig) => ({
  ...(await orig<typeof import("../src/pdf.js")>()),
  renderPdf: vi.fn(async () => Buffer.from("%PDF-1.4 ata")),
}));
vi.mock("../src/social.js", async (orig) => ({
  ...(await orig<typeof import("../src/social.js")>()),
  notifyUser: vi.fn(async (...a: any[]) => void sent.push(a)),
}));

describe("ata da reunião: formato", () => {
  it("recusa do Meet: a mensagem cita o que a página mostrou e não inventa motivo", async () => {
    const { meetRefusalText } = await import("../src/meet-bot.js");
    const blocked = meetRefusalText("Google Meet\nVocê não pode participar desta videochamada\nVoltar à tela inicial");
    expect(blocked).toContain('"Você não pode participar desta videochamada"');
    expect(blocked).toContain("Ninguém da reunião recebeu pedido");
    expect(blocked).not.toMatch(/empresa/);
    expect(meetRefusalText("Alguém na chamada recusou sua solicitação")).toBe("alguém da reunião recusou a minha entrada.");
  });

  it("meetSpec tira foto e sumário, marca a capa como ata e mantém a tabela de tarefas", async () => {
    const { meetSpec, defaultTitle } = await import("../src/meet.js");
    const spec = meetSpec("Lançamento", ATA);
    expect(spec).toMatchObject({ subtitle: "Lançamento do app com Ana e Bruno", kicker: "Ata de reunião", toc: false });
    expect(spec.sections.map((s) => s.title)).toEqual(["Resumo", "Tópicos discutidos", "Decisões", "Tarefas e responsáveis", "Sugestões", "Pontos em aberto"]);
    expect(spec.sections[3]!.table).toEqual({ columns: ["Tarefa", "Quem", "Prazo"], rows: [["Revisar a loja", "Ana", "18/10"]] });
    expect(spec.sections.some((s) => s.image)).toBe(false);
    expect(spec.coverImage).toBeUndefined();
    expect(defaultTitle(new Date("2026-10-16T15:05:00Z"))).toBe("Reunião de 16/10 às 12:05");
  });
});

describe.skipIf(!enabled)("secretária de reuniões (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let meet: typeof import("../src/meet.js");
  let app: any;
  let user: any;
  let cookie: string;
  // trecho de verdade (webm/opus, como o painel manda) quando tem ffmpeg; sem ele o servidor manda como veio
  const audio = (() => {
    try {
      const out = join(mkdtempSync(join(tmpdir(), "pj-meet-t-")), "a.webm");
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-f", "webm", out]);
      return readFileSync(out).toString("base64");
    } catch {
      return Buffer.alloc(3000, 1).toString("base64");
    }
  })();

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await db.query("DROP SCHEMA IF EXISTS pgboss CASCADE");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    meet = await import("../src/meet.js");
    const { upsertUser } = await import("../src/ingest.js");
    user = await upsertUser("5519955553333", "Davi");
    const { config } = await import("../src/config.js");
    config.OWNER_PHONES = [user.phone];
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });

  afterAll(async () => {
    await (await import("../src/queue/boss.js")).stopBoss().catch(() => {});
    await app?.close();
  });

  it("trechos viram texto, o áudio some e o fim gera a ata em PDF, Documentos e WhatsApp", async () => {
    const s = (await app.inject({ method: "POST", url: "/api/meet", headers: { cookie }, payload: { title: "Lançamento do app" } })).json();
    expect(s).toMatchObject({ title: "Lançamento do app", status: "gravando" });
    for (const seq of [0, 1, 2]) {
      const r = await app.inject({ method: "POST", url: `/api/meet/${s.id}/chunk`, headers: { cookie }, payload: { seq, mimetype: "audio/webm;codecs=opus", base64: audio } });
      expect(r.statusCode).toBe(200);
    }
    // reenvio do mesmo trecho não duplica; trecho fora da faixa é recusado
    expect((await app.inject({ method: "POST", url: `/api/meet/${s.id}/chunk`, headers: { cookie }, payload: { seq: 0, base64: audio } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/meet/${s.id}/chunk`, headers: { cookie }, payload: { seq: 999, base64: audio } })).statusCode).toBe(400);
    expect((await db.one<{ n: number }>("SELECT count(*)::int AS n FROM meet_chunks WHERE session_id = $1", [s.id]))!.n).toBe(3);

    await meet.runMeetJob({ action: "chunk", sessionId: s.id, seq: 0 });
    await meet.runMeetJob({ action: "chunk", sessionId: s.id, seq: 1 });
    const live = (await app.inject({ method: "GET", url: `/api/meet/${s.id}`, headers: { cookie } })).json();
    expect(live.parts.map((p: any) => p.status)).toEqual(["pronto", "pronto", "pendente"]);
    expect(live.parts[0].transcript).toContain("lançar dia 20");
    expect(live.parts[1].transcript).toBe(""); // silêncio não vira texto
    expect((await db.one<{ n: number }>("SELECT count(*)::int AS n FROM meet_chunks WHERE audio IS NOT NULL"))!.n).toBe(1);

    expect((await app.inject({ method: "POST", url: `/api/meet/${s.id}/stop`, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/meet/${s.id}/chunk`, headers: { cookie }, payload: { seq: 3, base64: audio } })).statusCode).toBe(409);
    // o fim transcreve o trecho que ficou para trás antes de escrever
    await meet.runMeetJob({ action: "finish", sessionId: s.id });
    const done = (await app.inject({ method: "GET", url: `/api/meet/${s.id}`, headers: { cookie } })).json();
    expect(done.status).toBe("pronto");
    expect(done.parts.every((p: any) => p.status === "pronto")).toBe(true);
    expect(done.summary).toContain("## Decisões");
    const doc = await db.one("SELECT name, folder, mimetype FROM documents WHERE id = $1", [done.document_id]);
    expect(doc).toMatchObject({ name: "Lançamento do app.pdf", folder: "Reuniões", mimetype: "application/pdf" });
    const writer = calls.at(-1);
    expect(writer.messages[1].content).toContain("Bruno: fechado");
    expect(sent.at(-1)![2]).toMatchObject({ kind: "document", fileName: "Lançamento do app.pdf" });

    // tudo numa execução só, com custo somado
    const ex = await db.one("SELECT trigger, status, cost_usd FROM executions WHERE id = (SELECT execution_id FROM meet_sessions WHERE id = $1)", [s.id]);
    expect(ex).toMatchObject({ trigger: "reuniao", status: "success" });
    expect(Number(ex.cost_usd)).toBeCloseTo(0.0022, 6);
    const steps = await db.many("SELECT name FROM execution_steps WHERE execution_id = (SELECT execution_id FROM meet_sessions WHERE id = $1) ORDER BY id", [s.id]);
    expect(steps.map((x: any) => x.name)).toEqual(["transcrever trecho 1", "transcrever trecho 2", "transcrever trecho 3", "escrever a ata"]);

    const list = (await app.inject({ method: "GET", url: "/api/meet", headers: { cookie } })).json();
    expect(list.items[0]).toMatchObject({ id: s.id, status: "pronto", chunks: 3 });
    expect(list.items[0].overview).toContain("definiu a data");

    // o agente lê a ata pelo WhatsApp
    const { meetingList, meetingRead } = await import("../src/agent/tools/meet.js");
    const ctx: any = { user: { id: user.id } };
    expect(((await meetingList.run({}, ctx)) as any).meetings[0].id).toBe(s.id);
    const read: any = await meetingRead.run({ id: s.id, transcript: true }, ctx);
    expect(read.ata).toContain("Revisar a loja");
    expect(read.transcricao).toContain("Ana:");
  });

  it("reunião sem fala não vira ata; outra pessoa não vê nem manda trecho", async () => {
    const s = await meet.startMeet(user.id, "");
    expect(s.title).toMatch(/^Reunião de /);
    await meet.stopMeet(user.id, s.id);
    await meet.runMeetJob({ action: "finish", sessionId: s.id });
    const row = await db.one("SELECT status, error FROM meet_sessions WHERE id = $1", [s.id]);
    expect(row.status).toBe("erro");
    expect(row.error).toContain("Compartilhar áudio da guia");

    const { upsertUser } = await import("../src/ingest.js");
    const other = await upsertUser("5519955554444", "Outra");
    expect(await meet.getMeet(other.id, s.id)).toBeNull();
    expect(await meet.addChunk(other.id, s.id, 0, Buffer.from("x"), "audio/webm")).toMatchObject({ ok: false, status: 404 });
    expect(await meet.deleteMeet(other.id, s.id)).toBe(false);
    expect(await meet.deleteMeet(user.id, s.id)).toBe(true);
  });

  it("abrir outra reunião fecha a que ficou aberta", async () => {
    const a = await meet.startMeet(user.id, "Primeira");
    const b = await meet.startMeet(user.id, "Segunda");
    expect((await db.one("SELECT status FROM meet_sessions WHERE id = $1", [a.id])).status).toBe("resumindo");
    expect(b.status).toBe("gravando");
  });

  it("link do Meet: só aceita meet.google.com, uma reunião por vez, e cancelar antes de entrar avisa o robô", async () => {
    const bot = await import("../src/meet-bot.js");
    expect(bot.meetLink("entra aí https://meet.google.com/ABC-defg-hij?authuser=0 valeu")).toBe("https://meet.google.com/abc-defg-hij");
    expect(bot.meetLink("https://zoom.us/j/123")).toBeNull();
    expect((await bot.joinMeetByLink(user.id, "https://evil.com/abc-defg-hij")).ok).toBe(false);
    const r = await bot.joinMeetByLink(user.id, "meet.google.com/xyz-abcd-efg".replace(/^/, "https://"), "Diretoria");
    expect(r).toMatchObject({ ok: true, session: { status: "entrando", mode: "robo", title: "Diretoria" } });
    expect(await bot.joinMeetByLink(user.id, "https://meet.google.com/xyz-abcd-efg")).toMatchObject({ ok: false, status: 409 });
    const id = (r as any).session.id;
    // a tela e a ferramenta do WhatsApp cancelam do mesmo jeito
    const { meetingLeave } = await import("../src/agent/tools/meet.js");
    expect(await meetingLeave.run({}, { user: { id: user.id } } as any)).toMatchObject({ ok: true, title: "Diretoria" });
    expect(await db.one("SELECT status, error FROM meet_sessions WHERE id = $1", [id])).toMatchObject({ status: "erro", error: expect.stringMatching(/cancelou/) });
    // o robô que pega o job depois vê o cancelamento e nem abre o navegador
    await bot.runMeetBot(id);
  });
});

/** Robô entrando numa sala falsa no Chrome local: nome, "Pedir para participar", áudio do WebRTC vira trecho, sai quando a reunião acaba. */
describe.skipIf(!enabled || !process.env.CHROME_PATH)("Marlene entra sozinha pelo link (navegador)", () => {
  let db: typeof import("../src/db/pool.js");
  let server: import("node:http").Server;
  let base = "";
  const names: string[] = [];
  const ROOM = `<!doctype html><html lang="pt-BR"><body>
<input type="text" aria-label="Seu nome" id="nome">
<button id="entrar">Pedir para participar</button>
<div id="sala"></div>
<script>
document.getElementById("entrar").onclick = async () => {
  fetch("/nome?n=" + encodeURIComponent(document.getElementById("nome").value));
  document.getElementById("entrar").remove();
  // sala com áudio de outra pessoa chegando pelo WebRTC (dois peers na mesma página)
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); osc.frequency.value = 300;
  const d = ctx.createMediaStreamDestination(); osc.connect(d); osc.start();
  const a = new RTCPeerConnection(); const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  a.addTrack(d.stream.getAudioTracks()[0], d.stream);
  await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
  setTimeout(() => { document.getElementById("sala").innerHTML = '<button aria-label="Sair da chamada">sair</button>'; }, 800);
  setTimeout(() => { document.getElementById("sala").innerHTML = "A chamada foi encerrada pelo organizador"; }, 9000);
};
</script></body></html>`;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    const http = await import("node:http");
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/nome")) names.push(new URL(req.url, "http://x").searchParams.get("n") ?? "");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ROOM);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("entra com o nome dela, grava o que os outros falam e fecha a reunião quando ela acaba", async () => {
    const bot = await import("../src/meet-bot.js");
    const meet = await import("../src/meet.js");
    Object.assign(bot.BOT_TIMING, { segmentMs: 3000, pollMs: 1000, settleMs: 500 });
    const { upsertUser } = await import("../src/ingest.js");
    const u = await upsertUser("5519955557777", "Davi Queiroz");
    const s = await meet.startMeet(u.id, "Sala falsa", { url: `${base}/abc-defg-hij` });
    await bot.runMeetBot(s.id);
    const row = await db.one("SELECT status, error FROM meet_sessions WHERE id = $1", [s.id]);
    expect(row).toMatchObject({ status: "resumindo", error: null });
    expect(names).toEqual(["Marlene (anotações de Davi)"]);
    const chunks = await db.many("SELECT seq, length(audio) AS n FROM meet_chunks WHERE session_id = $1 ORDER BY seq", [s.id]);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(Number(chunks[0].n)).toBeGreaterThan(1000);
  }, 60_000);
});

