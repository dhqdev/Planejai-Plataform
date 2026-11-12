import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Tracer } from "./agent/trace.js";
import { compressImage } from "./blog.js";
import { getChannel } from "./channels/index.js";
import { config } from "./config.js";
import { many, one, query } from "./db/pool.js";
import { chatCompletion } from "./llm/openrouter.js";
import { resolveModel } from "./llm/router.js";
import { tzOffsetMs } from "./time.js";

/**
 * Status do WhatsApp do número do assistente (some em 24 h, como o de qualquer pessoa).
 * A cada X dias o worker posta uma cena divertida do Bolinho usando o Planejai (gerada pela rota barata "Imagens",
 * com a figurinha dele de referência para sair parecido) ou, de vez em quando, a capa e o link de um post do blog.
 * Desligado até o dono ligar no painel (WhatsApp > Status). O dono também gera rascunhos e posta na mão.
 * Quem vê: as pessoas que conversam com o assistente pelo WhatsApp (e o próprio número). Pelo WhatsApp, o status
 * só aparece para quem tem o número do assistente salvo nos contatos.
 */

export interface StatusSettings {
  /** posta sozinho */
  enabled: boolean;
  /** de quantos em quantos dias */
  everyDays: number;
  /** hora local mínima do post */
  hour: number;
  /** 1 a cada N posts é do blog (0 = nunca) */
  blogEvery: number;
  /** último post automático e quantos já saíram */
  lastAt?: string;
  count?: number;
  /** última tentativa automática que falhou (espera 6 h) */
  failedAt?: string;
}

const DEFAULTS: StatusSettings = { enabled: false, everyDays: 2, hour: 10, blogEvery: 3 };

export async function statusSettings(): Promise<StatusSettings> {
  const row = await one<{ value: Partial<StatusSettings> }>("SELECT value FROM settings WHERE key = 'wa_status'");
  return { ...DEFAULTS, ...(row?.value ?? {}) };
}

const clamp = (v: unknown, min: number, max: number, dflt: number) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export async function saveStatusSettings(patch: Partial<StatusSettings>) {
  const cur = await statusSettings();
  const next: StatusSettings = {
    enabled: patch.enabled === undefined ? cur.enabled : Boolean(patch.enabled),
    everyDays: patch.everyDays === undefined ? cur.everyDays : clamp(patch.everyDays, 1, 14, cur.everyDays),
    hour: patch.hour === undefined ? cur.hour : clamp(patch.hour, 7, 21, cur.hour),
    blogEvery: patch.blogEvery === undefined ? cur.blogEvery : clamp(patch.blogEvery, 0, 10, cur.blogEvery),
    lastAt: patch.lastAt ?? cur.lastAt,
    count: patch.count ?? cur.count,
    failedAt: patch.failedAt === undefined ? cur.failedAt : patch.failedAt || undefined,
  };
  await query(
    "INSERT INTO settings (key, value) VALUES ('wa_status', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()",
    [JSON.stringify(next)],
  );
  return next;
}

// ---------------------------------------------------------------- cenas do Bolinho

