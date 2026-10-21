import { createHash, randomBytes } from "node:crypto";
import { brl } from "./agent/tools/finance.js";
import { Tracer } from "./agent/trace.js";
import { type RobotIO, type UberCookie, type UberOption, UberRobot, UberScreenError, extractCode } from "./agent/uber-robot.js";
import { config } from "./config.js";
import { decryptJson, encryptJson } from "./crypto.js";
import { many, one, query } from "./db/pool.js";
import { isOwner } from "./ingest.js";
import { asPerson } from "./integrations/person.js";
import { QUEUES, getBoss } from "./queue/boss.js";
import { getSettings } from "./settings.js";

/**
 * Uber pelo WhatsApp (beta). O Juvenal só enfileira; quem abre o Chrome é a fila "uber.run", que roda só na parte
 * do canal (uma réplica) com UBER_CONCURRENCY corridas por vez no total e no máximo uma por pessoa (singletonKey).
 * Assim o Chrome do browserless nunca enche por causa da Uber, por mais gente que peça junto: o resto espera a vez
 * e a pessoa sabe quantos estão na frente.
 *
 * Fluxo: uber_quote -> job "quote" (entra, preenche a rota, lê as opções e manda a lista no WhatsApp, sem IA)
 * -> a pessoa escolhe -> uber_request (pede o "sim" com o resumo do servidor) -> job "request" (refaz a rota, confere
 * o preço e só pede se não subiu mais de 10%) -> manda o motorista e a placa.
 * Código do login: e-mail sai sozinho pelo Gmail ligado; SMS chega pelo Atalho do iPhone (/api/uber/codigo) ou a pessoa
 * manda no WhatsApp, e o ingest entrega direto ao robô (handleUberCode), sem passar pelo modelo.
 */

export type UberJob = { rideId: string; action: "quote" | "request" };
export type UberAccess = "off" | "owner" | "all";

/** Avisos fixos da beta: a pessoa sempre sabe que é teste. */
export const BETA_NOTE = "(Uber pelo Planejai ainda é beta, estamos testando)";
/** escolha velha: depois disso a cotação vale de novo antes de pedir */
const OPTIONS_TTL_MIN = 10;
/** subiu mais que isso desde a cotação: mostra o preço novo e pede outro sim */
export const PRICE_TOLERANCE = 0.1;
/** quanto tempo o robô espera um código (o job segura uma vaga da fila nesse tempo) */
const CODE_WAIT_MS = () => config.UBER_CODE_WAIT_SECONDS * 1000;

export async function uberAccess(): Promise<UberAccess> {
  return (await getSettings()).uberAccess;
}

/** Liberado para esta pessoa? (beta: o dono escolhe em Configurações se é só ele ou todo mundo) */
export async function uberAllowed(user: { phone: string }) {
  const a = await uberAccess();
  return a === "all" || (a === "owner" && isOwner(user.phone));
}

/** Link que abre o app da Uber com origem e destino prontos: plano B quando o robô não passa (ou a beta está desligada). */
export function uberLink(pickup?: string | null, dropoff?: string | null) {
  const q = new URLSearchParams({ action: "setPickup" });
  if (pickup?.trim()) q.set("pickup[formatted_address]", pickup.trim());
  else q.set("pickup", "my_location");
  if (dropoff?.trim()) q.set("dropoff[formatted_address]", dropoff.trim());
  return `https://m.uber.com/ul/?${q}`;
}

// ---------------- sessão ----------------

async function loadCookies(userId: string): Promise<UberCookie[] | null> {
  const row = await one<{ state_enc: string | null }>("SELECT state_enc FROM uber_sessions WHERE user_id = $1", [userId]);
  if (!row?.state_enc) return null;
  try {
    return decryptJson<{ cookies: UberCookie[] }>(row.state_enc).cookies ?? null;
  } catch {
    return null;
  }
}

