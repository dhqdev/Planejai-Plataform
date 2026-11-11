import { describe, expect, it } from "vitest";
import { splitBubbles, toWhatsApp } from "../src/agent/orchestrator.js";
import { isAckOnly } from "../src/agent/reaction.js";
import { CloudChannel } from "../src/channels/cloud.js";
import { EvolutionChannel } from "../src/channels/evolution.js";
import { parseWAMessage } from "../src/channels/wa-message.js";
import { decryptJson, encryptJson, signSession, verifySession } from "../src/crypto.js";
import { nextCronDate } from "../src/reminders.js";
import { isoLocal, parseLocalDateTime } from "../src/time.js";
import { phoneVariants } from "../src/ingest.js";

describe("formatação para WhatsApp", () => {
  it("converte markdown para o estilo do WhatsApp", () => {
    expect(toWhatsApp("**Kinoplex** e [ingresso](https://ingresso.com)\n- 14h30\n### Sessões")).toBe(
      "*Kinoplex* e ingresso: https://ingresso.com\n• 14h30\n\n*Sessões*",
    );
  });

  it("organiza em blocos: título com espaço antes, lista junta, sub-item recuado e textão quebrado", () => {
    expect(
      toWhatsApp("Opa, achei 🍿\n🎬 *Hoje*\n\n- Kinoplex 19h\n\n- Cinemark 20h\n  - legendado\nQualquer coisa me chama\n\n\n\n🗓️ *Amanhã*\n• Nada"),
    ).toBe("Opa, achei 🍿\n\n🎬 *Hoje*\n• Kinoplex 19h\n• Cinemark 20h\n   ◦ legendado\n\nQualquer coisa me chama\n\n🗓️ *Amanhã*\n• Nada");
    const wall =
      "O Dr. Paulo atende na R. Augusta, 120, e a consulta custa R$ 1.250,00. Ele tem horário na terça às 14h e na quinta às 9h. Precisa levar o pedido médico e a carteirinha do convênio. Se quiser, já deixo um lembrete para o dia anterior!";
    expect(toWhatsApp(wall)).toBe(
      "O Dr. Paulo atende na R. Augusta, 120, e a consulta custa R$ 1.250,00. Ele tem horário na terça às 14h e na quinta às 9h.\n\nPrecisa levar o pedido médico e a carteirinha do convênio. Se quiser, já deixo um lembrete para o dia anterior!",
    );
    // resposta curta não muda
    expect(toWhatsApp("Anotado! Gastei 30 no mercado.")).toBe("Anotado! Gastei 30 no mercado.");
  });

  it("reconhece mensagem que só agradece ou confirma (sem chamar a IA)", () => {
    expect(isAckOnly(["valeu!"], false)).toBe(true);
    expect(isAckOnly(["kkkkk", "👍"], false)).toBe(true);
    expect(isAckOnly(["Obrigado amigo 🙏"], true)).toBe(true);
    expect(isAckOnly(["ok"], false)).toBe(true);
    expect(isAckOnly(["sim"], true)).toBe(false);
    expect(isAckOnly(["valeu, e o cinema amanhã?"], false)).toBe(false);
    expect(isAckOnly([""], false)).toBe(false);
  });

  it("lista vira •, travessão vira vírgula e figurinha solta some", () => {
    expect(toWhatsApp("Opções:\n- Kinoplex — 14h30\n• Cinemark - das 16 - 18h\n* Pipoca\n1. Refri")).toBe(
      "Opções:\n• Kinoplex, 14h30\n• Cinemark, das 16 a 18h\n• Pipoca\n1. Refri",
    );
    expect(toWhatsApp("🗓️ *Amanhã*\n🍿 Cinema às 19h [[figurinha:feliz]]")).toBe("🗓️ *Amanhã*\n🍿 Cinema às 19h");
    // calendário com dia fixo (📅 mostra "17" no WhatsApp) vira o calendário sem número
    expect(toWhatsApp("📅 *Amanhã* e 📆 hoje")).toBe("🗓️ *Amanhã* e 🗓️ hoje");
    expect(toWhatsApp("Fica uns R$ 50 – com pipoca 🍿")).toBe("Fica uns R$ 50, com pipoca 🍿");
    expect(toWhatsApp("Guarda-chuva e -5 graus")).toBe("Guarda-chuva e -5 graus");
  });

  it("divide balões com --- e posiciona mídias", () => {
    expect(splitBubbles("Sessões de sábado:\n• 14h30\n[[media:m1]]\n---\nQual horário você prefere?")).toEqual([
      { type: "text", text: "Sessões de sábado:\n• 14h30" },
      { type: "media", id: "m1" },
      { type: "text", text: "Qual horário você prefere?" },
    ]);
  });
});

describe("datas no fuso da pessoa", () => {
  it("interpreta horário local de São Paulo (UTC-3)", () => {
    expect(parseLocalDateTime("2026-10-10T14:30", "America/Sao_Paulo").toISOString()).toBe("2026-10-10T17:30:00.000Z");
  });
  it("respeita offset explícito", () => {
    expect(parseLocalDateTime("2026-10-10T14:30:00Z", "America/Sao_Paulo").toISOString()).toBe("2026-10-10T14:30:00.000Z");
  });
  it("formata ISO local", () => {
    expect(isoLocal(new Date("2026-10-06T17:45:00Z"), "America/Sao_Paulo")).toBe("2026-10-06T14:45");
  });
  it("calcula a próxima ocorrência de cron no fuso", () => {
    const next = nextCronDate("0 8 * * *", "America/Sao_Paulo", new Date("2026-10-06T12:00:00Z"));
    expect(next.toISOString()).toBe("2026-10-07T11:00:00.000Z");
  });
});

describe("lembrete recorrente com limite", () => {
  it("recusa cron a cada minuto ou a cada 5 min e aceita uma vez por dia", async () => {
    const { cronTooFrequent } = await import("../src/cron-limits.js");
    expect(cronTooFrequent("* * * * *", 15)).not.toBeNull();
    expect(cronTooFrequent("*/5 * * * *", 15)).not.toBeNull();
    expect(cronTooFrequent("0 8 * * *", 15)).toBeNull();
    expect(cronTooFrequent("0,30 9 * * 1-5", 15)).toBeNull();
  });
});