/** Cena (em inglês, para o modelo de imagem) e legenda do status. A legenda é fixa: nada de LLM de texto aqui. */
export const SCENES: { id: string; scene: string; caption: string }[] = [
  {
    id: "praia",
    scene: "Bolinho relaxing on a beach lounge chair under a striped umbrella on a Brazilian beach, wearing tiny black sunglasses, a coconut drink with a straw next to him, a smartphone propped in the sand showing chat bubbles, turquoise sea, a small crab peeking curiously at the phone, footprints in the sand.",
    caption: "Contas pagas, lembretes em dia e hoje eu tirei folga 🏖️ Deixa que o Planejai lembra por você.",
  },
  {
    id: "viagem",
    scene: "Bolinho at a sunny airport gate sitting on top of a small yellow rolling suitcase covered in colorful travel stickers, a passport and boarding pass floating next to him, a smartphone floating in front of him showing a checklist with green check marks, a big window behind with an airplane taking off at sunset, a tiny travel pillow around his base.",
    caption: "Mala pronta e checklist feito ✅ Pede pro Planejai montar a lista da sua viagem e vai tranquilo.",
  },
  {
    id: "rede",
    scene: "Bolinho lying in a colorful hammock between two palm trees at a cozy Brazilian beach house porch, a smartphone resting on him showing chat bubbles, a little paper calendar and a piggy bank floating happily nearby with sparkles, a dog sleeping under the hammock, golden hour light.",
    caption: "Domingo de rede e o porquinho cheio 🐷 Organizar a grana dá esse sossego.",
  },
  {
    id: "cafe",
    scene: "Bolinho on a cozy kitchen counter on a Monday morning next to a giant steaming coffee mug as tall as him, a paper calendar with colorful sticky notes, a smartphone buzzing with a reminder bubble, toast popping out of a toaster, sleepy but happy expression.",
    caption: "Segunda-feira, café e a semana já organizada ☕ Manda um áudio pro Planejai com o que você tem pra fazer.",
  },
  {
    id: "mercado",
    scene: "Bolinho riding inside a supermarket shopping cart full of colorful fruits and vegetables, a smartphone floating next to him showing a shopping list with check marks, bright aisles, a banana peeking out like a friend.",
    caption: "Lista do mercado no WhatsApp e nada de esquecer o pão 🛒 Só falar \"anota aí\".",
  },
  {
    id: "montanha",
    scene: "Bolinho on top of a green mountain peak at sunrise with a tiny backpack and a little flag, clouds below, a smartphone floating next to him showing a calendar with a highlighted day, birds flying.",
    caption: "Meta batida, vista linda ⛰️ O Planejai acompanha suas metas e comemora junto.",
  },
  {
    id: "carnaval",
    scene: "Bolinho at a joyful Brazilian street carnival with confetti and streamers, wearing a tiny colorful feather headband, a smartphone floating showing chat bubbles and a small chart going up, happy crowd blurred in the background.",
    caption: "Diversão garantida e o orçamento sob controle 🎉 Dá pra curtir sem susto na fatura.",
  },
  {
    id: "chuva",
    scene: "Bolinho cozy at home on a rainy afternoon wrapped in a soft blanket on a sofa, a cup of hot chocolate, raindrops on the window, a smartphone floating showing chat bubbles, a cat curled up next to him.",
    caption: "Dia de chuva, sofá e tudo anotado 🌧️ Quem lembra das coisas aqui é o Planejai.",
  },
  {
    id: "academia",
    scene: "Bolinho at a bright gym lifting a tiny dumbbell with determination (dumbbell floating next to him), a sweat band on his head, a smartphone on the bench showing a checklist, a water bottle, energetic mood.",
    caption: "Treino feito e lembrete de beber água ativado 💪 Pede pro Planejai te lembrar todo dia.",
  },
  {
    id: "cozinha",
    scene: "Bolinho as a little chef with a tall white chef hat in a cozy kitchen, pots steaming, vegetables flying playfully, a smartphone propped on the counter showing a recipe chat, flour on his cheek.",
    caption: "Receita no zap, lista de compras pronta 👨‍🍳 Hoje tem janta caprichada.",
  },
  {
    id: "acampamento",
    scene: "Bolinho camping at night next to a small tent and a warm campfire, roasting a marshmallow on a stick that floats next to him, a starry sky with the Milky Way, a smartphone glowing with chat bubbles, fireflies around.",
    caption: "Desconectado do estresse, conectado no que importa 🏕️ O Planejai segura as pontas.",
  },
  {
    id: "festa",
    scene: "Bolinho at a birthday party with a tiny party hat, balloons and a cake with candles, gift boxes, a smartphone floating showing a reminder bubble with a little bell, confetti everywhere.",
    caption: "Nunca mais esquecer aniversário 🎂 Fala pro Planejai e ele te avisa no dia.",
  },
  {
    id: "onibus",
    scene: "Bolinho sitting by the window of a city bus at golden hour, earphones on, city lights passing outside, a smartphone floating in front of him showing chat bubbles, calm happy mood.",
    caption: "No caminho de casa e o dia já ficou organizado 🚌 Bastou mandar uma mensagem.",
  },
  {
    id: "piscina",
    scene: "Bolinho floating on a pink flamingo pool float in a sparkling blue swimming pool, tiny sunglasses, a smartphone in a waterproof pouch floating next to him showing chat bubbles, tropical plants around, summer vibe.",
    caption: "Calor, piscina e zero preocupação 🦩 Contas e compromissos ficam por conta do Planejai.",
  },
  {
    id: "escritorio",
    scene: "Bolinho at a tidy home office desk with a laptop, a plant and a cup of tea, a smartphone floating showing chat bubbles and a small calendar, sticky notes neatly organized, sunny window, focused and proud expression.",
    caption: "Reunião marcada, e-mail respondido e agenda em ordem 💼 Seu time de bolso no WhatsApp.",
  },
  {
    id: "natal",
    scene: "Bolinho in a cozy living room decorated for Christmas, wearing a tiny Santa hat, next to a decorated tree with lights, wrapped gifts and a smartphone floating showing a shopping checklist with check marks.",
    caption: "Lista de presentes pronta e dentro do orçamento 🎁 O Planejai ajuda até o Papai Noel.",
  },
];