async function saveCookies(userId: string, cookies: UberCookie[], logged: boolean) {
  await query(
    `INSERT INTO uber_sessions (user_id, state_enc, status, logged_at, last_used_at) VALUES ($1, $2, 'ok', CASE WHEN $3 THEN now() END, now())
     ON CONFLICT (user_id) DO UPDATE SET state_enc = $2, status = 'ok', logged_at = CASE WHEN $3 THEN now() ELSE uber_sessions.logged_at END,
       last_used_at = now(), updated_at = now()`,
    [userId, encryptJson({ cookies }), logged],
  );
}

/** "Esquece minha Uber": apaga os cookies e o Atalho. */
export async function forgetUber(userId: string) {
  const r = await query("DELETE FROM uber_sessions WHERE user_id = $1", [userId]);
  return (r.rowCount ?? 0) > 0;
}

export async function uberSessionInfo(userId: string) {
  return one<{ status: string; logged_at: string | null; last_used_at: string | null; shortcut: boolean }>(
    "SELECT status, logged_at, last_used_at, shortcut_hash IS NOT NULL AS shortcut FROM uber_sessions WHERE user_id = $1",
    [userId],
  );
}

// ---------------- códigos ----------------

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** Token do Atalho do iPhone/Android que encaminha o SMS da Uber. Um por pessoa: gerar de novo invalida o anterior. */
export async function newShortcutToken(userId: string) {
  const token = randomBytes(24).toString("base64url");
  await query(
    `INSERT INTO uber_sessions (user_id, shortcut_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET shortcut_hash = $2, updated_at = now()`,
    [userId, sha(token)],
  );
  return token;
}

export function shortcutUrl(token: string) {
  return `${config.PUBLIC_URL.replace(/\/$/, "")}/api/uber/codigo?t=${encodeURIComponent(token)}`;
}

async function setWaiting(userId: string, kind: "sms" | "email" | null) {
  await query(
    `INSERT INTO uber_sessions (user_id, waiting_code, waiting_since) VALUES ($1, $2, CASE WHEN $2::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (user_id) DO UPDATE SET waiting_code = $2, waiting_since = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, code_enc = NULL, updated_at = now()`,
    [userId, kind],
  );
}

/** Guarda o código para o robô, se ele estiver esperando um (de 5 min para cá). */
async function deliverCode(userId: string, code: string) {
  const r = await query(
    `UPDATE uber_sessions SET code_enc = $2, updated_at = now()
      WHERE user_id = $1 AND waiting_code IS NOT NULL AND waiting_since > now() - interval '5 minutes'`,
    [userId, encryptJson({ code })],
  );
  return (r.rowCount ?? 0) > 0;
}

async function takeCode(userId: string): Promise<string | null> {
  const row = await one<{ code_enc: string | null }>(
    `WITH old AS (SELECT user_id, code_enc FROM uber_sessions WHERE user_id = $1 AND code_enc IS NOT NULL FOR UPDATE)
     UPDATE uber_sessions s SET code_enc = NULL FROM old WHERE s.user_id = old.user_id RETURNING old.code_enc`,
    [userId],
  );
  if (!row?.code_enc) return null;
  try {
    return decryptJson<{ code: string }>(row.code_enc).code;
  } catch {
    return null;
  }
}

/**
 * Mensagem que é só um código (4 a 6 dígitos) enquanto o robô espera: vai direto para ele e não entra na conversa
 * (nem no modelo, nem no histórico). Chamado pelo ingest antes de guardar a mensagem.
 */
export async function handleUberCode(userId: string, text: string | null | undefined) {
  const m = String(text ?? "").match(/^\s*(\d{4,6})\s*$/);
  if (!m) return false;
  return deliverCode(userId, m[1]!);
}

/** SMS encaminhado pelo Atalho: acha o código no texto e entrega, se o robô estiver esperando. */
export async function handleShortcutCode(token: string, text: string) {
  if (!token || token.length < 20) return { ok: false as const, error: "token" };
  const row = await one<{ user_id: string }>("SELECT user_id FROM uber_sessions WHERE shortcut_hash = $1", [sha(token)]);
  if (!row) return { ok: false as const, error: "token" };
  // o Atalho manda qualquer SMS que cita a Uber: só o que tem cara de código de verificação
  const code = /uber/i.test(text) ? extractCode(text) : null;
  if (!code) return { ok: true as const, used: false };
  return { ok: true as const, used: await deliverCode(row.user_id, code) };
}