describe("e-mail pelo Gmail", () => {
  it("recusa quebra de linha no cabeçalho e mostra o começo do texto no pedido de sim", async () => {
    const { gmailSend } = await import("../src/agent/tools/communication.js");
    expect(await gmailSend.run({ to: "ana@x.com\r\nBcc: espiao@y.com", subject: "Oi", body: "Tudo bem?" }, {} as any)).toMatchObject({ ok: false });
    expect(await gmailSend.run({ to: "não é email", subject: "Oi", body: "Tudo bem?" }, {} as any)).toMatchObject({ ok: false });
    const ask: any = await gmailSend.run({ to: "ana@x.com", subject: "Reunião", body: "Oi Ana, podemos mudar a reunião para sexta às 10h?" }, {} as any);
    expect(ask.needs_confirmation).toBe(true);
    expect(ask.message).toContain("Oi Ana, podemos mudar a reunião");
  });
});

describe("webhooks", () => {
  it("lê mensagem da Evolution, inclusive conta com LID", () => {
    const [m] = new EvolutionChannel().parseWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "123@lid", remoteJidAlt: "5519999999999@s.whatsapp.net", fromMe: false, id: "ABC" },
        pushName: "David",
        message: { extendedTextMessage: { text: "oi", contextInfo: { stanzaId: "Q1", quotedMessage: { conversation: "antes" } } } },
        messageTimestamp: 1791310000,
      },
    });
    expect(m).toMatchObject({ phone: "5519999999999", externalId: "ABC", kind: "text", text: "oi", quoted: { id: "Q1", text: "antes" } });
  });

  it("ignora grupos e mensagens próprias na Evolution", () => {
    const ch = new EvolutionChannel();
    expect(ch.parseWebhook({ event: "messages.upsert", data: { key: { remoteJid: "1@g.us", id: "x" }, message: { conversation: "a" } } })).toEqual([]);
    expect(ch.parseWebhook({ event: "messages.upsert", data: { key: { remoteJid: "1@s.whatsapp.net", fromMe: true, id: "x" }, message: { conversation: "a" } } })).toEqual([]);
  });

  it("lê áudio e reação da Cloud API", () => {
    const msgs = new CloudChannel().parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "5519999999999", profile: { name: "David" } }],
                messages: [
                  { from: "5519999999999", id: "w1", type: "audio", audio: { id: "media1", mime_type: "audio/ogg" }, timestamp: "1791310000" },
                  { from: "5519999999999", id: "w2", type: "reaction", reaction: { message_id: "out1", emoji: "❤️" } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(msgs[0]).toMatchObject({ kind: "audio", pushName: "David", media: { providerId: "media1" } });
    expect(msgs[1]).toMatchObject({ kind: "reaction", text: "❤️", reactionTo: "out1" });
  });
});

describe("cripto", () => {
  it("criptografa e decripta credenciais", () => {
    const enc = encryptJson({ token: "segredo" });
    expect(enc).not.toContain("segredo");
    expect(decryptJson(enc)).toEqual({ token: "segredo" });
  });
  it("rejeita sessão adulterada ou expirada", () => {
    const t = signSession({ sub: "a", exp: Date.now() + 1000 });
    expect(verifySession(t)?.sub).toBe("a");
    expect(verifySession(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(verifySession(signSession({ sub: "a", exp: Date.now() - 1 }))).toBeNull();
  });
});

describe("telefones", () => {
  it("considera o nono dígito dos celulares do Brasil", () => {
    expect(phoneVariants("5519995378302")).toEqual(["5519995378302", "551995378302"]);
    expect(phoneVariants("551995378302")).toEqual(["5519995378302", "551995378302"]);
    expect(phoneVariants("16504682892")).toEqual(["16504682892"]);
  });
});

describe("mensagens do Baileys", () => {
  it("desembrulha mensagens temporárias e ignora mensagens de protocolo", () => {
    const eph = parseWAMessage(
      { key: { remoteJid: "5519999999999@s.whatsapp.net", id: "E1" }, message: { ephemeralMessage: { message: { conversation: "oi sumido" } } }, messageTimestamp: { toNumber: () => 1791310000 } },
      "baileys",
    );
    expect(eph).toMatchObject({ channel: "baileys", text: "oi sumido", kind: "text", timestamp: new Date(1791310000 * 1000) });
    expect(parseWAMessage({ key: { remoteJid: "5519999999999@s.whatsapp.net", id: "P1" }, message: { protocolMessage: { type: 0 } } }, "baileys")).toBeNull();
  });
});

describe("finanças: valores e contas exatas", () => {
  it("entende valores em reais em vários formatos", async () => {
    const { parseAmount } = await import("../src/agent/tools/finance.js");
    expect(parseAmount("R$ 1.234,56")).toBe(1234.56);
    expect(parseAmount("8,20")).toBe(8.2);
    expect(parseAmount("1,234.50")).toBe(1234.5);
    expect(parseAmount("1.500")).toBe(1500);
    expect(parseAmount(19.999)).toBe(20);
    expect(parseAmount(-35)).toBe(35);
    expect(() => parseAmount("abc")).toThrow();
  });

  it("calculadora sem eval, com vírgula, porcentagem e potência", async () => {
    const { calc } = await import("../src/agent/tools/finance.js");
    expect(calc("(89,90 + 45,50) / 3")).toBeCloseTo(45.1333, 3);
    expect(calc("1200 * 12%")).toBe(144);
    expect(calc("2 x 3 + 1")).toBe(7);
    expect(calc("1000 * (1 + 1%)^12")).toBeCloseTo(1126.83, 2);
    expect(() => calc("process.exit()")).toThrow();
    expect(() => calc("1/0")).toThrow();
  });

  it("parcelas não perdem centavo", async () => {
    const { splitInstallments } = await import("../src/agent/tools/finance.js");
    expect(splitInstallments(100, 3)).toEqual([33.34, 33.33, 33.33]);
    expect(splitInstallments(10, 4)).toEqual([2.5, 2.5, 2.5, 2.5]);
    const p = splitInstallments(1999.99, 12);
    expect(Math.round(p.reduce((a, b) => a + b, 0) * 100)).toBe(199999);
  });
});

describe("documentos", () => {
  it("lê CSV, HTML e PDF localmente", async () => {
    const { extractDocumentText, documentKind } = await import("../src/agent/media.js");
    expect(documentKind("application/octet-stream", "fatura.pdf")).toBe("pdf");
    expect(documentKind("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx")).toBe("docx");
    expect((await extractDocumentText(Buffer.from("a,b\n1,2"), "text/csv", "x.csv")).text).toBe("a,b\n1,2");
    expect((await extractDocumentText(Buffer.from("<p>Olá <b>mundo</b></p><script>x()</script>"), "text/html", "x.html")).text).toBe("Olá mundo");
    const pdf = await extractDocumentText(minimalPdf("Total a pagar R$ 123,45"), "application/pdf", "boleto.pdf");
    expect(pdf.pages).toBe(1);
    expect(pdf.text).toContain("Total a pagar R$ 123,45");
  });
});

/** PDF mínimo válido com uma linha de texto (para testar a extração sem arquivo binário no repo). */
function minimalPdf(text: string) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, "latin1"));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

