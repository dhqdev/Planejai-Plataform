import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeOfx, merchantOf, ofxCents, parseOfx, tidy } from "../src/ofx.js";

/** Extrato OFX do banco: SGML (1.x) e XML (2.x), conta e cartão, Windows-1252, centavos exatos. */
const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
CHARSET:1252

<OFX>
<SIGNONMSGSRSV1><SONRS><FI><ORG>NU PAGAMENTOS<FID>260</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>0260<ACCTID>12345-6</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001000000[-3:BRT]<DTEND>20261020000000[-3:BRT]
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261015120000[-3:BRT]<TRNAMT>-23.90<FITID>abc1<MEMO>COMPRA CARTAO DEB PADARIA PAO QUENTE 15/10</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261005<TRNAMT>3500,00<FITID>abc2<MEMO>Transferência recebida</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261006<TRNAMT>-1.234,56<FITID>abc2<MEMO>PAGAMENTO DE FATURA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261007<TRNAMT>0.00<FITID>zero<MEMO>nada</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

describe("OFX", () => {
  it("lê o SGML com tags abertas, valores em centavos e FITID repetido sem colidir", () => {
    const st = parseOfx(SGML);
    expect(st).toMatchObject({ bank: "Nubank", bankId: "260", account: "12345-6", creditCard: false, start: "2026-10-01", end: "2026-10-20" });
    expect(st.transactions.map((t) => [t.date, t.cents])).toEqual([
      ["2026-10-15", -2390],
      ["2026-10-05", 350000],
      ["2026-10-06", -123456],
    ]);
    const [a, b, c] = st.transactions;
    expect(a!.description).toBe("Compra Cartao Deb Padaria Pao Quente");
    expect(a!.merchant).toBe("Padaria Pao Quente");
    expect(b!.ref).toBe("abc2");
    expect(c!.ref).not.toBe("abc2");
    expect(c!.ref.startsWith("abc2#")).toBe(true);
    // ler de novo dá os mesmos identificadores (é o que evita duplicar)
    expect(parseOfx(SGML).transactions.map((t) => t.ref)).toEqual(st.transactions.map((t) => t.ref));
  });

  it("lê o XML do OFX 2 e a fatura do cartão", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL</CURDEF>
      <CCACCTFROM><ACCTID>5555</ACCTID></CCACCTFROM><BANKTRANLIST>
      <STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261010</DTPOSTED><TRNAMT>-59.90</TRNAMT><FITID>x1</FITID><NAME>Netflix.com</NAME><MEMO>Netflix.com</MEMO></STMTTRN>
      <STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261011</DTPOSTED><TRNAMT>800</TRNAMT><FITID>x2</FITID><MEMO>Pagamento recebido &amp; obrigado</MEMO></STMTTRN>
      </BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    const st = parseOfx(xml);
    expect(st.creditCard).toBe(true);
    expect(st.transactions.map((t) => [t.description, t.cents])).toEqual([
      ["Netflix.com", -5990],
      ["Pagamento recebido & obrigado", 80000],
    ]);
  });

  it("acentos do Windows-1252 e arquivo que não é extrato", () => {
    const bytes = Buffer.concat([Buffer.from("OFXHEADER:100\nCHARSET:1252\n<OFX><STMTTRN><DTPOSTED>20261001<TRNAMT>-10<FITID>1<MEMO>Farm"), Buffer.from([0xe1]), Buffer.from("cia</STMTTRN></OFX>")]);
    expect(parseOfx(decodeOfx(bytes)).transactions[0]!.description).toBe("Farmácia");
    expect(() => parseOfx("nome,valor\nx,1")).toThrow(/não parece um extrato OFX/);
  });

  it("valor, texto e lugar", () => {
    expect(ofxCents("-1234.5")).toBe(-123450);
    expect(ofxCents("+80")).toBe(8000);
    expect(ofxCents("1.234")).toBe(123400);
    expect(ofxCents("abc")).toBeNull();
    expect(tidy("PIX ENVIADO MARIA DA SILVA")).toBe("Pix Enviado Maria da Silva");
    expect(merchantOf(null, "PIX ENVIADO MARIA DA SILVA")).toBe("Maria da Silva");
    expect(merchantOf("UBER *TRIP", "Compra no débito")).toBe("Uber *trip");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("importar OFX (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let ofx: typeof import("../src/ofx-import.js");
  let uid: string;
  const file = (s: string) => Buffer.from(s, "latin1").toString("base64");
  const EXTRATO = file(`OFXHEADER:100
CHARSET:1252
<OFX><BANKMSGSRSV1><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>341<ACCTID>9988</BANKACCTFROM><BANKTRANLIST>
<STMTTRN><DTPOSTED>20261015<TRNAMT>-23.90<FITID>t1<MEMO>COMPRA CARTAO DEB PADARIA PAO QUENTE</STMTTRN>
<STMTTRN><DTPOSTED>20261014<TRNAMT>-89.00<FITID>t2<MEMO>PETZ OSASCO</STMTTRN>
<STMTTRN><DTPOSTED>20261013<TRNAMT>-45.00<FITID>t3<MEMO>LOJA DO ZE</STMTTRN>
<STMTTRN><DTPOSTED>20261012<TRNAMT>-1500.00<FITID>t4<MEMO>PAGAMENTO FATURA CARTAO</STMTTRN>
<STMTTRN><DTPOSTED>20261010<TRNAMT>-30.00<FITID>t5<MEMO>UBER TRIP</STMTTRN>
</BANKTRANLIST></STMTRS></BANKMSGSRSV1></OFX>`);

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    uid = (await upsertUser("5519933334444", "Rita")).id;
    ofx = await import("../src/ofx-import.js");
    // o Uber ela já tinha lançado pelo WhatsApp
    await db.query("INSERT INTO transactions (user_id, kind, amount, category, description, occurred_at) VALUES ($1, 'expense', 30, 'Transporte', 'uber pro trabalho', '2026-10-11T12:00:00Z')", [uid]);
  });

  afterAll(async () => {
    await db?.pool.end();
  });

  it("prévia com categoria automática, sugestão de categoria nova, fatura desmarcada e o que já foi lançado", async () => {
    const p = await ofx.previewOfx(uid, EXTRATO);
    expect(p).toMatchObject({ bank: "Itaú", account: "•••• 9988", credit_card: false });
    const by = Object.fromEntries(p.rows.map((r) => [r.ref, r]));
    expect(by.t1).toMatchObject({ category: "Alimentação", kind: "expense", amount: 23.9, merchant: "Padaria Pao Quente", skip: null });
    expect(by.t2).toMatchObject({ category: "Pets", how: "nova" });
    expect(p.suggested.map((s) => s.name)).toEqual(["Pets"]);
    expect(by.t4!.skip).toMatch(/fatura/);
    expect(by.t5!.similar).toMatchObject({ description: "uber pro trabalho" });
    expect(p.totals.expenses).toBe(187.9);
  });

  it("importa com categoria nova e trocada, aprende e não duplica na segunda vez", async () => {
    const rows = [
      { ref: "t1", category: "Alimentação" },
      { ref: "t2", category: "Pets" },
      { ref: "t3", category: "Compras", changed: true },
    ];
    const r = await ofx.importOfx(uid, { file: EXTRATO, rows, create: [{ name: "Pets", kind: "expense" }], tz: "America/Sao_Paulo" });
    expect(r).toEqual({ imported: 3, skipped: 0, created: ["Pets"] });
    const saved = await db.many("SELECT amount::text, category, source FROM transactions WHERE user_id = $1 AND source = 'ofx' ORDER BY amount", [uid]);
    expect(saved).toEqual([
      { amount: "23.90", category: "Alimentação", source: "ofx" },
      { amount: "45.00", category: "Compras", source: "ofx" },
      { amount: "89.00", category: "Pets", source: "ofx" },
    ]);
    expect(await ofx.importOfx(uid, { file: EXTRATO, rows, tz: "America/Sao_Paulo" })).toMatchObject({ imported: 0, skipped: 3 });
    const again = await ofx.previewOfx(uid, EXTRATO);
    expect(again.rows.filter((x) => x.imported).map((x) => x.ref).sort()).toEqual(["t1", "t2", "t3"]);
    expect(again.suggested).toEqual([]);
    // aprendeu: a Loja do Zé agora vai para Compras sozinha
    const { autoCategory } = await import("../src/categories.js");
    expect((await autoCategory(uid, "expense", null, "Loja do Ze")).category).toBe("Compras");
  });
});
