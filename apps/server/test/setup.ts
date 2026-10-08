import { Redis } from "ioredis";

// Rodar a suíte duas vezes seguidas não pode falhar por sobra da anterior (limite de login, convites, conversas).
if (process.env.REDIS_URL) {
  const r = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", "pj:*", "COUNT", 500);
      if (keys.length) await r.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  } catch {
    // sem Redis de teste: os testes que dependem dele já se desligam sozinhos
  } finally {
    r.disconnect();
  }
}
