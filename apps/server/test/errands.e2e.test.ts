import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Recados: "acha o petshop, pergunta se tem 18h e, se tiver, marca" (Postgres real + OpenRouter falso).
 * Nada sai antes do "sim" da pessoa; a resposta do petshop não vira cliente; o agente fecha dentro do liberado e cria o lembrete.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const TZ = "America/Sao_Paulo";
const PET = "5519933334444";

let server: http.Server;
let seq = 0;
let tomorrow18 = "";
const checks: string[] = [];
const call = (name: string, args: unknown) => ({ id: `r${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
const completion = (content: string | null, tool_calls?: unknown[]) => ({
  model: "fake/model",
  choices: [{ message: { role: "assistant", content, tool_calls }, finish_reason: tool_calls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000001 },
});

function fakeOpenRouter(body: any) {
  const system: string = body.messages[0].content;
  const last = body.messages.at(-1);
  const userText = String(body.messages.findLast((m: any) => m.role === "user")?.content ?? "");
  // trava dos recados: recusa o que não é pedido de serviço
  if (system.includes("Você confere recados")) {
    checks.push(userText);
    return /signo|fofoca/.test(userText)
      ? completion('{"ok":false,"reason":"pergunta sem relação com o serviço","suggestion":"Pergunte sobre o serviço que ela quer, como preço ou horário."}')
      : completion('{"ok":true}');
  }
  // agente do recado, falando com o petshop
  if (system.includes("está conversando pelo WhatsApp com PetCamp")) {
    if (last.role === "tool") return completion("feito");
    if (userText.includes("PetCamp: Temos sim às 18h")) {
      return completion(null, [
        call("errand_reply", { message: "Perfeito, pode marcar o banho às 18h amanhã, por favor!" }),
        call("errand_done", { result: "Banho marcado na PetCamp amanhã às 18h", success: true, appointment_at: tomorrow18 }),
      ]);
    }
    if (userText.includes("PetCamp: Me xinga")) return completion(null, [call("errand_reply", { message: "Seus idiotas, respondam direito" })]);
    if (userText.includes("PetCamp: Só tenho às 19h")) return completion(null, [call("errand_ask_person", { question: "Eles só têm às 19h. Pode ser?" })]);
    return completion("aguardando");
  }
  if (system.includes("Você é o Recados")) {
    if (last.role === "tool") return completion("Guardado: mandar para a PetCamp e marcar se tiver 18h. Falta o sim.");
    return completion(null, [
      call("errand_start", {
        place: "PetCamp",
        phone: "(19) 93333-4444",
        message: "Vocês têm horário para banho amanhã às 18h?",
        goal: "Banho para o cachorro amanhã às 18h",
        allowed: "se tiver banho às 18h amanhã, confirmar",
        confirmed_by_user: true,
      }),
    ]);
  }
  if (system.includes("CTO de um time")) {
    if (userText.includes("[evento do sistema] Recado com PetCamp terminou")) return completion("Marcado! Banho amanhã às 18h na PetCamp 🐶");
    if (userText.includes("[evento do sistema] Recado com PetCamp: eles responderam")) return completion("A PetCamp só tem às 19h. Pode ser?");
    if (last.role === "tool") return completion("Posso mandar para a PetCamp perguntando e, se tiver 18h, já marco?");
    if (userText.includes("petshop")) return completion(null, [call("ask_recados", { message: "Achar petshop e pedir banho amanhã 18h; se tiver, marcar." })]);
    return completion("ok");
  }
  return completion("?");
}

describe.skipIf(!enabled)("recados com estabelecimentos (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let channels: typeof import("../src/channels/index.js");
  let mod: typeof import("../src/agent/orchestrator.js");
  let david: any;
  let conv: string;

  beforeAll(async () => {
    server = http
      .createServer((req, res) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(fakeOpenRouter(JSON.parse(b))));
        });
      })
      .listen(4599);
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    channels = await import("../src/channels/index.js");
    mod = await import("../src/agent/orchestrator.js");
    const { isoLocal } = await import("../src/time.js");
    tomorrow18 = `${isoLocal(new Date(Date.now() + 86_400_000), TZ).slice(0, 10)}T18:00`;
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    david = await upsertUser("5519911112222", "David");
    await db.query("UPDATE users SET status = 'active', timezone = $2 WHERE id = $1", [david.id, TZ]);
    conv = (await upsertConversation(david.id, "playground", "jid-david-recados")).id;
  });

  afterAll(async () => {
    server?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  const sentTexts = () => channels.playground.sent.filter((s) => s.type === "text").map((s) => s.text!);

  async function say(text: string) {
    await db.query("INSERT INTO messages (conversation_id, role, content, external_id, meta) VALUES ($1, 'user', $2, $3, $4)", [conv, text, `r${++seq}`, { kind: "text" }]);
    const channel = new channels.PlaygroundChannel();
    await mod.processConversation(conv, { trigger: "message", channel });
    return channel.sent.filter((s) => s.type === "text").map((s) => s.text!);
  }

  async function petshopSays(text: string) {
    const { ingest } = await import("../src/ingest.js");
    return ingest({ channel: "playground", remoteJid: `${PET}@s.whatsapp.net`, phone: PET, externalId: `pet${++seq}`, kind: "text", text, timestamp: new Date(), raw: {} });
  }

  it("só manda depois do sim, apresenta como assistente e o petshop não vira cliente", async () => {
    const before = sentTexts().length;
    const out = await say("acha o petshop mais perto e pergunta se tem banho amanhã às 18h; se tiver, marca pra mim");
    expect(out.join(" ")).toMatch(/Posso mandar/);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM errands")).toEqual({ n: 0 });
    expect(sentTexts().length).toBe(before); // nada foi para o petshop
    expect(await db.one("SELECT tool, status FROM pending_actions WHERE conversation_id = $1", [conv])).toMatchObject({ tool: "errand_start", status: "pending" });

    await say("sim");
    const e = await db.one("SELECT * FROM errands WHERE user_id = $1", [david.id]);
    expect(e).toMatchObject({ place: "PetCamp", phone: PET, status: "waiting", sent: 1, allowed: "se tiver banho às 18h amanhã, confirmar" });
    expect(sentTexts().find((t) => t.includes("banho amanhã às 18h"))).toMatch(/^Oi, (bom dia|boa tarde|boa noite)! Tudo bem\? Aqui é o assistente virtual de David\. Vocês têm/);
    // a trava conferiu a mensagem antes de pedir o sim (uma vez só; depois do sim não confere de novo)
    expect(checks.filter((c) => c.includes("Vocês têm horário para banho")).length).toBe(1);

    const r = await petshopSays("Temos sim às 18h, pode ser?");
    expect(r).toEqual({ queued: false, reason: "recado" });
    expect(await db.one("SELECT id FROM users WHERE phone = $1", [PET])).toBeUndefined();
    const log = (await db.one("SELECT log FROM errands WHERE id = $1", [e.id])).log;
    expect(log.at(-1)).toMatchObject({ from: "eles", text: "Temos sim às 18h, pode ser?" });
  });

  it("fecha dentro do liberado, cria o lembrete e conta para a pessoa", async () => {
    const e = await db.one("SELECT id FROM errands WHERE user_id = $1", [david.id]);
    const { runErrandTurn } = await import("../src/agent/errand-agent.js");
    const outcome = await runErrandTurn(e.id);
    expect(outcome?.kind).toBe("done");
    const after = await db.one("SELECT status, sent, outcome, appointment_at FROM errands WHERE id = $1", [e.id]);
    expect(after).toMatchObject({ status: "done", sent: 2, outcome: "Banho marcado na PetCamp amanhã às 18h" });
    expect(sentTexts()).toContain("Perfeito, pode marcar o banho às 18h amanhã, por favor!");
    // lembrete 1h antes do horário marcado
    const rem = await db.one("SELECT due_at, intent, title, event_at, tag, color FROM reminders WHERE user_id = $1", [david.id]);
    expect(new Date(after.appointment_at).getTime() - new Date(rem.due_at).getTime()).toBe(3600_000);
    // na agenda: bloco no horário do compromisso, com o nome do lugar e a tag do assunto
    expect(new Date(rem.event_at).getTime()).toBe(new Date(after.appointment_at).getTime());
    expect(rem).toMatchObject({ title: "PetCamp", tag: "Pet", color: "#e8710a" });
    expect(rem.intent).toMatch(/PetCamp/);
    expect(sentTexts().at(-1)).toMatch(/Resultado da conversa com PetCamp[\s\S]*Banho marcado[\s\S]*lembrete/);
    // recado fechado: nova mensagem do número volta a ser um contato desconhecido comum
    expect((await petshopSays("Obrigado!")).reason).not.toBe("recado");
    const exec = await db.one("SELECT status FROM executions WHERE trigger = 'errand' ORDER BY started_at DESC LIMIT 1");
    expect(exec.status).toBe("success");
  });

  it("fora do liberado pergunta à pessoa; e as travas valem no servidor", async () => {
    const { startErrand, sendToErrand, MAX_ERRAND_MESSAGES } = await import("../src/errands.js");
    const u = { id: david.id, phone: david.phone, name: "David" };
    const r: any = await startErrand({ user: u, conversationId: conv, place: "PetCamp", phone: PET, message: "Oi, tem banho amanhã às 18h?", goal: "banho amanhã 18h", allowed: "só 18h" });
    expect(r.ok).toBe(true);
    await petshopSays("Só tenho às 19h");
    const { runErrandTurn } = await import("../src/agent/errand-agent.js");
    expect((await runErrandTurn(r.errand_id))?.kind).toBe("ask");
    expect(await db.one("SELECT status, question FROM errands WHERE id = $1", [r.errand_id])).toEqual({ status: "asking", question: "Eles só têm às 19h. Pode ser?" });
    expect(sentTexts().at(-1)).toBe("A PetCamp só tem às 19h. Pode ser?");

    // a própria pessoa e quem usa o Planejai não viram recado
    expect(((await startErrand({ user: u, conversationId: conv, place: "Eu", phone: david.phone, message: "oi", goal: "x" })) as any).ok).toBe(false);
    // limite de mensagens para o estabelecimento
    await db.query("UPDATE errands SET sent = $2 WHERE id = $1", [r.errand_id, MAX_ERRAND_MESSAGES]);
    expect(((await sendToErrand(r.errand_id, "mais uma")) as any).ok).toBe(false);
    // vence sem resposta: avisa a pessoa uma vez, sem IA
    await db.query("UPDATE errands SET expires_at = now() - interval '1 minute' WHERE id = $1", [r.errand_id]);
    const { expireErrands } = await import("../src/errands.js");
    expect(await expireErrands()).toBe(1);
    expect(sentTexts().at(-1)).toMatch(/PetCamp/);
  });

  it("trava: mensagem abusiva ou nada a ver não sai nem vira pedido de sim", async () => {
    const { errandStart, errandContinue } = await import("../src/agent/tools/errands.js");
    const { Tracer } = await import("../src/agent/trace.js");
    const tracer = await Tracer.start({ trigger: "message", userId: david.id, conversationId: conv });
    const ctxFor = (name: string, args: any) => ({ user: david, conversation: { id: conv }, tracer, timezone: TZ, agent: "recados", toolCall: { name, args } }) as any;
    const start = (message: string) => {
      const args = { place: "PetCamp", phone: PET, message, goal: "Saber o valor da tosa do shih-tzu" };
      return errandStart.run(args, ctxFor("errand_start", args)) as Promise<any>;
    };
    const before = sentTexts().length;
    await db.query("DELETE FROM pending_actions");

    // palavrão: o filtro sem IA segura
    const rude = await start("Seus idiotas, quanto custa a tosa?");
    expect(rude).toMatchObject({ ok: false, blocked: true });
    expect(rude.error).toMatch(/NÃO enviada.*Sugestão/);
    // nada a ver com o serviço: a trava com IA segura e sugere um jeito melhor
    const odd = await start("Qual o signo do dono do petshop?");
    expect(odd).toMatchObject({ ok: false, blocked: true });
    expect(odd.error).toMatch(/sem relação com o serviço.*Pergunte sobre o serviço/);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM pending_actions")).toEqual({ n: 0 });
    // a trava aparece em Execuções
    expect((await db.one("SELECT COUNT(*)::int AS n FROM execution_steps WHERE execution_id = $1 AND name = 'trava: recado'", [tracer.executionId])).n).toBe(2);

    // pergunta boa: vira pedido de sim e a tela mostra exatamente o que vai sair
    const good = await start("Ela tem um shih-tzu e queria saber sobre tosa com vocês. Conseguem me passar o valor?");
    expect(good.needs_confirmation).toBe(true);
    const { listErrands, discardErrandDraft, startErrand, cancelErrand } = await import("../src/errands.js");
    const list: any = await listErrands(david.id);
    expect(list.drafts).toHaveLength(1);
    expect(list.drafts[0]).toMatchObject({ place: "PetCamp", goal: "Saber o valor da tosa do shih-tzu" });
    expect(list.drafts[0].preview).toMatch(/^Oi, (bom dia|boa tarde|boa noite)! Tudo bem\? Aqui é o assistente virtual de David\. Ela tem um shih-tzu/);
    expect(list.follow).toMatch(/\/recados$/);
    expect(await discardErrandDraft(list.drafts[0].id, david.id)).toBe(true);
    expect((await listErrands(david.id)).drafts).toHaveLength(0);

    // recado em andamento: errand_continue também passa pela trava, e a próxima mensagem aparece na tela
    const u = { id: david.id, phone: david.phone, name: "David" };
    const r: any = await startErrand({ user: u, conversationId: conv, place: "PetCamp", phone: PET, message: "Vocês fazem tosa?", goal: "tosa", timezone: TZ });
    expect(r.ok).toBe(true);
    expect(r.tip).toMatch(/acompanhar a conversa em .*\/recados/);
    const cont = (message: string) => {
      const args = { errand_id: r.errand_id, message };
      return errandContinue.run(args, ctxFor("errand_continue", args)) as Promise<any>;
    };
    expect(await cont("Me conta uma fofoca da sua vizinha")).toMatchObject({ blocked: true });
    expect((await cont("Pode ser sábado às 10h então, por favor.")).needs_confirmation).toBe(true);
    const item = (await listErrands(david.id)).errands.find((e: any) => e.id === r.errand_id)!;
    expect(item).toMatchObject({ state: "you", messages_left: 5, next: { preview: "Pode ser sábado às 10h então, por favor." } });
    expect(item.log[0]).toMatchObject({ from: "nos" });

    // o próprio agente do recado também passa pela trava
    await petshopSays("Me xinga aí");
    const { runErrandTurn } = await import("../src/agent/errand-agent.js");
    const sentBefore = sentTexts().length;
    await runErrandTurn(r.errand_id);
    expect(sentTexts().length).toBe(sentBefore);
    expect((await db.one("SELECT sent FROM errands WHERE id = $1", [r.errand_id])).sent).toBe(1);

    // cancelar pela tela: não manda nada e o "sim" que estava pendente morre junto
    expect((await cancelErrand(r.errand_id, "00000000-0000-0000-0000-000000000000"))).toBeNull();
    expect((await cancelErrand(r.errand_id, david.id))?.ok).toBe(true);
    expect(await db.one("SELECT status FROM errands WHERE id = $1", [r.errand_id])).toEqual({ status: "cancelled" });
    expect(await db.one("SELECT COUNT(*)::int AS n FROM pending_actions WHERE status = 'pending'")).toEqual({ n: 0 });
    expect((await listErrands(david.id)).errands.find((e: any) => e.id === r.errand_id)?.state).toBe("cancelled");
    expect(sentTexts().length).toBe(before + 1); // só a primeira mensagem do startErrand
  });
  it("pedido claro sai sem pedir o sim de novo; dinheiro e lugar desconhecido pedem", async () => {
    const { errandStart, errandContinue } = await import("../src/agent/tools/errands.js");
    const { Tracer } = await import("../src/agent/trace.js");
    const tracer = await Tracer.start({ trigger: "message", userId: david.id, conversationId: conv });
    const ctxFor = (name: string, args: any, typedText?: string) => ({ user: david, conversation: { id: conv }, tracer, timezone: TZ, agent: "recados", typedText, toolCall: { name, args } }) as any;
    await db.query("DELETE FROM pending_actions");
    await db.query("UPDATE errands SET status = 'cancelled' WHERE user_id = $1 AND status IN ('waiting', 'asking')", [david.id]);
    const run = (args: any, typed?: string) => errandStart.run(args, ctxFor("errand_start", args, typed)) as Promise<any>;
    const base = { place: "PetCamp", phone: PET, message: "Vocês têm horário para tosa amanhã?", goal: "tosa amanhã" };
    // valor/pagamento: sempre pede o sim, mesmo com o lugar citado
    const risky = await run({ ...base, message: "Posso pagar o sinal por pix?" }, "pergunta pro PetCamp da tosa, pode pagar o sinal"); expect(risky.needs_confirmation).toBe(true);
    // a pessoa citou o lugar: sai direto
    await db.query("DELETE FROM pending_actions");
    const sent = await run(base, "pergunta pro PetCamp se tem tosa amanhã");
    expect(sent.ok).toBe(true);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM pending_actions WHERE status = 'pending'")).toEqual({ n: 0 });
    // a decisão que ela acabou de dar não pede o sim duplo
    await db.query("UPDATE errands SET status = 'asking', question = 'Pode ser 19h?' WHERE id = $1", [sent.errand_id]);
    const args = { errand_id: sent.errand_id, message: "Pode ser às 19h, por favor" };
    const before = sentTexts().length;
    expect((await errandContinue.run(args, ctxFor("errand_continue", args, "pode sim"))) as any).toMatchObject({ ok: true });
    expect(sentTexts().length).toBe(before + 1);
    // rodada sem a pessoa (evento do sistema) nunca dispensa o sim
    await db.query("UPDATE errands SET status = 'asking' WHERE id = $1", [sent.errand_id]);
    const again = { errand_id: sent.errand_id, message: "Então fica confirmado para as 19h, combinado" };
    expect(((await errandContinue.run(again, { ...ctxFor("errand_continue", again, "pode sim"), proactive: true })) as any).needs_confirmation).toBe(true);
  });

  it("dois clientes falam com o mesmo estabelecimento ao mesmo tempo e a resposta vai para o certo", async () => {
    const { startErrand, routeErrand } = await import("../src/errands.js");
    await db.query("UPDATE errands SET status = 'cancelled' WHERE status IN ('waiting', 'asking')");
    const other = await db.one("INSERT INTO users (phone, name, status) VALUES ('5519988880001', 'Ana', 'active') RETURNING id, phone");
    const a: any = await startErrand({ user: { id: david.id, phone: david.phone, name: "David" }, conversationId: conv, place: "PetCamp", phone: PET, message: "Tem banho amanhã?", goal: "banho" });
    const b: any = await startErrand({ user: { id: other.id, phone: other.phone, name: "Ana" }, conversationId: conv, place: "PetCamp", phone: PET, message: "Tem tosa sexta?", goal: "tosa" });
    expect(a.ok && b.ok).toBe(true);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM errands WHERE status = 'waiting' AND phone = $1", [PET])).toEqual({ n: 2 });
    const open = (await db.query("SELECT * FROM errands WHERE status = 'waiting' AND phone = $1", [PET])).rows;
    const ea = open.find((e: any) => e.id === a.errand_id), eb = open.find((e: any) => e.id === b.errand_id);
    ea.log = [{ from: "nos", text: "x", at: "2026-10-20T10:00:00Z", external_id: "AAA" }];
    eb.log = [{ from: "nos", text: "y", at: "2026-10-20T10:05:00Z", external_id: "BBB" }];
    expect(routeErrand([ea, eb], "AAA")?.id).toBe(ea.id); // citou a mensagem do primeiro
    expect(routeErrand([ea, eb])?.id).toBe(eb.id); // sem citar: quem perguntou por último
    expect(routeErrand([ea])?.id).toBe(ea.id);
  });

  it("a pessoa responde pelo painel: sai com o nome dela, entra no recado e só em conversa que já existe", async () => {
    const { startErrand, cancelErrand, listErrands } = await import("../src/errands.js");
    const { replyFromPanel } = await import("../src/panelreply.js");
    const { listContactChats } = await import("../src/direct.js");
    const { errandMessages } = await import("../src/agent/errand-agent.js");
    const OFICINA = "5519955556666";
    const u = { id: david.id, phone: david.phone, name: "David" };
    const r: any = await startErrand({ user: u, conversationId: conv, place: "Oficina", phone: OFICINA, message: "Vocês consertam câmbio?", goal: "câmbio", timezone: TZ });
    expect(r.ok).toBe(true);

    // número que o assistente nunca falou: o painel não vira WhatsApp para qualquer um
    expect(await replyFromPanel(david.id, "5519900001111", "oi")).toMatchObject({ ok: false });
    expect(await replyFromPanel(david.id, OFICINA, "   ")).toMatchObject({ ok: false });

    // recado aberto: sai pelo nosso número com o nome dela e entra no histórico do recado, sem gastar o limite do agente
    expect(await replyFromPanel(david.id, OFICINA, "Pode ser amanhã às 15h?")).toEqual({ ok: true });
    expect(sentTexts().at(-1)).toBe("*David:* Pode ser amanhã às 15h?");
    const e = await db.one("SELECT sent, log FROM errands WHERE id = $1", [r.errand_id]);
    expect(e.sent).toBe(1);
    expect(e.log.at(-1)).toMatchObject({ from: "voce", text: "Pode ser amanhã às 15h?" });
    expect(errandMessages(e.log, "Oficina", "David")[0]!.content).toMatch(/David \(escreveu direto, não foi você\): Pode ser amanhã às 15h\?/);

    // recado fechado: continua como mensagem avulsa dela (a resposta volta) e aparece como dela na tela
    await cancelErrand(r.errand_id, david.id);
    expect((await replyFromPanel(david.id, OFICINA, "Obrigado!")).ok).toBe(true);
    expect(sentTexts().at(-1)).toBe("*David:* Obrigado!");
    const chat = (await listContactChats(david.id)).find((c) => c.phone === OFICINA)!;
    expect(chat.log.at(-1)).toMatchObject({ from: "voce", text: "Obrigado!" });
    expect(chat.name).toBe("Oficina");
    expect((await listErrands(david.id)).errands.find((x: any) => x.id === r.errand_id)?.log.at(-1)).toMatchObject({ from: "voce" });
  });
  it("ficha da conversa: guarda itens, limpa, atualiza o mesmo rótulo e chega ao agente", async () => {
    const { savePrefs, addFact, getPrefs, styleHint, notedHint, MAX_FACTS } = await import("../src/chatprefs.js");
    const FICHA = "5519977778888";
    await savePrefs(david.id, FICHA, { facts: [{ label: " Quero ", value: "tosa baixinha" }, { label: "", value: "sem rótulo" }, { label: "Valor", value: "" }] });
    expect((await getPrefs(david.id, FICHA))?.facts).toEqual([{ label: "Quero", value: "tosa baixinha" }]);
    await addFact(david.id, FICHA, "Valor", "R$ 95,00");
    await addFact(david.id, FICHA, "valor", "R$ 90,00");
    const p = await getPrefs(david.id, FICHA);
    expect(p?.facts).toEqual([{ label: "Quero", value: "tosa baixinha" }, { label: "valor", value: "R$ 90,00", by: "agente" }]);
    // o que o agente anotou do estabelecimento é informação, nunca "o que ela aceita"
    expect(styleHint(p)).toMatch(/ficha da conversa.*Quero: tosa baixinha/);
    expect(styleHint(p)).not.toMatch(/R\$ 90/);
    expect(notedHint(p)).toBe("valor: R$ 90,00");
    // e o agente não troca o que a pessoa escreveu
    expect((await addFact(david.id, FICHA, "quero", "tosa e banho com sinal no Pix")).ok).toBe(false);
    expect((await getPrefs(david.id, FICHA))?.facts?.[0]).toEqual({ label: "Quero", value: "tosa baixinha" });
    // mexer em outra coisa não apaga a ficha
    await savePrefs(david.id, FICHA, { nickname: "Pet" });
    expect((await getPrefs(david.id, FICHA))?.facts).toHaveLength(2);
    await savePrefs(david.id, FICHA, { facts: Array.from({ length: 30 }, (_, i) => ({ label: `item${i}`, value: "x" })) });
    expect((await getPrefs(david.id, FICHA))?.facts).toHaveLength(MAX_FACTS);
  });
});
