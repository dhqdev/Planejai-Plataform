import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

/** Arquivos fora do banco: S3 falso (http local) que confere a assinatura SigV4 e guarda os objetos em memória. */
const SECRET = "segredo-de-teste-nao-vale-nada";
const objects = new Map<string, { body: Buffer; type: string }>();
const seen: string[] = [];
let server: Server;

const sha = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();

function validSignature(method: string, path: string, headers: Record<string, any>, body: Buffer) {
  const auth = String(headers.authorization ?? "");
  const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
  if (!m || m[1] !== "AKTESTE") return false;
  const [, , day, region, signed, sig] = m;
  if (headers["x-amz-content-sha256"] !== sha(body)) return false;
  const names = signed!.split(";");
  const canonical = [method, path, "", ...names.map((n) => `${n}:${String(headers[n]).trim()}`), "", signed, sha(body)].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", headers["x-amz-date"], `${day}/${region}/s3/aws4_request`, sha(canonical)].join("\n");
  let k: Buffer = hmac(`AWS4${SECRET}`, day!);
  for (const p of [region!, "s3", "aws4_request"]) k = hmac(k, p);
  return createHmac("sha256", k).update(toSign).digest("hex") === sig;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = req.url ?? "/";
      seen.push(`${req.method} ${path}`);
      if (!validSignature(req.method!, path, req.headers, body)) {
        res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
        return;
      }
      if (req.method === "PUT") {
        objects.set(path, { body, type: String(req.headers["content-type"] ?? "") });
        res.writeHead(200).end();
      } else if (req.method === "GET") {
        const o = objects.get(path);
        if (!o) res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
        else res.writeHead(200, { "Content-Type": o.type }).end(o.body);
      } else if (req.method === "DELETE") {
        objects.delete(path);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  Object.assign(config, {
    STORAGE_S3_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    STORAGE_S3_BUCKET: "planejai",
    STORAGE_S3_REGION: "auto",
    STORAGE_S3_ACCESS_KEY_ID: "AKTESTE",
    STORAGE_S3_SECRET_ACCESS_KEY: SECRET,
  });
});

afterAll(async () => {
  Object.assign(config, { STORAGE_S3_ENDPOINT: "", STORAGE_S3_BUCKET: "", STORAGE_S3_ACCESS_KEY_ID: "", STORAGE_S3_SECRET_ACCESS_KEY: "" });
  await new Promise((r) => server?.close(r));
});

describe("storage S3 (SigV4 à mão)", () => {
  it("put, get e delete com assinatura válida", async () => {
    const s = await import("../src/storage.js");
    expect(s.storageEnabled()).toBe(true);
    const data = Buffer.from("conteúdo do arquivo ✓");
    await s.putObject("teste/a b(1).txt", data, "text/plain");
    expect(objects.get("/planejai/teste/a%20b%281%29.txt")?.type).toBe("text/plain");
    expect((await s.getObject("teste/a b(1).txt")).equals(data)).toBe(true);
    await s.deleteObject("teste/a b(1).txt");
    expect(objects.size).toBe(0);
    await s.deleteObject("teste/nao-existe");
    await expect(s.getObject("teste/nao-existe")).rejects.toThrow(/404 NoSuchKey/);
  });

  it("assinatura errada vira erro sem vazar o segredo", async () => {
    const s = await import("../src/storage.js");
    const real = config.STORAGE_S3_SECRET_ACCESS_KEY;
    config.STORAGE_S3_SECRET_ACCESS_KEY = "outro-segredo";
    try {
      const err = (await s.putObject("x", Buffer.from("1")).catch((e) => e)) as Error;
      expect(err.message).toMatch(/403 SignatureDoesNotMatch/);
      expect(err.message).not.toContain("outro-segredo");
    } finally {
      config.STORAGE_S3_SECRET_ACCESS_KEY = real;
    }
  });
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("documentos e mídias no bucket (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let ana: any;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    ana = await upsertUser("5519933330001", "Ana");
    objects.clear();
  });

  it("documento novo vai pro bucket, a linha guarda só a chave, e apagar tira o objeto", async () => {
    const docs = await import("../src/documents.js");
    const pdf = Buffer.from("%PDF-1.4 conteúdo de teste");
    const saved = await docs.saveDocument({ userId: ana.id, name: "contrato", mimetype: "application/pdf", data: pdf });
    const row = await db.one("SELECT data, storage_key, size FROM documents WHERE id = $1", [saved.id]);
    expect(row.data).toBeNull();
    expect(row.storage_key).toBe(`documents/${ana.id}/${saved.id}`);
    expect(row.size).toBe(pdf.length);
    expect(objects.get(`/planejai/documents/${ana.id}/${saved.id}`)?.body.equals(pdf)).toBe(true);

    const got = await docs.getDocument(saved.id, ana.id);
    expect(got?.data.equals(pdf)).toBe(true);
    expect((await docs.documentUsage(ana.id)).bytes).toBe(pdf.length);

    expect(await docs.deleteDocument(saved.id, ana.id)).toBe(true);
    expect(objects.has(`/planejai/documents/${ana.id}/${saved.id}`)).toBe(false);
    expect((await db.one("SELECT count(*)::int AS n FROM storage_trash")).n).toBe(0);
  });

  it("limpeza de hora em hora leva o bytea antigo pro bucket e a leitura continua igual", async () => {
    const old = Buffer.from("arquivo antigo no banco");
    const doc = await db.one("INSERT INTO documents (user_id, name, mimetype, size, data) VALUES ($1, 'velho.txt', 'text/plain', $2, $3) RETURNING id", [
      ana.id,
      old.length,
      old,
    ]);
    const media = await db.one("INSERT INTO media_files (user_id, kind, mimetype, size, data) VALUES ($1, 'screenshot', 'image/png', 3, $2) RETURNING id", [
      ana.id,
      Buffer.from([1, 2, 3]),
    ]);
    const { moveBlobsToStorage } = await import("../src/storage.js");
    expect(await moveBlobsToStorage(50)).toBe(2);
    expect(await moveBlobsToStorage(50)).toBe(0);
    const row = await db.one("SELECT data, storage_key FROM documents WHERE id = $1", [doc.id]);
    expect(row.data).toBeNull();
    expect(objects.get(`/planejai/media/${media.id}`)?.body.equals(Buffer.from([1, 2, 3]))).toBe(true);
    const { getDocument } = await import("../src/documents.js");
    expect((await getDocument(doc.id, ana.id))?.data.equals(old)).toBe(true);
  });

  it("apagar a pessoa (LGPD) tira os arquivos dela do bucket, inclusive os que saem em cascata", async () => {
    const { saveDocument } = await import("../src/documents.js");
    await saveDocument({ userId: ana.id, name: "rg.png", mimetype: "image/png", data: Buffer.from("png") });
    expect(objects.size).toBeGreaterThan(0);
    const { eraseUserData } = await import("../src/privacy.js");
    expect((await eraseUserData(ana.id)).ok).toBe(true);
    expect(objects.size).toBe(0);
    expect((await db.one("SELECT count(*)::int AS n FROM storage_trash")).n).toBe(0);
  });
});
