import type { FastifyInstance } from "fastify";
import { requireAuth, requireSuper } from "../server.js";
import { accountRoutes } from "./dashboard/accounts.js";
import { agendaRoutes } from "./dashboard/agenda.js";
import { alarmActionRoutes, alarmRoutes } from "./dashboard/alarms.js";
import { billingAdminRoutes, billingRoutes } from "./dashboard/billing.js";
import { clientRoutes } from "./dashboard/clients.js";
import { errandRoutes } from "./dashboard/errands.js";
import { executionRoutes } from "./dashboard/executions.js";
import { financeRoutes } from "./dashboard/finance.js";
import { integrationCallbackRoutes, integrationRoutes } from "./dashboard/integrations.js";
import { inviteRoutes } from "./dashboard/invites.js";
import { meRoutes } from "./dashboard/me.js";
import { memoryRoutes } from "./dashboard/memories.js";
import { resourceRoutes } from "./dashboard/resources.js";
import { settingsRoutes } from "./dashboard/settings.js";
import { teamAdminRoutes, teamRoutes } from "./dashboard/team.js";
import { whatsappRoutes } from "./dashboard/whatsapp.js";

/**
 * Rotas do painel, em três níveis de acesso. Cada domínio fica num módulo de dashboard/ e só registra rotas:
 * quem decide o acesso é o nível em que o módulo é montado aqui.
 */
export async function registerDashboardRoutes(app: FastifyInstance) {
  // Sem login: quem valida é o state assinado
  integrationCallbackRoutes(app);
  alarmActionRoutes(app);

  await app.register(async (base) => {
    base.addHook("preHandler", requireAuth);

    // ================= Rotas com escopo: super admin vê tudo, admin só os próprios dados =================
    meRoutes(base);
    financeRoutes(base);
    inviteRoutes(base);
    agendaRoutes(base);
    errandRoutes(base);
    alarmRoutes(base);
    memoryRoutes(base);
    teamRoutes(base);
    billingRoutes(base);

    // ================= Só super admin =================
    await base.register(async (api) => {
      api.addHook("preHandler", requireSuper);

      accountRoutes(api);
      executionRoutes(api);
      clientRoutes(api);
      teamAdminRoutes(api);
      integrationRoutes(api);
      settingsRoutes(api);
      whatsappRoutes(api);
      billingAdminRoutes(api);
      resourceRoutes(api);
    });
  });
}