/** Código que a Uber mandou para o Gmail ligado da pessoa (null se não tem Gmail ou não chegou). */
async function codeFromGmail(since: number): Promise<string | null> {
  const { isConnected } = await import("./integrations/registry.js");
  if (!(await isConnected("google"))) return null;
  const { googleApi } = await import("./integrations/google.js");
  const { GMAIL, bodyText } = await import("./agent/tools/communication.js");
  const list = await googleApi(`${GMAIL}/messages?q=${encodeURIComponent("from:uber.com newer_than:1d")}&maxResults=3`).catch(() => null);
  for (const m of list?.messages ?? []) {
    const full = await googleApi(`${GMAIL}/messages/${m.id}?format=full`).catch(() => null);
    if (!full || Number(full.internalDate) < since - 30_000) continue;
    const subject = full.payload?.headers?.find((h: any) => h.name.toLowerCase() === "subject")?.value ?? "";
    const code = extractCode(`${subject}\n${full.snippet ?? ""}\n${bodyText(full.payload).slice(0, 3000)}`);
    if (code) return code;
  }
  return null;
}

// ---------------- corridas ----------------

export interface RideRow {
  id: string;
  user_id: string;
  execution_id: string | null;
  status: string;
  pickup: string;
  dropoff: string;
  pickup_label: string | null;
  dropoff_label: string | null;
  options: UberOption[];
  chosen: UberOption | null;
  driver: Record<string, string> | null;
  error: string | null;
  updated_at: string;
}

/** Quantas corridas de outras pessoas estão na frente na fila. */
export async function queueAhead() {
  await getBoss();
  const r = await one<{ n: number }>("SELECT count(*)::int AS n FROM pgboss.job WHERE name = $1 AND state IN ('created', 'retry', 'active')", [QUEUES.uber]);
  return Math.max(0, (r?.n ?? 1) - 1);
}

async function enqueue(job: UberJob, userId: string) {
  const boss = await getBoss();
  // uma por pessoa: pedido repetido enquanto a anterior roda não abre outro Chrome
  return boss.send(QUEUES.uber, job, { singletonKey: userId, retryLimit: 0, expireInSeconds: 600 });
}

/** uber_quote: guarda a corrida e entra na fila. */
export async function startQuote(user: { id: string }, pickup: string, dropoff: string, conversationId?: string | null) {
  const busy = await one<{ id: string }>("SELECT id FROM uber_rides WHERE user_id = $1 AND status IN ('cotando', 'pedindo') AND updated_at > now() - interval '10 minutes'", [user.id]);
  if (busy) return { ok: false as const, busy: true };
  const tracer = await Tracer.start({ trigger: "uber", userId: user.id, conversationId, input: `Uber: ${pickup} -> ${dropoff}` });
  const ride = await one<{ id: string }>("INSERT INTO uber_rides (user_id, execution_id, pickup, dropoff) VALUES ($1, $2, $3, $4) RETURNING id", [
    user.id,
    tracer.executionId,
    pickup.slice(0, 300),
    dropoff.slice(0, 300),
  ]);
  const ahead = await queueAhead();
  const jobId = await enqueue({ rideId: ride!.id, action: "quote" }, user.id);
  if (!jobId) {
    await query("UPDATE uber_rides SET status = 'erro', error = 'fila ocupada' WHERE id = $1", [ride!.id]);
    return { ok: false as const, busy: true };
  }
  return { ok: true as const, rideId: ride!.id, ahead };
}

/** Última lista de opções que ainda vale para pedir. */
export async function openRide(userId: string) {
  return one<RideRow>(
    `SELECT * FROM uber_rides WHERE user_id = $1 AND status = 'opcoes' AND updated_at > now() - make_interval(mins => $2) ORDER BY created_at DESC LIMIT 1`,
    [userId, OPTIONS_TTL_MIN],
  );
}