describe("reação instantânea pelo tema", () => {
  it("escolhe o emoji do assunto sem IA", async () => {
    const { pickReaction } = await import("../src/agent/reaction.js");
    expect(pickReaction("tem sessão de cinema hoje?")).toBe("🍿");
    expect(pickReaction("Gastei 8,20 na padaria")).toBe("💸");
    expect(pickReaction("qual o melhor celular até 2 mil?")).toBe("📱");
    expect(pickReaction("valeu!")).toBe("🙏");
    expect(pickReaction("quero viajar pra praia em dezembro")).toBe("✈️");
    expect(pickReaction("que barato esse golpe")).not.toBe("🍻");
    expect(pickReaction("", "audio")).toBe("🎧");
    expect(pickReaction("e isso aqui?")).toBe("👀");
  });
});


describe("imagens simples (make_image)", () => {
  it("monta mapa mental, passos e tabela escapando HTML", async () => {
    const { buildImageHtml } = await import("../src/images.js");
    const m = buildImageHtml({ kind: "mapa_mental", title: "Livro <x>", sections: [{ title: "Ideia 1", items: ["a"] }, { title: "Ideia 2" }, { title: "Ideia 3" }] });
    expect(m.width).toBe(1600);
    expect(m.html).toContain("Livro &lt;x&gt;");
    expect(m.html.match(/class="br"/g)).toHaveLength(3);
    const t = buildImageHtml({ kind: "tabela", title: "T", columns: ["A", "B"], rows: [["1", "2"]] });
    expect(t.html).toContain("<th>A</th>");
    expect(buildImageHtml({ kind: "passos", title: "P", sections: [{ title: "um" }] }).html).toContain('class="n">1<');
  });
});

describe("chamada escrita como texto", () => {
  it("vira tool call de verdade e o texto cru some", async () => {
    const { textToolCalls } = await import("../src/agent/runner.js");
    const known = new Set(["make_pdf"]);
    const ok = textToolCalls('Já faço!<tool_call>{"name":"make_pdf","arguments":{"title":"Pai Rico","sections":[{"heading":"Lição 1","text":"a"}]}}</tool_call>', known);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]!.function.name).toBe("make_pdf");
    expect(JSON.parse(ok.calls[0]!.function.arguments).title).toBe("Pai Rico");
    expect(ok.rest).toBe("Já faço!");
    const cut = textToolCalls('<tool_call>{"name":"make_pdf","arguments":{"title":"Pai Rico","sections":[{"heading":"Quem', known);
    expect(cut).toMatchObject({ calls: [], rest: "", broken: true });
    expect(textToolCalls('<tool_call>{"name":"apagar_tudo","arguments":{}}</tool_call>', known)).toMatchObject({ calls: [], broken: true });
    expect(textToolCalls("oi, tudo bem?", known)).toEqual({ calls: [], rest: "oi, tudo bem?", broken: false });
  });

  it("DSML do DeepSeek vira chamada de verdade e nunca chega à pessoa", async () => {
    const { textToolCalls } = await import("../src/agent/runner.js");
    const known = new Set(["schedule_reminder"]);
    const dsml =
      'Já marco!\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="schedule_reminder">\n' +
      '<｜DSML｜parameter name="in_minutes" string="false">1</｜DSML｜parameter>\n' +
      '<｜DSML｜parameter name="intent" string="true">Teste de lembrete 🔔</｜DSML｜parameter>\n' +
      "</｜DSML｜invoke>\n</｜DSML｜function_calls>";
    const ok = textToolCalls(dsml, known);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]!.function.name).toBe("schedule_reminder");
    expect(JSON.parse(ok.calls[0]!.function.arguments)).toEqual({ in_minutes: 1, intent: "Teste de lembrete 🔔" });
    expect(ok.rest).toBe("Já marco!");
    expect(ok.broken).toBe(false);
    // como chegou no WhatsApp: barras dobradas e com espaço, "calls" em vez de "function_calls", ferramenta que não existe
    const print =
      '< | | DSML | | calls>\n< | | DSML | | invoke name="set_alarm">\n< | | DSML | | parameter name="in_minutes" string="false">1</ | | DSML | | parameter>\n' +
      '< | | DSML | | parameter name="label" string="true">Teste de alarme 🔔</ | | DSML | | parameter>\n</ | | DSML | | invoke>\n</ | | DSML | | calls>';
    const bad = textToolCalls(print, known);
    expect(bad).toMatchObject({ calls: [], rest: "", broken: true });
    const cut = textToolCalls('Vou ver<｜DSML｜function_calls><｜DSML｜invoke name="schedule_reminder"><｜DSML｜parameter name="intent" string="true">ab', known);
    expect(cut).toMatchObject({ calls: [], rest: "Vou ver", broken: true });
    expect(textToolCalls("Pronto<｜tool▁calls▁end｜>", known)).toMatchObject({ rest: "Pronto", broken: true });
  });
});