const STYLE =
  "The attached image shows Bolinho, the mascot of Planejai (a WhatsApp personal assistant app). Keep Bolinho on-model: " +
  "a soft, matte, white rounded-square blob (like a squishy marshmallow with very rounded corners), simple black oval eyes, " +
  "absolutely no arms, no hands and no legs; objects float or lean next to him. Make a vertical 9:16 image for a WhatsApp Status post: " +
  "a cute, funny, high-quality 3D render in a soft toy-like animated-film style, warm natural light, shallow depth of field, " +
  "vibrant but clean colors, lots of charming details. Any phone screen shows a simple chat app UI with abstract green and white " +
  "message bubbles, never readable words. No text, letters, numbers, logos or watermarks anywhere. Scene: ";

const STICKER = join(dirname(fileURLToPath(import.meta.url)), "assets", "stickers", "feliz.webp");

/** Próxima cena: a que ficou mais tempo sem sair (as nunca usadas primeiro, em ordem). */
export function nextScene(used: { scene: string; at: Date }[]) {
  const last = new Map<string, number>();
  for (const u of used) last.set(u.scene, Math.max(last.get(u.scene) ?? 0, u.at.getTime()));
  return [...SCENES].sort((a, b) => (last.get(a.id) ?? 0) - (last.get(b.id) ?? 0))[0]!;
}

async function generateScene(sceneId?: string) {
  const used = await many<{ scene: string; at: Date }>("SELECT scene, created_at AS at FROM wa_status_posts WHERE kind = 'imagem' AND scene IS NOT NULL");
  const pick = SCENES.find((s) => s.id === sceneId) ?? nextScene(used);
  const tracer = await Tracer.start({ trigger: "status", input: `Status do WhatsApp: ${pick.id}`, noCharge: true });
  const step = await tracer.step({ agent: "imagem", type: "llm", name: "status do WhatsApp", input: { scene: pick.scene } });
  try {
    const ref = `data:image/webp;base64,${readFileSync(STICKER).toString("base64")}`;
    const r = await chatCompletion(await resolveModel("image"), {
      modalities: ["image", "text"],
      imageConfig: { aspect_ratio: "9:16" },
      messages: [{ role: "user", content: [{ type: "text", text: STYLE + pick.scene }, { type: "image_url", image_url: { url: ref } }] }],
    });
    const m = r.message.images?.[0]?.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
    if (!m) throw new Error("O modelo de imagem não devolveu imagem.");
    const img = await compressImage({ mimetype: m[1]!, data: Buffer.from(m[2]!, "base64") });
    await step.ok({ mimetype: img.mimetype, bytes: img.data.length }, { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd });
    await tracer.finish(`Imagem pronta (${Math.round(img.data.length / 1024)} KB)`);
    return { scene: pick.id, caption: pick.caption, img, costUsd: r.costUsd };
  } catch (err) {
    await step.fail(err);
    await tracer.error(err);
    throw err;
  }
}

/** Post do blog que ainda não foi para o status, com capa pronta: o mais novo. */
async function blogCandidate() {
  return one<{ id: string; title: string; subtitle: string | null; slug: string; mimetype: string; data: Buffer }>(
    `SELECT p.id, p.title, p.subtitle, p.slug, i.mimetype, i.data FROM blog_posts p
       JOIN blog_images i ON i.post_id = p.id AND i.slot = 'cover'
      WHERE p.status = 'published' AND NOT EXISTS (SELECT 1 FROM wa_status_posts s WHERE s.blog_post_id = p.id)
      ORDER BY p.published_at DESC LIMIT 1`,
  );
}

export function blogCaption(p: { title: string; subtitle: string | null; slug: string }) {
  const url = `${config.PUBLIC_URL.replace(/\/+$/, "")}/blog/${p.slug}`;
  return `📰 Saiu no blog: *${p.title}*${p.subtitle ? `\n${p.subtitle}` : ""}\n\nLeia aqui 👉 ${url}`;
}

export type DraftKind = "imagem" | "blog";

/** Cria um rascunho (não posta). Blog sem post novo com capa cai para cena do Bolinho. */
export async function makeDraft(kind: DraftKind = "imagem", sceneId?: string) {
  if (kind === "blog") {
    const p = await blogCandidate();
    if (p) {
      return one<{ id: string }>(
        "INSERT INTO wa_status_posts (kind, caption, mimetype, data, blog_post_id, cost_usd) VALUES ('blog', $1, $2, $3, $4, 0) RETURNING id",
        [blogCaption(p), p.mimetype, p.data, p.id],
      );
    }
  }
  if (!config.OPENROUTER_API_KEY) throw new Error("Sem OPENROUTER_API_KEY para gerar a imagem.");
  const g = await generateScene(sceneId);
  return one<{ id: string }>(
    "INSERT INTO wa_status_posts (kind, scene, caption, mimetype, data, cost_usd) VALUES ('imagem', $1, $2, $3, $4, $5) RETURNING id",
    [g.scene, g.caption, g.img.mimetype, g.img.data, g.costUsd || null],
  );
}

