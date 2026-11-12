import type { ElementHandle, Page } from "puppeteer-core";
import { BrowserSession } from "./agent/browser.js";
import { many, one, query } from "./db/pool.js";
import { MEET_LIMITS, addChunk, startMeet, stopMeet } from "./meet.js";
import { QUEUES, getBoss } from "./queue/boss.js";

/**
 * Marlene entra sozinha na reunião pelo link (sem a pessoa estar lá). O Chrome da stack (browserless) abre o Meet
 * como convidado com o nome dela, pede para participar e espera alguém da reunião deixar entrar. Lá dentro, um
 * gancho no RTCPeerConnection junta o áudio de quem fala e grava trechos de 2,5 min, que entram no mesmo caminho
 * do painel (addChunk: transcrição barata, áudio apagado, ata em PDF no fim). Trecho em silêncio nem sai da página.
 * Sem Google login (o Google barra login automático): por isso alguém precisa aceitar a entrada dela.
 */

/** Tempos do robô (o teste encurta). */
export const BOT_TIMING = { segmentMs: 150_000, waitAdmitMs: 15 * 60_000, aloneMs: 3 * 60_000, maxMs: 4 * 60 * 60_000, pollMs: 10_000, settleMs: 4000 };
const HEARTBEAT_STALE_S = 45;

const MEET_LINK = /https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i;
/** Primeiro link de reunião do Meet no texto, limpo (sem parâmetros de quem mandou). */
export function meetLink(text: string): string | null {
  const m = MEET_LINK.exec(String(text ?? ""));
  return m ? `https://meet.google.com/${m[1]!.toLowerCase()}` : null;
}

const LEAVE = 'button[aria-label*="Sair da chamada" i], button[aria-label*="Leave call" i], [role="button"][aria-label*="Sair da chamada" i]';
// "Entrar" sozinho não: no Google é "Fazer login"
const JOIN = ["pedir para participar", "pedir para entrar", "ask to join", "participar agora", "join now"];
const DISMISS = ["continuar sem microfone e câmera", "continue without microphone and camera", "entendi", "got it", "fechar", "dismiss"];
const REFUSED = [/recusou|negou|denied your request/i, /não (pode|é possível) participar|can.t join this (video )?call/i, /ningu[eé]m respondeu|no one responded/i, /removeu voc[eê]|removed you|you.ve been removed/i, /reuni[aã]o (terminou|foi encerrada)|call has ended|meeting has ended/i, /c[oó]digo.*inv[aá]lido|check your meeting code|não existe/i];
const ALONE = /voc[eê] [eé] a [uú]nica pessoa|you.re the only one here|ningu[eé]m mais (est[aá] )?aqui/i;