describe("PDF de várias páginas (make_pdf)", () => {
  it("monta capa, sumário e seções escapando HTML", async () => {
    const { buildPdfHtml, pdfFileName } = await import("../src/pdf.js");
    const secs = ["Um", "Dois", "Três", "Quatro"].map((t) => ({ title: t, text: "Primeiro <b>.\n\nSegundo **forte**." }));
    const html = buildPdfHtml({ title: "Plano <x>", sections: [...secs, { title: "Tabela", table: { columns: ["A", "B"], rows: [["1", "2"]] }, highlight: "dica" }] });
    expect(html).toContain("Plano &lt;x&gt;");
    expect(html).toContain("Sumário");
    expect(html.match(/<section/g)).toHaveLength(5);
    expect(html).toContain("<p>Segundo <strong>forte</strong>.</p>");
    expect(html).toContain("Primeiro &lt;b&gt;.");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain('class="hl"');
    expect(buildPdfHtml({ title: "Curto", sections: [{ title: "Só", text: "x" }] })).not.toContain("Sumário");
    expect(buildPdfHtml({ title: "H", sections: [{ heading: "Com heading", text: "x" } as never] })).toContain("Com heading");
    const { normalizePdfSpec } = await import("../src/pdf.js");
    // sections como texto JSON, heading/content, parágrafos em lista e seção solta
    const n = normalizePdfSpec({ title: "Pai Rico", sections: JSON.stringify([{ heading: "Lição 1", content: ["um", "dois"] }, "texto solto"]) });
    expect(n.sections).toEqual([
      { title: "Lição 1", text: "um\n\ndois", items: undefined, table: undefined, highlight: undefined },
      { title: "Parte 2", text: "texto solto" },
    ]);
    expect(normalizePdfSpec('{"title":"T","content":"só texto"}').sections[0]).toEqual({ title: "T", text: "só texto" });
    expect(pdfFileName('Relatório: "maio"/2026')).toBe("Relatório maio 2026.pdf");
  });
});

describe("compactOldToolResults", () => {
  it("encurta resultados já lidos e mantém o lote atual inteiro", async () => {
    const { compactOldToolResults } = await import("../src/agent/runner.js");
    const big = "x".repeat(9000);
    const msgs: any[] = [
      { role: "system", content: "s" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "1", content: big },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "2", content: big },
    ];
    compactOldToolResults(msgs);
    expect(msgs[2].content.length).toBeLessThan(3100);
    expect(msgs[2].content).toContain("encurtado");
    expect(msgs[4].content).toBe(big);
  });
});

