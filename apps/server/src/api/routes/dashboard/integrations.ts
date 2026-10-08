import type { FastifyInstance } from "fastify";
import { config } from "../../../config.js";
import { internalKey } from "../../../events.js";
import { googleAuthUrl, googleExchangeCode, googleRedirectUri } from "../../../integrations/google.js";
import { mercadolivreAuthUrl, mercadolivreExchangeCode } from "../../../integrations/mercadolivre.js";
import { disconnect, getDef, isConnected, listIntegrations, rawCredentials, saveCredentials, setEnabled } from "../../../integrations/registry.js";
import { setupTelegram } from "../../../telegram.js";
import { isOauthState, newOauthState } from "./shared.js";

/** Callbacks de OAuth: públicos, sem cookie de API garantido; valem pelo state assinado. */
export function integrationCallbackRoutes(app: FastifyInstance) {
  // Callback do OAuth do Google vem do navegador sem cookie de API garantido: valida pelo state assinado.
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/integrations/google/oauth/callback", async (req, reply) => {
    if (req.query.error) return reply.redirect(`/integrations?error=${encodeURIComponent(req.query.error)}`);
    if (!isOauthState(req.query.state)) return reply.code(400).send("state inválido");
    try {
      await googleExchangeCode(req.query.code ?? "");
      return reply.redirect("/integrations?connected=google");
    } catch (err) {
      return reply.redirect(`/integrations?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/api/integrations/mercadolivre/oauth/callback", async (req, reply) => {
    if (req.query.error) return reply.redirect(`/integrations?error=${encodeURIComponent(req.query.error)}`);
    if (!isOauthState(req.query.state)) return reply.code(400).send("state inválido");
    try {
      await mercadolivreExchangeCode(req.query.code ?? "");
      return reply.redirect("/integrations?connected=mercadolivre");
    } catch (err) {
      return reply.redirect(`/integrations?error=${encodeURIComponent((err as Error).message)}`);
    }
  });
}

/** Integrações (só super admin): credenciais, teste, liga/desliga e início do OAuth. */
export function integrationRoutes(api: FastifyInstance) {
  // ---------- Integrações ----------
  api.get("/api/integrations", async () => ({
    integrations: await listIntegrations(),
    googleRedirectUri: googleRedirectUri(),
  }));

  api.put<{ Params: { id: string }; Body: Record<string, string> }>("/api/integrations/:id", async (req, reply) => {
    const def = getDef(req.params.id);
    if (!def) return reply.code(404).send({ error: "integração desconhecida" });
    const creds: Record<string, string> = {};
    const current = await rawCredentials(def.id);
    for (const f of def.fields) {
      const v = req.body?.[f.key];
      // campo de senha vazio no formulário = manter o valor salvo
      if (v != null && v !== "") creds[f.key] = String(v).trim();
      else if (f.required && !current[f.key]) return reply.code(400).send({ error: `${f.label} é obrigatório` });
    }
    if (def.test) {
      try {
        let message = await def.test({ ...current, ...creds });
        await saveCredentials(def.id, creds);
        if (def.id === "telegram") message = await setupTelegram();
        return { ok: true, message };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    await saveCredentials(def.id, creds);
    return { ok: true, message: def.oauth ? "Credenciais salvas. Agora clique em Conectar com Google." : "Salvo" };
  });

  // n8n: o que colar no n8n para ele falar com a plataforma
  api.get("/api/integrations/n8n/info", async () => ({
    base_url: config.PUBLIC_URL.replace(/\/$/, ""),
    key: internalKey() || null,
    key_from_env: Boolean(config.INTERNAL_API_KEY),
    disabled: !internalKey(),
    endpoints: [
      ["GET", "/api/internal/ping", "Testa a chave"],
      ["GET", "/api/internal/users?phone=", "Busca pessoa (e login do painel)"],
      ["POST", "/api/internal/users", "Cria ou reativa pessoa; com email e password cria o login"],
      ["PATCH", "/api/internal/users", "Troca senha, nome ou status (active/blocked)"],
      ["POST", "/api/internal/send", "Manda texto, imagem, vídeo ou PDF no canal da pessoa"],
      ["POST", "/api/internal/agent", "Pede ao assistente para falar com a pessoa do jeito dele"],
      ["POST", "/api/internal/transactions", "Lança gasto ou receita"],
      ["GET", "/api/internal/finance?phone=&month=", "Resumo do mês"],
    ],
    events: ["user.created", "user.activated", "transaction.created", "budget.alert", "reminder.fired", "telegram.linked"],
  }));

  api.post<{ Params: { id: string } }>("/api/integrations/:id/test", async (req, reply) => {
    const def = getDef(req.params.id);
    if (!def) return reply.code(404).send({ error: "integração desconhecida" });
    if (!(await isConnected(def.id))) return reply.code(400).send({ error: "Não conectada" });
    if (!def.test) return { ok: true, message: "Conectada (sem teste automático)" };
    try {
      return { ok: true, message: await def.test(await rawCredentials(def.id)) };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  api.patch<{ Params: { id: string }; Body: { enabled: boolean } }>("/api/integrations/:id", async (req) => {
    await setEnabled(req.params.id, Boolean(req.body.enabled));
    return { ok: true };
  });

  api.delete<{ Params: { id: string } }>("/api/integrations/:id", async (req) => {
    await disconnect(req.params.id);
    return { ok: true };
  });

  api.get("/api/integrations/mercadolivre/oauth/start", async () => {
    const state = newOauthState();
    return { url: await mercadolivreAuthUrl(state) };
  });

  api.get("/api/integrations/google/oauth/start", async () => {
    const state = newOauthState();
    return { url: await googleAuthUrl(state) };
  });
}