/** Quem recebe: pessoas ativas que falam com o assistente pelo WhatsApp embutido (sem grupos). */
export async function statusAudience() {
  const rows = await many<{ remote_jid: string }>(
    `SELECT DISTINCT c.remote_jid FROM conversations c JOIN users u ON u.id = c.user_id
      WHERE c.channel = 'baileys' AND u.status = 'active'
        AND (c.remote_jid LIKE '%@s.whatsapp.net' OR c.remote_jid LIKE '%@lid')
      LIMIT 5000`,
  );
  return rows.map((r) => r.remote_jid);
}

/** Posta um rascunho no status. Devolve para quantas pessoas foi. */
export async function postDraft(id: string) {
  const d = await one<{ caption: string; mimetype: string; data: Buffer; status: string }>(
    "SELECT caption, mimetype, data, status FROM wa_status_posts WHERE id = $1",
    [id],
  );
  if (!d) throw new Error("Rascunho não encontrado.");
  if (d.status === "postado") throw new Error("Este já foi postado.");
  if (config.WHATSAPP_PROVIDER !== "baileys") throw new Error("Status só funciona com o WhatsApp embutido (Baileys).");
  const jids = await statusAudience();
  const ch = getChannel("baileys");
  if (!ch.postStatus) throw new Error("Este canal não posta status.");
  try {
    await ch.postStatus({ kind: "image", base64: d.data.toString("base64"), mimetype: d.mimetype, caption: d.caption }, jids);
  } catch (err) {
    await query("UPDATE wa_status_posts SET status = 'falhou', error = $2 WHERE id = $1", [id, (err as Error).message.slice(0, 300)]);
    throw err;
  }
  await query("UPDATE wa_status_posts SET status = 'postado', recipients = $2, error = NULL, posted_at = now() WHERE id = $1", [id, jids.length]);
  // o mesmo status vai para o perfil oficial da rede social do Planejai (post + status de 24 h)
  const { syncOfficialFeed } = await import("./feed-oficial.js");
  await syncOfficialFeed().catch(() => {});
  return jids.length;
}

// ---------------------------------------------------------------- automático

/** Hora de postar: ligado, passou a hora do dia (até 21h, fuso da stack) e o último automático tem X dias (com 2 h de folga). */
export function statusDue(s: StatusSettings, now = new Date()) {
  if (!s.enabled) return false;
  if (s.failedAt && now.getTime() - Date.parse(s.failedAt) < 6 * 3_600_000) return false;
  const h = new Date(now.getTime() + tzOffsetMs(now, config.DEFAULT_TIMEZONE)).getUTCHours();
  if (h < s.hour || h > 21) return false;
  return !s.lastAt || now.getTime() - Date.parse(s.lastAt) >= s.everyDays * 86_400_000 - 2 * 3_600_000;
}

/** Qual tipo sai agora: 1 a cada `blogEvery` é do blog (o 3º, 6º... com o padrão 3). */
export const nextKind = (s: StatusSettings): DraftKind => (s.blogEvery > 0 && ((s.count ?? 0) + 1) % s.blogEvery === 0 ? "blog" : "imagem");

export async function runStatusTick(log: { info: (...a: any[]) => void; error: (...a: any[]) => void }) {
  const s = await statusSettings();
  if (!statusDue(s)) return;
  try {
    const draft = await makeDraft(nextKind(s));
    const n = await postDraft(draft!.id);
    await saveStatusSettings({ lastAt: new Date().toISOString(), count: (s.count ?? 0) + 1, failedAt: "" });
    log.info({ recipients: n }, "status do WhatsApp postado");
  } catch (err) {
    await saveStatusSettings({ failedAt: new Date().toISOString() });
    log.error({ err }, "status do WhatsApp falhou (tento de novo em 6 h)");
  }
}

/** Custo estimado por mês em dólar: só as cenas geradas pagam (o post do blog reaproveita a capa). */
export function monthlyCostUsd(s: StatusSettings, perImage = 0.039) {
  const posts = 30 / s.everyDays;
  const images = s.blogEvery > 0 ? posts * (1 - 1 / s.blogEvery) : posts;
  return Math.round(images * perImage * 100) / 100;
}