describe("trava: dizer que fez sem ter feito", () => {
  it("especialista sob medida: registrado vale com o caderno, não com o quadro do time", async () => {
    const { unbackedClaim } = await import("../src/agent/claims.js");
    // 03/11: diárias do Rico "registradas" pelo Ponto só no quadro do time (que some) viraram "nada foi feito"
    const said = "Tudo registrado no controle de ponto ✅\n\n💰 *Diárias*\n• Cláudio: *R$ 250*\n• João: *R$ 200*";
    expect(unbackedClaim(said, new Set(["ask_c_ponto", "share_with_team"]))).toBe("lançar gasto ou receita");
    expect(unbackedClaim(said, new Set(["ask_c_ponto", "share_with_team", "notebook_save"]))).toBeNull();
    expect(unbackedClaim("Salvei a presença de hoje ✅", new Set(["notebook_save"]))).toBeNull();
  });
  it("salvar contato pelo chat: o salvei vale com contact_save e o pedido cobra o salvamento", async () => {
    const { unbackedClaim, unmetRequest } = await import("../src/agent/claims.js");
    // 14/10: "19 99672-6445 guarde esse contato como marcos" salvou e mesmo assim caiu em "nada foi feito"
    expect(unbackedClaim("Salvei o Marcos nos seus contatos ✅", new Set(["contact_save"]))).toBeNull();
    expect(unbackedClaim("Salvei o Marcos nos seus contatos ✅", new Set())).toBe("guardar documento ou nota");
    const asked = "19 99672-6445 guarde esse contato como marcos";
    expect(unmetRequest(asked, "Pode deixar 👍", new Set())).toBe("salvar contato");
    expect(unmetRequest(asked, "Salvei ✅", new Set(["contact_save"]))).toBeNull();
    expect(unmetRequest("salva o número da Ana: 11 98888-7777", "Ok", new Set())).toBe("salvar contato");
    expect(unmetRequest("quais contatos eu tenho salvos?", "Você tem 3", new Set())).toBeNull();
    expect(unmetRequest("apaga o contato do Marcos", "Ok", new Set())).toBeNull();
  });

  it("gasto no cartão: só diz \"no vale alimentação\" se foi mesmo para o cartão", async () => {
    const { unbackedClaim, CARD_USED, CARD_CLAIM } = await import("../src/agent/claims.js");
    // 16/10: add_transaction sem card e a resposta "Anotei os R$ 17,20 do mercado no vale alimentação ✅"
    const said = "Anotei os R$ 17,20 do mercado no vale alimentação ✅\n\nJá somou no mês 🛒";
    expect(unbackedClaim(said, new Set(["add_transaction", "react_to_message"]))).toBe(CARD_CLAIM);
    expect(unbackedClaim(said, new Set(["add_transaction", CARD_USED]))).toBeNull();
    expect(unbackedClaim("Isso, já tá certinho no *vale alimentação* ✅", new Set(["update_transaction"]))).toBe(CARD_CLAIM);
    expect(unbackedClaim("Pronto, passei pro cartão Inter ✅", new Set(["update_transaction", CARD_USED]))).toBeNull();
    expect(unbackedClaim("Anotei os R$ 30 sem cartão, no Pix ✅", new Set(["add_transaction"]))).toBeNull();
    expect(unbackedClaim("Anotei os R$ 30 do almoço ✅ Foi no cartão?", new Set(["add_transaction"]))).toBeNull();
    // lendo o extrato, "foi no Inter" é só informação
    expect(unbackedClaim("O de ontem foi no Inter, R$ 30", new Set(["list_transactions"]))).toBeNull();
  });

  it("acha o cartão que a pessoa citou na mensagem", async () => {
    const { cardInText } = await import("../src/cards.js");
    const mine = [
      { id: "1", name: "Inter", brand: null, last4: "1234" },
      { id: "2", name: "Vale refeição", brand: null, last4: null },
      { id: "3", name: "Vale alimentação", brand: null, last4: null },
    ];
    const pick = (t: string) => {
      const r = cardInText(t, mine);
      return r && "card" in r ? r.card.name : r;
    };
    expect(pick("[áudio] Planejar é acabei de gastar 17,20 aqui no mercado, utilizando o cartão vale alimentação.")).toBe("Vale alimentação");
    expect(pick("almoço 32 no VR")).toBe("Vale refeição");
    expect(pick("gastei 50 no inter")).toBe("Inter");
    expect(pick("paguei 80 no final 1234")).toBe("Inter");
    expect(pick("gastei 20 de internet")).toBeNull();
    expect(pick("gastei 12 no pix")).toBeNull();
    expect(pick("gastei 12 no cartão de débito")).toBeNull();
    expect(pick("gastei 40 no cartão")).toEqual({ said: "cartao" });
    expect(cardInText("gastei 40 no cartão do Itaú", [])).toEqual({ said: "cartao do itau" });
    expect(cardInText("17 no vale alimentação", [{ id: "9", name: "Alelo", brand: null, last4: null }])).toEqual({ card: { id: "9", name: "Alelo", brand: null, last4: null } });
  });

  it("cartão de contato do WhatsApp vira texto com nome e número", async () => {
    const { parseWAMessage } = await import("../src/channels/wa-message.js");
    const vcard = "BEGIN:VCARD\nVERSION:3.0\nN:;Marcos;;;\nFN:Marcos\nitem1.TEL;waid=5519996726445:+55 19 99672-6445\nitem1.X-ABLabel:Celular\nEND:VCARD";
    const one = parseWAMessage({ key: { id: "1", remoteJid: "5511999999999@s.whatsapp.net" }, message: { contactMessage: { displayName: "Marcos", vcard } } }, "baileys");
    expect(one?.kind).toBe("text");
    expect(one?.text).toContain("Marcos: +5519996726445");
    const many = parseWAMessage(
      { key: { id: "2", remoteJid: "5511999999999@s.whatsapp.net" }, message: { contactsArrayMessage: { contacts: [{ displayName: "Marcos", vcard }, { displayName: "Ana", vcard: "BEGIN:VCARD\nFN:Ana\nTEL;TYPE=CELL:(11) 98888-7777\nEND:VCARD" }] } } },
      "baileys",
    );
    expect(many?.text.split("\n")).toEqual(["[cartão de contato compartilhado]", "Marcos: +5519996726445", "Ana: (11) 98888-7777"]);
  });

  it("pega afirmação sem ferramenta e libera quando a ferramenta rodou ou é pergunta", async () => {
    const { unbackedClaim } = await import("../src/agent/claims.js");
    expect(unbackedClaim("Anotei os 4 ✅ Padaria R$ 8,20", new Set())).toBe("lançar gasto ou receita");
    expect(unbackedClaim("Anotei os 4 ✅ Padaria R$ 8,20", new Set(["add_transaction"]))).toBeNull();
    expect(unbackedClaim("Quer que eu anote esse gasto de R$ 10?", new Set())).toBeNull();
    expect(unbackedClaim("Apaguei o uber de ontem.", new Set())).toBe("apagar ou cancelar");
    expect(unbackedClaim("Bom dia! Hoje tem reunião às 10h.", new Set())).toBeNull();
    expect(unbackedClaim("Mandei pro Giovani 👍", new Set())).toBe("enviar mensagem");
    expect(unbackedClaim("Mandei pro Giovani 👍", new Set(["send_to_contact"]))).toBeNull();
    expect(unbackedClaim("Posso mandar pro Giovani?", new Set())).toBeNull();
    expect(unbackedClaim("Convidei a Ana, agora é só ela aceitar.", new Set())).toBe("convidar");
    expect(unbackedClaim("Gerei o link: https://mp.com/x", new Set())).toBe("gerar link de pagamento");
    expect(unbackedClaim("Marquei com o petshop às 18h.", new Set(["errand_done"]))).toBeNull();
    // 12/10: "Prontinho! Amanhã às 8h eu te aviso" passou sem schedule_reminder
    const prontinho = "Combinado, David! Deixa comigo ⏰\nProntinho! Amanhã às *8h* eu te aviso pra falar com seu chefe sobre o treinamento da Adriana. Bom descanso 😴";
    expect(unbackedClaim(prontinho, new Set())).toBe("agendar lembrete ou evento");
    expect(unbackedClaim(prontinho, new Set(["schedule_reminder"]))).toBeNull();
    expect(unbackedClaim("Te chamo às 7:30 pra corrida.", new Set())).toBe("agendar lembrete ou evento");
    // sem hora na mesma frase é só promessa de retorno (De olho, pesquisa)
    expect(unbackedClaim("Assim que o preço cair, eu te aviso por aqui.", new Set())).toBeNull();
    expect(unbackedClaim("Hoje tá corrido. Já vou ver e te aviso.", new Set())).toBeNull();
    expect(unbackedClaim("Pronto, David! Agora tá criado e ativo ✅\n\n⏰ Amanhã, 13/10, às 8h: falar com o chefe.", new Set())).toBe("agendar lembrete ou evento");
    expect(unbackedClaim("Pronto, David! Agora tá criado e ativo ✅\n\n⏰ Amanhã, 13/10, às 8h.", new Set(["schedule_reminder"]))).toBeNull();
  });

  it("pedido claro de lembrete sem ferramenta de agenda refaz a resposta", async () => {
    const { unmetRequest } = await import("../src/agent/claims.js");
    const pedido = "[msg_id=251] [áudio] Me lembre amanhã às oito horas da manhã que eu preciso falar com meu chefe.";
    expect(unmetRequest(pedido, "Combinado, David! Deixa comigo ⏰", new Set())).toBe("agendar lembrete ou evento");
    expect(unmetRequest(pedido, "Combinado!", new Set(["schedule_reminder"]))).toBeNull();
    expect(unmetRequest("Mas cria um lembrete para isso", "Pronto!", new Set(["ask_agenda"]))).toBe("agendar lembrete ou evento");
    expect(unmetRequest("Me lembra de comprar pão", "Claro! Que horas você quer o aviso?", new Set())).toBeNull();
    expect(unmetRequest("Cancela o lembrete do treino", "Feito", new Set())).toBeNull();
    expect(unmetRequest("Quais lembretes eu tenho amanhã?", "Só o treino às 7h.", new Set())).toBeNull();
    expect(unmetRequest("Quanto gastei hoje?", "R$ 40", new Set())).toBeNull();
    expect(unmetRequest("Me avisa se o preço baixar", "Fechado, deixei de olho", new Set(["watch_create"]))).toBeNull();
    expect(unmetRequest("[áudio] Gastei 50 reais no mercado", "Show, David! 🛒", new Set())).toBe("lançar gasto ou receita");
    expect(unmetRequest("paguei a luz 180,40", "Feito!", new Set(["add_transaction"]))).toBeNull();
    expect(unmetRequest("Recebi 2 mil do freela", "Boa! Foi de qual conta?", new Set())).toBeNull();
    expect(unmetRequest("Quanto gastei no mercado esse mês?", "R$ 320", new Set())).toBeNull();
    expect(unmetRequest("Apaga o gasto de 50 do mercado", "Apaguei", new Set())).toBeNull();
    expect(unmetRequest("comprei um tênis", "Que massa!", new Set())).toBeNull();
    expect(unmetRequest("anota 30 reais de uber", "Fechado!", new Set())).toBe("lançar gasto ou receita");
    expect(unmetRequest("anota que a reunião é dia 15", "Anotado!", new Set(["save_memory"]))).toBeNull();
  });

  it("pega o jeito curto de pedir e as frases de pronto sem verbo", async () => {
    const { unbackedClaim, unmetRequest } = await import("../src/agent/claims.js");
    const none = new Set<string>();
    for (const t of ["mercado 50", "uber 23,90", "anota padaria 12", "50 no mercado", "[áudio] uber 30"]) expect(unmetRequest(t, "Fechado!", none), t).toBe("lançar gasto ou receita");
    for (const t of ["amanhã 8h reunião", "lembrar de pagar o boleto sexta"]) expect(unmetRequest(t, "Fechado!", none), t).toBe("agendar lembrete ou evento");
    for (const t of ["apto 32", "tenho reunião amanhã às 10h", "quanto deu o mercado 50?", "2 pães", "anota que a reunião é dia 15"]) expect(unmetRequest(t, "Ok!", new Set(["save_memory"])), t).toBeNull();
    expect(unmetRequest("mercado 50", "Anotado ✅", new Set(["add_transaction"]))).toBeNull();
    const claims: [string, string][] = [
      ["Prontinho! Coloquei na sua agenda amanhã às 9h ✅", "agendar lembrete ou evento"],
      ["Feito! Amanhã às 8h você recebe o aviso 😉", "agendar lembrete ou evento"],
      ["Combinado! Amanhã 8h tô aqui te lembrando", "agendar lembrete ou evento"],
      ["Tá anotado!", "anotar"],
      ["Pronto, já está na sua lista de gastos!", "lançar gasto ou receita"],
      ["Apagado ✅", "apagar ou cancelar"],
      ["A mensagem pro João já foi ✅", "enviar mensagem"],
    ];
    for (const [t, what] of claims) expect(unbackedClaim(t, none), t).toBe(what);
    // informação, lembrete na hora e leitura não são afirmação de feito
    for (const t of ["O filme foi removido da Netflix em setembro.", "Oi! Passando pra te lembrar: hoje às 15h tem dentista 🦷", "Prontinho! Achei 3 lugares perto de você ✅"])
      expect(unbackedClaim(t, none), t).toBeNull();
    expect(unbackedClaim("Tá na sua agenda: reunião amanhã às 10h.", new Set(["list_reminders"]))).toBeNull();
    expect(unbackedClaim("Anotado!", new Set(["save_memory"]))).toBeNull();
  });
});

