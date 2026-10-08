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
      "*Kinoplex* e ingresso: https://ingresso.com\n14h30\n*Sessões*",
    );
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

  it("tira traços e travessões para soar como gente", () => {
    expect(toWhatsApp("Opções:\n- Kinoplex — 14h30\n• Cinemark - das 16 - 18h\n1. Pipoca")).toBe("Opções:\nKinoplex, 14h30\nCinemark, das 16 a 18h\n1. Pipoca");
    expect(toWhatsApp("Fica uns R$ 50 – com pipoca 🍿")).toBe("Fica uns R$ 50, com pipoca 🍿");
    expect(toWhatsApp("Guarda-chuva e -5 graus")).toBe("Guarda-chuva e -5 graus");
  });

  it("divide balões com --- e posiciona mídias", () => {
    expect(splitBubbles("Sessões de sábado:\n• 14h30\n[[media:m1]]\n---\nQual horário você prefere?")).toEqual([
      { type: "text", text: "Sessões de sábado:\n14h30" },
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
  it("pega afirmação sem ferramenta e libera quando a ferramenta rodou ou é pergunta", async () => {
    const { unbackedClaim } = await import("../src/agent/claims.js");
    expect(unbackedClaim("Anotei os 4 ✅ Padaria R$ 8,20", new Set())).toBe("lançar gasto ou receita");
    expect(unbackedClaim("Anotei os 4 ✅ Padaria R$ 8,20", new Set(["add_transaction"]))).toBeNull();
    expect(unbackedClaim("Quer que eu anote esse gasto de R$ 10?", new Set())).toBeNull();
    expect(unbackedClaim("Apaguei o uber de ontem.", new Set())).toBe("apagar ou cancelar");
    expect(unbackedClaim("Bom dia! Hoje tem reunião às 10h.", new Set())).toBeNull();
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
  });
});

describe("perguntas de boas-vindas do cadastro", () => {
  it("só abre a pergunta seguinte pelo caminho escolhido e resume em uma linha", async () => {
    const { activeQuestions, cleanAnswers, onboardingSummary } = await import("../src/onboarding.js");
    expect(activeQuestions({}).map((q) => q.id)).toEqual(["goal", "home", "tone", "more"]);
    expect(activeQuestions({ goal: ["work"], income: "business" }).map((q) => q.id)).toEqual(["goal", "income", "split", "forget", "home", "tone", "more"]);
    const a = cleanAnswers({ goal: "agenda", forget: ["meds", "x"], home: "alone", shared: "split", more: "  tenho   um gato " });
    expect(a).toEqual({ goal: ["agenda"], forget: ["meds"], home: "alone", more: "tenho um gato" });
    expect(onboardingSummary(a)).toBe("Quer ajuda com: Agenda e lembretes. Costuma esquecer: Remédios. Mora: Sozinho(a). Contou: tenho um gato");
    const { specialistSystemPrompt } = await import("../src/agent/prompts.js");
    const user = { id: "u", phone: "5519900000000", name: "Ana", status: "active", timezone: null, profile: { onboarding: { summary: onboardingSummary(a) } } };
    const prompt = specialistSystemPrompt({ name: "Financeiro", role: "dinheiro", instructions: "" } as any, { timezone: "America/Sao_Paulo", user, settings: { assistantName: "Planejai" } as any });
    expect(prompt).toContain("Contou no cadastro (use para personalizar as respostas, não pergunte de novo): Quer ajuda com: Agenda e lembretes.");
  });
});
