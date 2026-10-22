import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { availability, book, bookingByToken, BookingError, cancelByClient, getPage, pageBySlug, publicPage, slugify, tzOf } from "../../booking.js";
import { config } from "../../config.js";
import { hit } from "../../ratelimit.js";

/**
 * Link público de agendamento, sem login: /agendar/<slug> (página da pessoa) e /agendar/horario/<token> (o cliente vê
 * e desmarca o horário dele). O HTML sai com título e descrição da página no <head>, para a prévia do link no
 * Instagram e no WhatsApp.
 */
export async function registerBookingRoutes(app: FastifyInstance) {
  const tooMany = (reply: any) => reply.code(429).send({ error: "Muitas tentativas. Espere um pouco e tente de novo." });

  app.get<{ Params: { slug: string } }>("/api/agendar/:slug", async (req, reply) => {
    const p = await pageBySlug(req.params.slug);
    return p ? publicPage(p) : reply.code(404).send({ error: "Essa agenda não existe ou está fechada" });
  });

  app.get<{ Params: { slug: string }; Querystring: { servico?: string } }>("/api/agendar/:slug/horarios", async (req, reply) => {
    if ((await hit(`agendar:ver:${req.ip}`, 60)) > 60) return tooMany(reply);
    const p = await pageBySlug(req.params.slug);
    if (!p) return reply.code(404).send({ error: "Essa agenda não existe ou está fechada" });
    const a = await availability(p, String(req.query.servico ?? ""));
    return { service: a.service?.id ?? null, tz: a.tz, days: a.days };
  });

  app.post<{ Params: { slug: string }; Body: Record<string, string> }>("/api/agendar/:slug", async (req, reply) => {
    if ((await hit(`agendar:ip:${req.ip}`, 3600)) > 8) return tooMany(reply);
    const p = await pageBySlug(req.params.slug);
    if (!p) return reply.code(404).send({ error: "Essa agenda não existe ou está fechada" });
    try {
      const b = await book(p, req.body ?? {});
      return { ok: true, token: b.token, service: b.service, start: b.start_at, end: b.end_at };
    } catch (err) {
      if (err instanceof BookingError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  const view = async (token: string) => {
    const b = await bookingByToken(token);
    if (!b) return null;
    const p = await getPage(b.user_id);
    return {
      title: p?.title ?? "Agenda",
      slug: p?.enabled ? p.slug : null,
      service: b.service,
      start: b.start_at,
      end: b.end_at,
      name: b.client_name.split(/\s+/)[0],
      status: b.status,
      tz: await tzOf(b.user_id),
      cancelled_by: b.cancelled_by,
      can_cancel: b.status === "confirmado" && new Date(b.start_at).getTime() > Date.now(),
    };
  };

  app.get<{ Params: { token: string } }>("/api/agendar/horario/:token", async (req, reply) => {
    if ((await hit(`agendar:token:${req.ip}`, 300)) > 60) return tooMany(reply);
    const v = await view(req.params.token);
    return v ?? reply.code(404).send({ error: "Não achei esse horário" });
  });

  app.post<{ Params: { token: string } }>("/api/agendar/horario/:token/desmarcar", async (req, reply) => {
    if ((await hit(`agendar:token:${req.ip}`, 300)) > 60) return tooMany(reply);
    await cancelByClient(req.params.token);
    const v = await view(req.params.token);
    return v ?? reply.code(404).send({ error: "Não achei esse horário" });
  });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
let indexCache: { file: string; mtime: number; html: string } | null = null;

/** /agendar/<slug>: o index do app com o nome da agenda no <head> (prévia do link na bio e no WhatsApp). */
export async function bookingPageHtml(publicDir: string, url: string): Promise<string | null> {
  const path = url.split("?")[0]!.replace(/\/+$/, "");
  const m = path.match(/^\/agendar\/([^/]+)$/);
  if (!m || m[1] === "horario") return null;
  const p = await pageBySlug(decodeURIComponent(m[1]!).slice(0, 60));
  if (!p) return null;
  const file = join(publicDir, "index.html");
  const mtime = statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  if (mtime == null) return null;
  if (!indexCache || indexCache.mtime !== mtime || indexCache.file !== file) indexCache = { file, mtime, html: readFileSync(file, "utf8") };
  const title = `Agende com ${p.title}`;
  const description = p.about || `Escolha o dia e o horário que ficam melhores para você. ${p.services.map((s) => s.name).join(", ")}.`.slice(0, 200);
  const canonical = `${config.PUBLIC_URL.replace(/\/$/, "")}/agendar/${slugify(p.slug)}`;
  const head =
    `<meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(canonical)}">` +
    `<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">` +
    `<meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}">`;
  return indexCache.html
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, "")
    .replace("</head>", `${head}</head>`);
}