describe("confirmação de ação sensível (servidor, sem IA)", () => {
  it("só o sim da pessoa libera; não recusa; o resto não decide", async () => {
    const { confirmationAnswer } = await import("../src/agent/confirm.js");
    for (const t of ["sim", "Sim!", "pode mandar", "pode sim", "👍", "ok", "confirmo", "sim, por favor"]) expect(confirmationAnswer([t])).toBe("yes");
    for (const t of ["não", "nao, espera", "cancela", "deixa pra lá", "melhor não"]) expect(confirmationAnswer([t])).toBe("no");
    for (const t of ["muda o assunto para Reunião amanhã", "quanto gastei hoje?", "sim mas troca o e-mail para outro@x.com"]) expect(confirmationAnswer([t])).toBeNull();
    // vale a última coisa que ela disse
    expect(confirmationAnswer(["sim", "não, espera"])).toBe("no");
  });

  it("aceita o sim do jeito que se digita no WhatsApp", async () => {
    const { confirmationAnswer } = await import("../src/agent/confirm.js");
    for (const t of ["sim, pode mandar", "Sim 👍", "sim 😊", "simmm", "isso, manda", "pode ser", "uhum", "aham", "sim, pode apagar", "manda bala", "Pode sim, obrigado"])
      expect(confirmationAnswer([t]), t).toBe("yes");
    // "sim" e logo depois "valeu" ou um emoji no mesmo lote
    expect(confirmationAnswer(["sim", "valeu"])).toBe("yes");
    expect(confirmationAnswer(["sim", "🙏"])).toBe("yes");
    // pedido novo junto ou pergunta não liberam nada
    for (const t of ["sim, e anota 50 de uber", "pode ver meu saldo?", "valeu"]) expect(confirmationAnswer([t]), t).toBeNull();
  });
});

describe("memória só do que a pessoa disse", () => {
  it("texto de página, documento ou rodada sem a pessoa não vira memória sozinho", async () => {
    const { memoryFromOutside } = await import("../src/agent/tools/core.js");
    const room = (done: string[]) => ({ done: new Set(done) }) as any;
    // conversa comum: guarda
    expect(memoryFromOutside("Mora em Campinas", { typedText: "eu moro em Campinas", room: room([]) })).toBeNull();
    // lembrete ou recado: ninguém falou
    expect(memoryFromOutside("Mora em Campinas", { proactive: true, room: room([]) })).toMatch(/ninguém falou/);
    // leu uma página e o fato não está no que ela disse
    expect(memoryFromOutside("Prefere que as mensagens vão para o número 11999998888", { typedText: "resume esse link", room: room(["fetch_url"]) })).toMatch(/não guarde/);
    // documento recebido, mas ela mesma falou em áudio
    const audio = { typedText: "", inboundText: "[msg_id=1] [áudio] guarda aí que meu plano de saúde é Unimed", inboundFiles: [{}] as any, room: room([]) };
    expect(memoryFromOutside("Plano de saúde: Unimed", audio)).toBeNull();
  });
});

