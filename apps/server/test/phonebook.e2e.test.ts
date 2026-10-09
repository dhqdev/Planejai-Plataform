import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Agenda de contatos importada do celular: .vcf do iPhone e do Android, números, busca sem acento e a ferramenta do agente. */
const IPHONE = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Souza;Ana Paula;;;",
  "FN:Ana Paula Souza",
  "item1.TEL;type=CELL;type=VOICE;type=pref:+55 (19) 99123-4567",
  "TEL;type=WORK;type=VOICE:(19) 3232-1000",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ",
  " AAAQABAAD",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Pizzaria do Zé",
  "ORG:Pizzaria do Zé;",
  "TEL;type=MAIN:0800 777 1234",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Sem Número",
  "EMAIL:x@y.com",
  "END:VCARD",
].join("\r\n");

const ANDROID = [
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Concei=C3=A7=C3=A3o;Jo=C3=A3o;;;",
  "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jo=C3=A3o Concei=C3=A7=C3=A3o",
  "TEL;CELL:011 98888-7777",
  "TEL;CELL:+1 415 555 0100",
  "END:VCARD",
].join("\n");

describe("agenda: arquivo e números", () => {
  it("lê o .vcf do iPhone e do Android (dobra de linha, quoted-printable, foto ignorada)", async () => {
    const { parseVcf } = await import("../src/phonebook.js");
    const list = parseVcf(`${IPHONE}\n${ANDROID}`);
    expect(list.map((c) => c.name)).toEqual(["Ana Paula Souza", "Pizzaria do Zé", "João Conceição"]);
    expect(list[0]!.phones).toEqual([
      { number: "+55 (19) 99123-4567", label: "celular" },
      { number: "(19) 3232-1000", label: "trabalho" },
    ]);
    expect(list[2]!.phones.map((p) => p.number)).toEqual(["011 98888-7777", "+1 415 555 0100"]);
  });

  it("número de WhatsApp: com DDI, sem DDI, com 0 do DDD; 0800 e curto ficam de fora", async () => {
    const { cleanContactPhone } = await import("../src/phonebook.js");
    expect(cleanContactPhone("+55 (19) 99123-4567")).toBe("5519991234567");
    expect(cleanContactPhone("(19) 99123-4567")).toBe("5519991234567");
    expect(cleanContactPhone("011 98888-7777")).toBe("5511988887777");
    expect(cleanContactPhone("+1 415 555 0100")).toBe("14155550100");
    expect(cleanContactPhone("0800 777 1234")).toBeNull();
    expect(cleanContactPhone("190")).toBeNull();
  });
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("agenda de contatos (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let pb: typeof import("../src/phonebook.js");
  let user: any;
  let other: any;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    pb = await import("../src/phonebook.js");
    const { upsertUser } = await import("../src/ingest.js");
    user = await upsertUser("5519955551111", "Rita");
    other = await upsertUser("5519955552222", "Outra");
  });

  afterAll(async () => {
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("importa, não duplica o mesmo número e busca sem acento", async () => {
    const first = await pb.importContacts(user.id, pb.parseVcf(`${IPHONE}\n${ANDROID}`), "vcf");
    // Ana: 2 números; João: 2; Pizzaria (só 0800) fica de fora; sem número nem entra na lista
    expect(first).toMatchObject({ saved: 4, added: 4, skipped: 1 });
    const again = await pb.importContacts(user.id, [{ name: "Ana Souza", phones: [{ number: "19991234567" }] }], "celular");
    expect(again).toMatchObject({ saved: 1, added: 0 });
    expect((await pb.listPhonebook(user.id, "")).total).toBe(4);
    expect((await pb.searchContacts(user.id, "joao conceicao")).map((c) => c.phone)).toEqual(expect.arrayContaining(["5511988887777", "14155550100"]));
    expect((await pb.searchContacts(user.id, "ana"))[0]).toMatchObject({ name: "Ana Souza", phone: "5519991234567" });
    expect((await pb.searchContacts(user.id, "3232"))[0]).toMatchObject({ phone: "551932321000" });
    // a agenda é de cada um
    expect(await pb.searchContacts(other.id, "ana")).toEqual([]);
  });

  it("o agente procura pelo nome e salva número novo", async () => {
    const { contactsSearch, contactSave } = await import("../src/agent/tools/direct.js");
    const ctx: any = { user };
    const ana: any = await contactsSearch.run({ query: "Ana" }, ctx);
    expect(ana.contacts[0]).toEqual({ name: "Ana Souza", phone: "5519991234567", label: "celular" });
    expect(ana.contacts[1]).toMatchObject({ name: "Ana Paula Souza", label: "trabalho" });
    expect(await contactsSearch.run({ query: "Beto" }, ctx)).toMatchObject({ contacts: [] });
    expect(await contactSave.run({ name: "Beto Encanador", phone: "(19) 98765-4321" }, ctx)).toMatchObject({ ok: true, phone: "5519987654321" });
    expect(await contactSave.run({ name: "X", phone: "123" }, ctx)).toMatchObject({ ok: false });
    expect(((await contactsSearch.run({ query: "encanador" }, ctx)) as any).contacts[0].phone).toBe("5519987654321");
  });

  it("apagar um e apagar tudo", async () => {
    const [ana] = await pb.searchContacts(user.id, "ana");
    await pb.deleteContact(other.id, ana!.id);
    expect((await pb.listPhonebook(user.id, "")).total).toBe(5);
    await pb.deleteContact(user.id, ana!.id);
    expect((await pb.listPhonebook(user.id, "")).total).toBe(4);
    await pb.clearPhonebook(user.id);
    expect((await pb.listPhonebook(user.id, "")).total).toBe(0);
  });
});