/** Gancho na página: áudio de cada participante (trilhas recebidas pelo WebRTC) misturado e gravado em trechos. */
const HOOK = `(() => {
  if (window.__pj) return;
  const st = (window.__pj = { tracks: [], ctx: null, dest: null, mix: null, rec: null, timer: null, running: false });
  const connect = (t) => { st.ctx.createMediaStreamSource(new MediaStream([t])).connect(st.mix); };
  const attach = (t) => {
    if (!t || t.kind !== "audio" || st.tracks.includes(t)) return;
    st.tracks.push(t);
    // o Chrome só solta o som de uma trilha remota para o WebAudio se ela tocar num elemento (mudo serve)
    const a = new Audio(); a.srcObject = new MediaStream([t]); a.muted = true; a.play().catch(() => {});
    if (st.ctx) connect(t);
  };
  const Orig = window.RTCPeerConnection;
  if (Orig) {
    const Hooked = function (...args) { const pc = new Orig(...args); pc.addEventListener("track", (e) => attach(e.track)); return pc; };
    Hooked.prototype = Orig.prototype;
    Object.setPrototypeOf(Hooked, Orig);
    window.RTCPeerConnection = Hooked;
  }
  window.__pjStart = (segMs) => {
    if (st.running) return st.tracks.length;
    st.ctx = new AudioContext();
    st.dest = st.ctx.createMediaStreamDestination();
    // todas as falas passam pela mistura: dela vão para o gravador e para o medidor de silêncio
    st.mix = st.ctx.createGain();
    const an = st.ctx.createAnalyser(); an.fftSize = 2048;
    st.mix.connect(st.dest); st.mix.connect(an);
    const keep = st.ctx.createConstantSource(); const g = st.ctx.createGain(); g.gain.value = 0; keep.connect(g).connect(st.dest); keep.start();
    const buf = new Float32Array(an.fftSize);
    setInterval(() => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; if (st.rec && Math.sqrt(s / buf.length) > 0.01) st.rec.voiced = true; }, 400);
    for (const t of st.tracks) connect(t);
    st.ctx.resume().catch(() => {});
    st.running = true;
    const seg = () => {
      if (!st.running) return;
      const mime = ["audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
      const rec = new MediaRecorder(st.dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : {});
      const parts = [];
      // cada trecho sabe se teve som (o próximo já começou quando o onstop deste roda)
      rec.voiced = false;
      rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
      rec.onstop = () => {
        const voiced = rec.voiced;
        const blob = new Blob(parts, { type: rec.mimeType || "audio/webm" });
        if (!voiced || !blob.size) return window.__pjChunk("", blob.type);
        const r = new FileReader();
        r.onload = () => window.__pjChunk(String(r.result).split(",")[1] || "", blob.type);
        r.readAsDataURL(blob);
      };
      rec.start();
      st.rec = rec;
      st.timer = setTimeout(() => { rec.stop(); seg(); }, segMs);
    };
    seg();
    return st.tracks.length;
  };
  window.__pjStop = () => new Promise((resolve) => {
    st.running = false; clearTimeout(st.timer);
    const rec = st.rec;
    if (!rec || rec.state !== "recording") return resolve(true);
    const prev = rec.onstop;
    rec.onstop = (e) => { prev && prev(e); setTimeout(() => resolve(true), 2000); };
    rec.stop();
  });
})();`;

/** Pede para Marlene entrar na reunião do link. Uma de cada vez por pessoa. */
export async function joinMeetByLink(userId: string, url: string, title?: string) {
  const link = meetLink(url);
  if (!link) return { ok: false as const, status: 400, error: "Esse não é um link de reunião do Meet (meet.google.com/abc-defg-hij)." };
  const busy = await one("SELECT 1 FROM meet_sessions WHERE user_id = $1 AND mode = 'robo' AND status IN ('entrando', 'gravando')", [userId]);
  if (busy) return { ok: false as const, status: 409, error: "Já estou numa reunião sua. Me tire dela antes de mandar outra." };
  const s = await startMeet(userId, title, { url: link });
  await (await getBoss()).send(QUEUES.meetBot, { sessionId: s.id }, { expireInSeconds: BOT_TIMING.maxMs / 1000 + 30 * 60, retryLimit: 0, singletonKey: `robo:${s.id}` });
  return { ok: true as const, session: s };
}