export async function lastRide(userId: string) {
  return one<RideRow>("SELECT * FROM uber_rides WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [userId]);
}

/** Depois do sim: marca a escolha e entra na fila para pedir. */
export async function startRequest(ride: RideRow, option: UberOption) {
  const r = await query("UPDATE uber_rides SET status = 'pedindo', chosen = $2, updated_at = now() WHERE id = $1 AND status = 'opcoes'", [ride.id, JSON.stringify(option)]);
  if (!r.rowCount) return { ok: false as const };
  const ahead = await queueAhead();
  await enqueue({ rideId: ride.id, action: "request" }, ride.user_id);
  return { ok: true as const, ahead };
}

export const priceLabel = (o: Pick<UberOption, "price_cents" | "price_max_cents" | "price_text">) =>
  o.price_cents == null ? o.price_text || "preço na hora" : o.price_max_cents ? `${brl(o.price_cents / 100)} a ${brl(o.price_max_cents / 100)}` : brl(o.price_cents / 100);

export function optionsMessage(ride: Pick<RideRow, "pickup" | "dropoff" | "pickup_label" | "dropoff_label">, options: UberOption[]) {
  const lines = options.map((o) => `${o.n}. *${o.name}* · ${priceLabel(o)}${o.eta ? ` · ${/min/i.test(o.eta) ? `chega em ${o.eta}` : `chegada ${o.eta}`}` : ""}`);
  return (
    `🚗 *Opções da Uber*\n\n` +
    `De: ${ride.pickup_label ?? ride.pickup}\nPara: ${ride.dropoff_label ?? ride.dropoff}\n\n` +
    `${lines.join("\n")}\n\n` +
    `Qual eu peço? Responde com o número ou o nome. Paga no que já está salvo na sua Uber.\n_${BETA_NOTE}_`
  );
}

// ---------------- o job ----------------

type Log = { info?: (...a: any[]) => void; error: (...a: any[]) => void };

export async function runUberJob(job: UberJob, log?: Log) {
  const ride = await one<RideRow>("SELECT * FROM uber_rides WHERE id = $1", [job.rideId]);
  if (!ride) return;
  if (job.action === "quote" && ride.status !== "cotando") return;
  if (job.action === "request" && ride.status !== "pedindo") return;
  const user = await one<{ id: string; phone: string; name: string | null }>("SELECT id, phone, name FROM users WHERE id = $1", [ride.user_id]);
  if (!user) return;
  const tracer = ride.execution_id ? Tracer.attach(ride.execution_id, user.id) : await Tracer.start({ trigger: "uber", userId: user.id, input: "Uber" });
  const { notifyUser } = await import("./social.js");
  const tell = (text: string, shot?: string | null) =>
    notifyUser(user.id, text, shot ? { base64: shot, mimetype: "image/jpeg" } : undefined).catch((err) => log?.error({ err }, "aviso da Uber não saiu"));
  const io = codeIO(user.id, tracer, tell, isOwner(user.phone));
  const { personOf } = await import("./agent/runner.js");

  await asPerson(personOf(user), async () => {
    let robot: UberRobot | null = null;
    const step = await tracer.step({ agent: "uber", type: "tool", name: job.action === "quote" ? "uber: ver opções" : "uber: pedir corrida", input: { pickup: ride.pickup, dropoff: ride.dropoff, chosen: ride.chosen?.name } });
    try {
      robot = await UberRobot.open(await loadCookies(user.id));
      const how = await robot.ensureLogin(user.phone, io);
      await saveCookies(user.id, await robot.cookies(), how === "login");
      await io.note(how === "login" ? "entrou na Uber pelo número (sessão salva)" : "sessão salva ainda valia");
      const route = await robot.setRoute(ride.pickup, ride.dropoff);
      const options = await robot.readOptions();
      await io.note("opções lidas", { route, options });

      if (job.action === "quote") {
        await query("UPDATE uber_rides SET status = 'opcoes', options = $2, pickup_label = $3, dropoff_label = $4, updated_at = now() WHERE id = $1", [
          ride.id,
          JSON.stringify(options),
          route.pickup.slice(0, 200),
          route.dropoff.slice(0, 200),
        ]);
        await tell(optionsMessage({ ...ride, pickup_label: route.pickup, dropoff_label: route.dropoff }, options));
        await step.ok({ options: options.length });
        await tracer.finish(`${options.length} opções`);
      } else {
        const chosen = ride.chosen!;
        const now = options.find((o) => o.name.toLowerCase() === chosen.name.toLowerCase());
        const went = now && chosen.price_cents && now.price_cents ? now.price_cents / chosen.price_cents - 1 : 0;
        if (!now || went > PRICE_TOLERANCE) {
          // preço subiu (tarifa dinâmica) ou a opção sumiu: não pede, mostra a lista nova e espera outra escolha e outro sim
          await query("UPDATE uber_rides SET status = 'opcoes', options = $2, chosen = NULL, updated_at = now() WHERE id = $1", [ride.id, JSON.stringify(options)]);
          await tell(
            `${now ? `O ${chosen.name} subiu de ${priceLabel(chosen)} para ${priceLabel(now)}` : `O ${chosen.name} sumiu das opções`}, então não pedi ainda.\n\n` +
              optionsMessage({ ...ride, pickup_label: route.pickup, dropoff_label: route.dropoff }, options),
          );
          await step.ok({ price_changed: true, before: chosen.price_cents, now: now?.price_cents ?? null });
          await tracer.finish("preço mudou, não pediu");
          return;
        }
        const r = await robot.request(now);
        await saveCookies(user.id, await robot.cookies(), false);
        await query("UPDATE uber_rides SET status = 'pedida', driver = $2, updated_at = now() WHERE id = $1", [ride.id, r.driver ? JSON.stringify(r.driver) : null]);
        await tell(
          r.driver
            ? `✅ *Uber pedido!*\n\n${r.driver.car ? `Carro: ${r.driver.car}\n` : ""}Placa: *${r.driver.plate}*${r.driver.eta ? `\nChega em ${r.driver.eta}` : ""}\n\nO resto você acompanha no app da Uber. Para cancelar, é por lá também.`
            : `✅ *Uber pedido!* (${now.name}, ${priceLabel(now)})\n\nA Uber está procurando o motorista. Quando achar, o app da Uber te avisa com a placa. Para cancelar, é pelo app.`,
        );
        await step.ok({ requested: true, driver: Boolean(r.driver) });
        await tracer.finish(`pedido: ${now.name}`);
      }
    } catch (err) {
      const e = err as Error;
      const reason = err instanceof UberScreenError ? err.reason : "erro";
      await step.fail(`${e.message}${err instanceof UberScreenError && err.pageText ? `\n\nTela:\n${err.pageText}` : ""}`);
      await tracer.finish(e.message, e.message);
      log?.error({ err: e.message, reason }, "Uber (beta) falhou");
      if (reason === "password" || reason === "captcha") await query("UPDATE uber_sessions SET status = 'vencida', state_enc = NULL, updated_at = now() WHERE user_id = $1", [user.id]);
      await query("UPDATE uber_rides SET status = 'erro', error = $2, updated_at = now() WHERE id = $1", [ride.id, e.message.slice(0, 300)]);
      await tell(failureMessage(reason, job.action, ride));
      // beta: o dono recebe o print da tela onde o robô parou (só dele, que é a conta dele), para ajustar o robô
      const shot = isOwner(user.phone) ? await robot?.screenshot().catch(() => null) : null;
      if (shot) await notifyUser(user.id, `Print da tela da Uber onde parei (só pra você, para ajustar a beta). Motivo: ${e.message}`, { base64: shot, mimetype: "image/jpeg" }).catch(() => {});
    } finally {
      await setWaiting(user.id, null).catch(() => {});
      await robot?.close().catch(() => {});
    }
  });
}

function failureMessage(reason: string, action: UberJob["action"], ride: Pick<RideRow, "pickup" | "dropoff">) {
  const why: Record<string, string> = {
    captcha: "A Uber pediu uma verificação de robô que eu não consigo passar.",
    password: "A Uber pediu a senha da conta, e senha eu não digito.",
    code: "O código de verificação não chegou a tempo.",
  };
  const head = why[reason] ?? (action === "request" ? "Não consegui confirmar o pedido na Uber." : "Não consegui ver as opções na Uber.");
  const safe = action === "request" ? " Confere no app da Uber se a corrida não ficou pedida antes de pedir de novo." : "";
  return `${head}${safe}\n\nPelo link abre o app da Uber já com o destino, é só confirmar:\n${uberLink(ride.pickup, ride.dropoff)}\n\n_${BETA_NOTE}_`;
}

/** Espera de código do robô: e-mail pelo Gmail ligado; senão (ou SMS) avisa no WhatsApp e espera a pessoa ou o Atalho. */
function codeIO(userId: string, tracer: Tracer, tell: (t: string, shot?: string | null) => Promise<unknown>, owner: boolean): RobotIO {
  // já pediu um código nesta entrada: o próximo é outra verificação (ex.: SMS passou, agora o e-mail)
  let prior = false;
  return {
    async note(name, data) {
      const s = await tracer.step({ agent: "uber", type: "info", name, input: data ?? null });
      await s.ok(null);
    },
    async waitCode(kind, info) {
      const since = Date.now();
      await setWaiting(userId, kind);
      const shortcut = Boolean((await uberSessionInfo(userId))?.shortcut);
      // e-mail num Gmail ligado: o robô lê sozinho; e-mail de outro provedor (ex.: .gov.br) só a pessoa vê
      const gmail = kind === "email" && (!info.dest || /@(gmail|googlemail)\.com$/i.test(info.dest) || /@\*+/.test(info.dest));
      const where = info.dest ? ` (${info.dest})` : "";
      let asked = false;
      const wasPrior = prior;
      prior = true;
      const ask = async () => {
        asked = true;
        const text = info.retry
          ? "Esse código não passou na Uber. Me manda o mais novo que chegou?"
          : kind === "email"
            ? `${wasPrior ? "O código do SMS passou. Agora a Uber pediu mais uma verificação: mandou" : "A Uber mandou"} um código no seu *e-mail*${where} (olha o spam também). Me manda aqui só os números.`
            : shortcut
              ? `A Uber mandou um código por *SMS*${where}. Se o seu Atalho estiver ligado, ele chega sozinho; senão, me manda aqui só os números.`
              : `${wasPrior ? "Passou. Agora a Uber" : "A Uber"} mandou um código por *SMS*${where} para entrar na sua conta. Me manda aqui só os números.`;
        // beta: o dono vê a tela junto, para conferir o que a Uber pediu
        return tell(text, owner && info.shot ? info.shot : null);
      };
      if (!gmail && !(kind === "sms" && shortcut)) await ask();
      while (Date.now() - since < CODE_WAIT_MS()) {
        const typed = await takeCode(userId);
        if (typed) {
          await setWaiting(userId, null);
          return typed;
        }
        if (gmail) {
          const c = await codeFromGmail(since).catch(() => null);
          if (c) {
            await setWaiting(userId, null);
            return c;
          }
        }
        if (!asked && Date.now() - since > (gmail ? 25_000 : 20_000)) await ask();
        await new Promise((r) => setTimeout(r, gmail ? 3000 : 1500));
      }
      return null;
    },
  };
}

/** Limpeza de hora em hora: lista sem escolha fica velha; corrida presa (worker caiu) vira erro. */
export async function purgeUber() {
  await query("UPDATE uber_rides SET status = 'vencida' WHERE status = 'opcoes' AND updated_at < now() - interval '1 hour'");
  await query("UPDATE uber_rides SET status = 'erro', error = 'parou no meio' WHERE status IN ('cotando', 'pedindo') AND updated_at < now() - interval '30 minutes'");
  await query("DELETE FROM uber_rides WHERE created_at < now() - interval '90 days'");
  await query("UPDATE uber_sessions SET waiting_code = NULL, code_enc = NULL WHERE waiting_code IS NOT NULL AND waiting_since < now() - interval '15 minutes'");
}

export async function listRides(userId: string, limit = 10) {
  return many<RideRow>("SELECT * FROM uber_rides WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2", [userId, limit]);
}
