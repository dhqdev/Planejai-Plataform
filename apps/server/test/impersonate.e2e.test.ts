import { describe, expect, it } from "vitest";
import { buildServer, IMPERSONATE_COOKIE } from "../src/api/server.js";
import { query, one } from "../src/db/pool.js";
import { hashPassword } from "../src/accounts.js";
import { config } from "../src/config.js";

const testDb = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDb)("Impersonate E2E", () => {
  it("permite superadmin assumir conta de cliente e voltar", async () => {
    const app = await buildServer();

    // Cria usuário e conta de cliente
    const user = await one(
      "INSERT INTO users (phone, name, full_name, email, status) VALUES ('5511999990001', 'Cliente Teste', 'Cliente Teste', 'cliente@teste.com', 'active') RETURNING id",
    );
    const account = await one(
      "INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ('cliente@teste.com', 'Cliente Teste', $1, 'admin', 'active', $2, '5511999990001') RETURNING id",
      [hashPassword("senha12345"), user.id],
    );

    // 1. Login como dono (superadmin)
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD },
    });
    expect(loginRes.statusCode).toBe(200);
    const sessionCookie = loginRes.cookies.find((c) => c.name === "pj_session");
    expect(sessionCookie).toBeDefined();

    const cookieHeader = `pj_session=${sessionCookie!.value}`;

    // 2. Impersonar cliente
    const impRes = await app.inject({
      method: "POST",
      url: `/api/clients/${user.id}/impersonate`,
      headers: { cookie: cookieHeader },
    });
    expect(impRes.statusCode).toBe(200);
    const impCookie = impRes.cookies.find((c) => c.name === IMPERSONATE_COOKIE);
    expect(impCookie).toBeDefined();
    expect(impCookie!.value).toBe(account.id);

    // 3. /api/auth/me agora retorna a conta do cliente com flag de impersonating
    const dualCookieHeader = `${cookieHeader}; ${IMPERSONATE_COOKIE}=${impCookie!.value}`;
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: dualCookieHeader },
    });
    expect(meRes.statusCode).toBe(200);
    const meData = meRes.json();
    expect(meData.id).toBe(account.id);
    expect(meData.impersonating).toEqual({ name: "Dono" });

    // 4. Auditoria gravada na tabela impersonations
    const auditRow = await one(
      "SELECT * FROM impersonations WHERE target_user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [user.id],
    );
    expect(auditRow).toBeDefined();
    expect(auditRow.target_account_id).toBe(account.id);

    // 5. Parar impersonação via stop-impersonate
    const stopRes = await app.inject({
      method: "POST",
      url: "/api/auth/stop-impersonate",
      headers: { cookie: dualCookieHeader },
    });
    expect(stopRes.statusCode).toBe(200);

    // Sem o cookie de impersonate, /api/auth/me volta a devolver o dono
    const backMeRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieHeader },
    });
    expect(backMeRes.statusCode).toBe(200);
    expect(backMeRes.json().role).toBe("superadmin");
    expect(backMeRes.json().impersonating).toBeNull();

    // 6. Chamada por conta comum (não superadmin) é bloqueada com 403
    const clientLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "cliente@teste.com", password: "senha12345" },
    });
    const clientSessionCookie = clientLogin.cookies.find((c) => c.name === "pj_session");
    const clientReq = await app.inject({
      method: "POST",
      url: `/api/clients/${user.id}/impersonate`,
      headers: { cookie: `pj_session=${clientSessionCookie!.value}` },
    });
    expect(clientReq.statusCode).toBe(403);

    // Cleanup
    await query("DELETE FROM accounts WHERE id = $1", [account.id]);
    await query("DELETE FROM users WHERE id = $1", [user.id]);
    await app.close();
  });
});