/** Depois de um deploy: robô que estava numa reunião (coração parado) volta para a sala. */
export async function resumeMeetBots() {
  const rows = await many<{ id: string }>("SELECT id FROM meet_sessions WHERE mode = 'robo' AND status IN ('entrando', 'gravando')");
  const boss = await getBoss();
  for (const r of rows) await boss.send(QUEUES.meetBot, { sessionId: r.id }, { startAfter: HEARTBEAT_STALE_S + 10, expireInSeconds: BOT_TIMING.maxMs / 1000 + 30 * 60, retryLimit: 0 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Botão visível cujo texto (ou aria-label) começa com um dos textos. */
async function findButton(page: Page, texts: string[]): Promise<ElementHandle<Element> | null> {
  const h = await page.evaluateHandle((wanted: string[]) => {
    const all = Array.from(document.querySelectorAll('button, [role="button"]')) as HTMLElement[];
    return (
      all.find((b) => {
        const label = (b.innerText || b.getAttribute("aria-label") || "").trim().toLowerCase();
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && !(b as HTMLButtonElement).disabled && wanted.some((w) => label.startsWith(w));
      }) ?? null
    );
  }, texts);
  const el = h.asElement() as ElementHandle<Element> | null;
  if (!el) await h.dispose();
  return el;
}

async function clickButton(page: Page, texts: string[]) {
  const b = await findButton(page, texts);
  if (!b) return false;
  await b.click().catch(() => {});
  await b.dispose();
  return true;
}

const pageText = (page: Page) => page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
const inCall = async (page: Page) => Boolean(await page.$(LEAVE).catch(() => null));
const refusal = (text: string) => REFUSED.find((r) => r.test(text));

async function status(id: string) {
  return (await one<{ status: string }>("SELECT status FROM meet_sessions WHERE id = $1", [id]))?.status ?? "sumiu";
}
const beat = (id: string) => query("UPDATE meet_sessions SET heartbeat_at = now() WHERE id = $1", [id]).catch(() => {});

async function tell(userId: string, text: string) {
  const { notifyUser } = await import("./social.js");
  await notifyUser(userId, text).catch(() => {});
}

async function fail(s: { id: string; user_id: string; title: string }, why: string) {
  const r = await one("UPDATE meet_sessions SET status = 'erro', error = $2, ended_at = now() WHERE id = $1 AND status = 'entrando' RETURNING id", [s.id, why]);
  if (r) await tell(s.user_id, `Não consegui entrar em *${s.title}*: ${why}`);
}

/** Entra na sala: nome, sem câmera e microfone, "Pedir para participar". */
async function knock(page: Page, name: string) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (await inCall(page)) return true;
    const text = await pageText(page);
    const no = refusal(text);
    if (no) throw new Error(meetRefusalText(text));
    await clickButton(page, DISMISS);
    const input = await page.$('input[type="text"]:not([aria-hidden="true"])').catch(() => null);
    if (input) {
      const value = await input.evaluate((el) => (el as HTMLInputElement).value).catch(() => "x");
      if (!value) await input.type(name, { delay: 40 }).catch(() => {});
      await input.dispose();
    }
    if (await clickButton(page, JOIN)) return true;
    await sleep(2000);
  }
  throw new Error("a página do Meet não mostrou o botão de participar. O link pode estar errado ou a reunião exige conta do Google da empresa.");
}

function meetRefusalText(text: string) {
  if (/recusou|negou|denied/i.test(text)) return "alguém da reunião recusou a minha entrada.";
  if (/ningu[eé]m respondeu|no one responded/i.test(text)) return "ninguém aceitou a minha entrada a tempo.";
  if (/removeu|removed/i.test(text)) return "me tiraram da reunião.";
  if (/terminou|encerrada|ended/i.test(text)) return "a reunião já tinha terminado.";
  if (/c[oó]digo|code|não existe/i.test(text)) return "esse link de reunião não existe.";
  return "o Meet não deixou eu participar (a reunião pode aceitar só contas da empresa).";
}

export async function runMeetBot(sessionId: string, log?: { error: (...a: any[]) => void }) {
  const s = await one<{ id: string; user_id: string; title: string; meet_url: string; status: string; fresh: boolean; name: string | null }>(
    `SELECT s.id, s.user_id, s.title, s.meet_url, s.status, coalesce(s.heartbeat_at > now() - make_interval(secs => $2), false) AS fresh,
            split_part(coalesce(u.full_name, u.name, ''), ' ', 1) AS name
       FROM meet_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.mode = 'robo'`,
    [sessionId, HEARTBEAT_STALE_S],
  );
  if (!s?.meet_url || !["entrando", "gravando"].includes(s.status)) return;
  if (s.fresh) {
    // outro worker ainda está com ela (deploy com os dois de pé): confere de novo daqui a pouco
    await (await getBoss()).send(QUEUES.meetBot, { sessionId }, { startAfter: 60, expireInSeconds: BOT_TIMING.maxMs / 1000, retryLimit: 0 });
    return;
  }
  await beat(sessionId);
  const resumed = s.status === "gravando";
  const botName = s.name ? `Marlene (anotações de ${s.name})` : "Marlene (anotações)";
  let browser: BrowserSession | null = null;
  let nextSeq = ((await one<{ n: number | null }>("SELECT max(seq) AS n FROM meet_chunks WHERE session_id = $1", [sessionId]))?.n ?? -1) + 1;
  const pending = new Set<Promise<unknown>>();
  try {
    browser = await BrowserSession.open(false, {
      timeoutMs: BOT_TIMING.maxMs + BOT_TIMING.waitAdmitMs + 10 * 60_000,
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--lang=pt-BR"],
    });
    const page = browser.page;
    await page.exposeFunction("__pjChunk", (b64: string, mime: string) => {
      if (!b64) return;
      const seq = nextSeq++;
      if (seq >= MEET_LIMITS.chunks) return;
      const p = addChunk(s.user_id, sessionId, seq, Buffer.from(b64, "base64"), mime || "audio/webm")
        .catch((err) => log?.error({ err }, "trecho do robô de reunião falhou"))
        .finally(() => pending.delete(p));
      pending.add(p);
    });
    await page.evaluateOnNewDocument(HOOK);
    // o Meet não pede câmera nem microfone do convidado: nega tudo (ninguém ouve nem vê a Marlene)
    await page.browserContext().overridePermissions("https://meet.google.com", []).catch(() => {});
    await page.goto(`${s.meet_url}?hl=pt-BR`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(BOT_TIMING.settleMs);
    await knock(page, botName);

    // sala de espera: até alguém aceitar
    const waitUntil = Date.now() + BOT_TIMING.waitAdmitMs;
    let toldWaiting = resumed;
    while (!(await inCall(page))) {
      await beat(sessionId);
      if ((await status(sessionId)) !== (resumed ? "gravando" : "entrando")) return; // a pessoa cancelou
      const text = await pageText(page);
      if (refusal(text)) throw new Error(meetRefusalText(text));
      if (!toldWaiting) {
        toldWaiting = true;
        await tell(s.user_id, `Pedi para entrar em *${s.title}* com o nome "${botName}". Alguém da reunião precisa aceitar a minha entrada; espero até 15 minutos.`);
      }
      if (Date.now() > waitUntil) throw new Error("ninguém aceitou a minha entrada em 15 minutos.");
      await sleep(Math.min(4000, BOT_TIMING.pollMs));
    }

    // dentro da reunião
    if (!resumed) {
      const r = await one("UPDATE meet_sessions SET status = 'gravando', started_at = now() WHERE id = $1 AND status = 'entrando' RETURNING id", [sessionId]);
      if (!r) return;
      await tell(s.user_id, `Entrei em *${s.title}* e estou ouvindo 🎧 Quando acabar, te mando a ata em PDF com os pontos importantes. Para me tirar antes, é só pedir.`);
    }
    await page.evaluate(`window.__pjStart(${BOT_TIMING.segmentMs})`);
    const started = Date.now();
    let aloneSince = 0;
    let gone = 0;
    for (;;) {
      await sleep(BOT_TIMING.pollMs);
      await beat(sessionId);
      if ((await status(sessionId)) !== "gravando") break; // pediu para sair (WhatsApp ou painel)
      if (Date.now() - started > BOT_TIMING.maxMs) break;
      if (!(await inCall(page))) {
        if (++gone >= 2) break; // reunião acabou ou tiraram ela
      } else gone = 0;
      const text = await pageText(page);
      if (ALONE.test(text)) {
        aloneSince ||= Date.now();
        if (Date.now() - aloneSince > BOT_TIMING.aloneMs) break;
      } else aloneSince = 0;
    }
    await page.evaluate("window.__pjStop()").catch(() => {});
    await sleep(1500);
    await Promise.allSettled([...pending]);
    const leave = await page.$(LEAVE).catch(() => null);
    if (leave) await leave.click().catch(() => {});
    await stopMeet(s.user_id, sessionId); // fecha e põe a ata na fila (se já não estava resumindo)
  } catch (err) {
    log?.error({ err, sessionId }, "robô de reunião falhou");
    const why = (err as Error).message?.slice(0, 240) || "erro no navegador";
    if ((await status(sessionId)) === "gravando") {
      // caiu no meio: a ata sai com o que deu para ouvir
      await Promise.allSettled([...pending]);
      await stopMeet(s.user_id, sessionId);
    } else await fail(s, /navegador não configurado/i.test(why) ? "o navegador da stack (browserless) não está ligado." : why);
  } finally {
    await browser?.close().catch(() => {});
  }
}