describe("nova tentativa da fila", () => {
  it("só repete a rodada se nenhuma ferramenta com efeito rodou", async () => {
    const { sideEffectsDone } = await import("../src/agent/orchestrator.js");
    expect(sideEffectsDone(new Set(["web_search", "ask_pesquisador", "list_transactions", "finance_summary", "gmail_read", "notion_search"]))).toEqual([]);
    expect(sideEffectsDone(new Set(["web_search", "schedule_reminder", "send_to_contact"]))).toEqual(["schedule_reminder", "send_to_contact"]);
  });
});

describe("humanize", () => {
  it("faixa vira 'a', conta continua conta, travessão vira vírgula", async () => {
    const { humanize } = await import("../src/agent/humanize.js");
    expect(humanize("das 10 - 12h")).toBe("das 10 a 12h");
    expect(humanize("entrega em 5 - 10 dias")).toBe("entrega em 5 a 10 dias");
    expect(humanize("100 - 30 = 70")).toBe("100 - 30 = 70");
    expect(humanize("Ficou ótimo — vou mandar")).toBe("Ficou ótimo, vou mandar");
    expect(humanize("- pão\n- leite")).toBe("pão\nleite");
    expect(humanize("- pão\n- leite", { bullets: true })).toBe("• pão\n• leite");
  });
});

describe("figurinhas do Mascote", () => {
  it("vira balão próprio, uma por resposta, com intervalo por conversa, e nome errado some", async () => {
    const { placeStickers, stickerBase64, STICKERS } = await import("../src/agent/stickers.js");
    for (const n of STICKERS) expect(stickerBase64(n)?.startsWith("UklGR")).toBe(true); // webp = RIFF
    expect(stickerBase64("Óculos escuros")).not.toBeNull();
    expect(stickerBase64("inexistente")).toBeNull();
    const added: string[] = [];
    const add = (b: string) => (added.push(b), `m${added.length}`);
    const conv = `t-${Date.now()}`;
    expect(splitBubbles(placeStickers("Prontinho, anotado ✅ [[figurinha:pronto]] [[figurinha:feliz]]", conv, add))).toEqual([
      { type: "text", text: "Prontinho, anotado ✅" },
      { type: "media", id: "m1" },
    ]);
    expect(added).toHaveLength(1);
    // logo depois, na mesma conversa, a figurinha não sai de novo
    expect(placeStickers("[[figurinha:oi]]\nBom dia!", conv, add)).toBe("Bom dia!");
    expect(placeStickers("Oi [[figurinha:nada]]", `${conv}-2`, add)).toBe("Oi");
  });

  it("[[gif:busca]] vira balão de GIF sem outra rodada do modelo e tira a figurinha da mesma resposta", async () => {
    const { placeGifs } = await import("../src/agent/stickers.js");
    const conv = `g-${Date.now()}`;
    const asked: string[] = [];
    const fetch = async (q: string) => (asked.push(q), "AAAA");
    const add = () => "m9";
    expect(await placeGifs("Parabéns!! 🎉 [[gif:comemoração]] [[figurinha:festa]] [[gif:outro]]", conv, fetch, add)).toBe("Parabéns!! 🎉\n---\n[[media:m9]]");
    expect(asked).toEqual(["comemoração"]);
    // intervalo: logo depois o marcador some e a figurinha fica
    expect(await placeGifs("Boa! [[gif:high five]] [[figurinha:feliz]]", conv, fetch, add)).toBe("Boa! [[figurinha:feliz]]");
    // sem provedor de GIF ligado o marcador some
    expect(await placeGifs("Bom dia [[gif:bom dia]]", `${conv}-2`, null, add)).toBe("Bom dia");
  });
});

describe("perguntas de boas-vindas do cadastro", () => {
  it("só abre a pergunta seguinte pelo caminho escolhido e resume em uma linha", async () => {
    const { activeQuestions, cleanAnswers, onboardingSummary } = await import("../src/onboarding.js");
    expect(activeQuestions({}).map((q) => q.id)).toEqual(["goal", "tone"]);
    expect(activeQuestions({ goal: ["money", "work"] }).map((q) => q.id)).toEqual(["goal", "money_goal", "forget", "tone"]);
    const a = cleanAnswers({ goal: "agenda", forget: ["meds", "x"], money_goal: "debt", tone: "short", more: "fora da lista" });
    expect(a).toEqual({ goal: ["agenda"], forget: ["meds"], tone: "short" });
    expect(onboardingSummary(a)).toBe("Quer ajuda com: Agenda e lembretes. Costuma esquecer: Remédios. Prefere conversa: Direto e curto");
    const { welcomeText } = await import("../src/onboarding.js");
    const hi = welcomeText("Ana Souza", { goal: ["habits", "money"] }, "Bolinho");
    expect(hi.startsWith("Oi, Ana! Aqui é o Bolinho")).toBe(true);
    expect(hi).toContain('• "me lembra de beber água às 10h todo dia"\n• "gastei 42 no mercado"\n• "me lembra amanhã às 9h do dentista"');
    const { specialistSystemPrompt } = await import("../src/agent/prompts.js");
    const user = { id: "u", phone: "5519900000000", name: "Ana", status: "active", timezone: null, profile: { onboarding: { summary: onboardingSummary(a) } } };
    const prompt = specialistSystemPrompt({ name: "Financeiro", role: "dinheiro", instructions: "" } as any, { timezone: "America/Sao_Paulo", user, settings: { assistantName: "Planejai" } as any });
    expect(prompt).toContain("Contou no cadastro (use para personalizar as respostas, não pergunte de novo): Quer ajuda com: Agenda e lembretes.");
  });
});

