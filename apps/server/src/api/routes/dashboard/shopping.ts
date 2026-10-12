import type { FastifyInstance } from "fastify";
import { one } from "../../../db/pool.js";
import { isConnected } from "../../../integrations/registry.js";
import { hit } from "../../../ratelimit.js";
import { selfUserId } from "../../../sharing.js";
import { addItem, listItems, markBought, removeItem, searchOffers, setItemAlert } from "../../../shopping.js";
import { conversationOf } from "../../../social.js";
import { isUuid } from "./shared.js";

const fail = (reply: any, err: unknown) => reply.code(400).send({ error: (err as Error).message });
/** Buscas pela tela por pessoa em 1 hora: cada uma chama as APIs das lojas. */
const SEARCHES_PER_HOUR = 40;

/** Compras de quem está logado: busca comparada nas lojas e a lista de compras com aviso de preço. */
export function shoppingRoutes(base: FastifyInstance) {
  const uidOf = async (req: any, reply: any) => {
    const uid = await selfUserId(req.account);
    if (!uid) reply.code(400).send({ error: "Conta sem WhatsApp ligado" });
    return uid;
  };

  base.get("/api/compras", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    const [items, ml, shopee, tavily, brave] = await Promise.all([
      listItems(uid),
      isConnected("mercadolivre"),
      isConnected("shopee"),
      isConnected("tavily"),
      isConnected("brave"),
    ]);
    return { items, stores: { "Mercado Livre": ml, Shopee: shopee }, web: tavily || brave };
  });

  base.get<{ Querystring: { q?: string; condition?: string; max?: string } }>("/api/compras/busca", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    if ((await hit(`compras:busca:${uid}`, 3600)) > SEARCHES_PER_HOUR) return reply.code(429).send({ error: "Muitas buscas seguidas. Tente de novo daqui a pouco." });
    const max = Number(req.query.max);
    try {
      // pela tela, a busca web só entra com chave (Tavily/Brave): a busca pela IA fica para o WhatsApp, onde passa pelo Tracer
      const { _usage, ...r } = await searchOffers(req.query.q ?? "", {
        limit: 12,
        condition: req.query.condition === "used" ? "used" : req.query.condition === "new" ? "new" : undefined,
        maxCents: Number.isFinite(max) && max > 0 ? Math.round(max * 100) : undefined,
        web: "keys",
      });
      return r;
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.post<{ Body: { title?: string; store?: string; cents?: number; link?: string; image?: string; query?: string; alert?: boolean } }>(
    "/api/compras/lista",
    async (req, reply) => {
      const uid = await uidOf(req, reply);
      if (!uid) return;
      const b = req.body ?? {};
      try {
        const item = await addItem(uid, { title: b.title ?? "", store: b.store, cents: b.cents, link: b.link, image: b.image, query: b.query });
        if (b.alert) await setItemAlert(uid, item.id, await convOf(uid), { on: true });
        return item;
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  base.patch<{ Params: { id: string }; Body: { bought?: boolean; alert?: boolean; alert_below?: number | null } }>("/api/compras/lista/:id", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Item não encontrado." });
    const b = req.body ?? {};
    try {
      if (b.bought !== undefined && !(await markBought(uid, req.params.id, Boolean(b.bought)))) return reply.code(404).send({ error: "Item não encontrado." });
      if (b.alert !== undefined || b.alert_below !== undefined) {
        const below = b.alert_below != null && Number(b.alert_below) > 0 ? Math.round(Number(b.alert_below) * 100) : null;
        const r = await setItemAlert(uid, req.params.id, await convOf(uid), { on: b.alert ?? true, belowCents: below });
        if (!r) return reply.code(404).send({ error: "Item não encontrado." });
      }
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  base.delete<{ Params: { id: string } }>("/api/compras/lista/:id", async (req, reply) => {
    const uid = await uidOf(req, reply);
    if (!uid) return;
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "Item não encontrado." });
    return { ok: await removeItem(uid, req.params.id) };
  });
}

/** Os avisos de preço vão para a conversa da pessoa no WhatsApp. */
async function convOf(uid: string) {
  const u = await one("SELECT id, phone FROM users WHERE id = $1", [uid]);
  return (await conversationOf(u.id, u.phone)).conv.id as string;
}