describe("prompts editados no Mapa do time", () => {
  it("o editado entra no lugar do padrão e vazio volta ao código", async () => {
    const { withPrompt } = await import("../src/agent/prompt-overrides.js");
    const { CTO_RULES, ctoSystemPrompt, specialistSystemPrompt, TEAM_RULES } = await import("../src/agent/prompts.js");
    const def = { id: "agenda", name: "Agenda", role: "lembretes", instructions: "padrão", tools: [] } as any;
    const row = (role: string | null, instructions: string | null) => new Map([["agenda", { role, instructions, base_hash: null, updated_at: "" }]]);
    expect(withPrompt(def, row("só alarmes", null))).toMatchObject({ role: "só alarmes", instructions: "padrão" });
    expect(withPrompt(def, row("  ", "novo jeito"))).toMatchObject({ role: "lembretes", instructions: "novo jeito" });
    expect(withPrompt(def, new Map())).toBe(def);

    const user = { id: "u", phone: "5519900000000", name: "Ana", status: "active", timezone: null, profile: {} };
    const settings = { assistantName: "Bolinho", persona: "" } as any;
    const base = { settings, user, timezone: "America/Sao_Paulo", memories: [], summary: null, specialists: [], disconnected: [] };
    const padrao = ctoSystemPrompt(base);
    expect(padrao).toContain("Você é Bolinho, assistente pessoal no WhatsApp.");
    expect(padrao).not.toContain("{assistente}");
    expect(CTO_RULES).toContain("{assistente}");
    const editado = ctoSystemPrompt({ ...base, rules: "Você é {assistente}. Responda curto." });
    expect(editado.startsWith("Você é Bolinho. Responda curto.")).toBe(true);
    expect(editado).not.toContain("# Estilo");
    expect(editado).toContain("# Contexto");
    expect(ctoSystemPrompt({ ...base, gifs: true })).toContain("[[gif:busca curta]]");

    const sp = (teamRules?: string) => specialistSystemPrompt(def, { timezone: "America/Sao_Paulo", user, settings, teamRules });
    expect(sp()).toContain(TEAM_RULES);
    expect(sp("Regras: seja breve.")).toContain("Regras: seja breve.");
    expect(sp("Regras: seja breve.")).not.toContain("consult_colega");
  });
});

describe("comprovante na foto vira despesa sozinho", async () => {
  const { parseReceipt, receiptDate } = await import("../src/agent/receipts.js");
  it("lê a linha FINANCEIRO de comprovante pago", () => {
    const r = parseReceipt("FINANCEIRO: tipo=comprovante; valor_total=89.90; data=2026-10-08; estabelecimento=PetCamp; pago=sim; direcao=saida\nItens: banho");
    expect(r).toMatchObject({ tipo: "comprovante", valor: 89.9, data: "2026-10-08", estabelecimento: "PetCamp" });
    expect(parseReceipt("FINANCEIRO: tipo=nota; valor_total=1234,56; data=?; estabelecimento=?; pago=?")?.valor).toBe(1234.56);
  });
  it("não lança boleto em aberto, lista nem foto comum", () => {
    expect(parseReceipt("FINANCEIRO: tipo=boleto; valor_total=200.00; data=?; estabelecimento=Luz; pago=não")).toBeNull();
    expect(parseReceipt("FINANCEIRO: tipo=fatura; valor_total=900.00; data=?; estabelecimento=Nubank; pago=?")).toBeNull();
    expect(parseReceipt("FINANCEIRO: tipo=lista; itens=3")).toBeNull();
    expect(parseReceipt("Um cachorro na praia")).toBeNull();
    expect(parseReceipt("FINANCEIRO: tipo=comprovante; valor_total=?; data=?; estabelecimento=X; pago=sim")).toBeNull();
  });
  it("data sem ano é do ano atual, ou do passado se cairia no futuro", () => {
    const now = new Date("2026-10-08T15:00:00Z");
    expect(receiptDate("??-10-06", "America/Sao_Paulo", now)).toBe("2026-10-06");
    expect(receiptDate("??-12-20", "America/Sao_Paulo", now)).toBe("2025-12-20");
    expect(receiptDate("2026-09-01", "America/Sao_Paulo", now)).toBe("2026-09-01");
    expect(receiptDate(null, "America/Sao_Paulo", now)).toBeUndefined();
  });
});

describe("total somado de cabeça", () => {
  it("tira 'já são R$ 39 hoje' quando a ferramenta devolveu outro total", async () => {
    const { dropUnbackedTotals, knownAmounts } = await import("../src/agent/claims.js");
    const tool = '{"ok":true,"amount":"R$ 19,00","month_expenses":"R$ 19,00","month_category_total":"R$ 19,00","day_category_total":"R$ 19,00"}';
    const known = knownAmounts([tool, "[áudio] gastei 19 reais na padaria hoje"]);
    const r = dropUnbackedTotals("Lançado! 🥐 *R$ 19* na padaria, na Alimentação.\n\nJá são *R$ 39* de alimentação hoje.", known);
    expect(r.dropped).toEqual(["Já são *R$ 39* de alimentação hoje."]);
    expect(r.text).toBe("Lançado! 🥐 *R$ 19* na padaria, na Alimentação.");
  });
  it("mantém total que veio da ferramenta e valor sem frase de total", async () => {
    const { dropUnbackedTotals, knownAmounts } = await import("../src/agent/claims.js");
    const known = knownAmounts(['{"month_category_total":"R$ 1.234,50","day_expenses":"R$ 39,00"}']);
    const t = "Anotado! *R$ 20* de sushi.\n\nNo mês a alimentação tá em *R$ 1.234,50* e hoje já são *R$ 39*.";
    expect(dropUnbackedTotals(t, known)).toEqual({ text: t, dropped: [] });
  });
});

describe("áudio só quando pedem", () => {
  it("oração, história ou recado sem pedir áudio sai por escrito, igual para todos", async () => {
    const { audioAsked } = await import("../src/agent/tools/audio.js");
    expect(audioAsked("[msg_id=1] faz uma oração pra mim")).toBe(false);
    expect(audioAsked("[msg_id=1] [áudio] faz uma oração pra minha mãe")).toBe(false);
    expect(audioAsked(undefined)).toBe(false);
    expect(audioAsked("[msg_id=1] faz uma oração em áudio")).toBe(true);
    expect(audioAsked("[msg_id=2] manda um audio")).toBe(true);
    expect(audioAsked("[msg_id=3] [áudio] grava uma oração pra mim")).toBe(true);
    expect(audioAsked("quero ouvir uma história")).toBe(true);
    expect(audioAsked("me manda por mensagem de voz")).toBe(true);
    expect(audioAsked("comprar gravata e vozes")).toBe(false);
  });
});
