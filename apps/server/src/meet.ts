import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Tracer } from "./agent/trace.js";
import { parseWriterText } from "./agent/tools/pdf.js";
import { many, one, query } from "./db/pool.js";
import { chatCompletion } from "./llm/openrouter.js";
import { resolveModel } from "./llm/router.js";
import { type PdfSpec, pdfFileName, renderPdf } from "./pdf.js";
import { QUEUES, getBoss } from "./queue/boss.js";

/**
 * Secretária de reuniões (especialista "reunioes" da loja). O painel aberto no notebook capta o áudio da
 * guia do Meet (e o microfone da pessoa) em trechos de ~2,5 min; cada trecho vira texto num job (modelo
 * omni barato da rota "transcription") e o áudio sai do banco na hora. No fim, uma chamada só (rota "writer")
 * escreve a ata no formato do redator de PDF e ela vira PDF em Documentos e no WhatsApp da pessoa.
 * Tudo da mesma reunião cai numa execução só em Execuções.
 */

export const MEET_LIMITS = { chunkBytes: 6 * 1024 * 1024, chunks: 120, titleChars: 120, transcriptChars: 60_000 } as const;
export type MeetJob = { action: "chunk"; sessionId: string; seq: number } | { action: "finish"; sessionId: string };

const run = promisify(execFile);
const SILENCE = /^\s*\[?(sil[eê]ncio|sem fala|inaud[ií]vel)\]?\.?\s*$/i;

export interface MeetSession {
  id: string;
  title: string;
  /** entrando = o robô pediu para participar e espera alguém deixar entrar */
  status: "entrando" | "gravando" | "resumindo" | "pronto" | "erro";
  mode?: "painel" | "robo";
  started_at: string;
  ended_at: string | null;
  document_id: string | null;
  error: string | null;
  chunks: number;
}

const COLS = `s.id, s.title, s.status, s.mode, s.started_at, s.ended_at, s.document_id, s.error,
  (SELECT count(*)::int FROM meet_chunks c WHERE c.session_id = s.id) AS chunks`;

export function defaultTitle(now = new Date(), tz = "America/Sao_Paulo") {
  return `Reunião de ${now.toLocaleString("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", " às")}`;
}

export async function startMeet(userId: string, title?: string, robo?: { url: string }) {
  // reunião esquecida aberta (aba fechada no meio): fecha e resume o que chegou antes de abrir outra
  const stale = await many<{ id: string }>("SELECT id FROM meet_sessions WHERE user_id = $1 AND status = 'gravando' AND mode = 'painel'", [userId]);
  if (!robo) for (const s of stale) await stopMeet(userId, s.id).catch(() => {});
  const name = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, MEET_LIMITS.titleChars) || defaultTitle();
  const tracer = await Tracer.start({ trigger: "reuniao", userId, input: name });
  // a execução fica aberta a reunião inteira; "success" desde já para a limpeza de órfãs não marcar erro
  await tracer.finish("acompanhando a reunião");
  return (await one<MeetSession>(
    `INSERT INTO meet_sessions (user_id, title, execution_id, mode, meet_url, status) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, status, mode, started_at, ended_at, document_id, error, 0 AS chunks`,
    [userId, name, tracer.executionId, robo ? "robo" : "painel", robo?.url ?? null, robo ? "entrando" : "gravando"],
  ))!;
}

export async function listMeets(userId: string) {
  return many<MeetSession & { overview: string | null }>(
    `SELECT ${COLS}, left(substring(s.summary from '## [^\n]*\n+([^#]*)'), 400) AS overview
       FROM meet_sessions s WHERE s.user_id = $1 ORDER BY s.started_at DESC LIMIT 50`,
    [userId],
  );
}

export async function getMeet(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const s = await one<MeetSession & { summary: string | null }>(`SELECT ${COLS}, s.summary FROM meet_sessions s WHERE s.id = $1 AND s.user_id = $2`, [id, userId]);
  if (!s) return null;
  const parts = await many<{ seq: number; status: string; transcript: string | null }>(
    "SELECT seq, status, transcript FROM meet_chunks WHERE session_id = $1 ORDER BY seq",
    [id],
  );
  return { ...s, parts };
}

export async function deleteMeet(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = await query("DELETE FROM meet_sessions WHERE id = $1 AND user_id = $2", [id, userId]);
  return (r.rowCount ?? 0) > 0;
}

/** Um trecho de áudio do painel. Guarda e põe na fila; o worker transcreve e apaga o áudio. */
export async function addChunk(userId: string, id: string, seq: number, audio: Buffer, mimetype: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { ok: false as const, status: 404, error: "Reunião não encontrada" };
  const s = await one<{ status: string }>("SELECT status FROM meet_sessions WHERE id = $1 AND user_id = $2", [id, userId]);
  if (!s) return { ok: false as const, status: 404, error: "Reunião não encontrada" };
  if (s.status !== "gravando") return { ok: false as const, status: 409, error: "Essa reunião já foi encerrada" };
  if (!Number.isInteger(seq) || seq < 0 || seq >= MEET_LIMITS.chunks) return { ok: false as const, status: 400, error: "Reunião longa demais (máx. 5 horas)" };
  if (!audio.length) return { ok: false as const, status: 400, error: "Trecho vazio" };
  if (audio.length > MEET_LIMITS.chunkBytes) return { ok: false as const, status: 413, error: "Trecho grande demais" };
  // o mesmo trecho reenviado (rede caiu no meio) não duplica
  const r = await query(
    "INSERT INTO meet_chunks (session_id, seq, audio, mimetype) VALUES ($1, $2, $3, $4) ON CONFLICT (session_id, seq) DO NOTHING",
    [id, seq, audio, mimetype.slice(0, 80)],
  );
  if (r.rowCount) await (await getBoss()).send(QUEUES.meet, { action: "chunk", sessionId: id, seq } satisfies MeetJob, { retryLimit: 2, retryDelay: 20, singletonKey: `meet:${id}:${seq}` });
  return { ok: true as const };
}

export async function stopMeet(userId: string, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const s = await one<{ id: string }>(
    "UPDATE meet_sessions SET status = 'resumindo', ended_at = now() WHERE id = $1 AND user_id = $2 AND status = 'gravando' RETURNING id",
    [id, userId],
  );
  // espera uns segundos: o último trecho costuma chegar junto com o "encerrar"
  if (s) await (await getBoss()).send(QUEUES.meet, { action: "finish", sessionId: id } satisfies MeetJob, { startAfter: 10, retryLimit: 1, retryDelay: 60, singletonKey: `meet:${id}:fim` });
  if (s) return true;
  // robô que ainda nem entrou: cancela (ele vê o status mudar e sai da sala de espera)
  const c = await one(
    "UPDATE meet_sessions SET status = 'erro', error = 'Você cancelou antes de eu entrar na reunião.', ended_at = now() WHERE id = $1 AND user_id = $2 AND status = 'entrando' RETURNING id",
    [id, userId],
  );
  return Boolean(c);
}

/** webm/opus do navegador -> mp3 mono 16 kHz (o formato que os modelos omni aceitam). Sem ffmpeg vai como veio. */
async function toMp3(audio: Buffer, mimetype: string): Promise<{ base64: string; format: string }> {
  const fallback = { base64: audio.toString("base64"), format: mimetype.includes("wav") ? "wav" : mimetype.includes("mp3") || mimetype.includes("mpeg") ? "mp3" : "ogg" };
  const ok = await run("ffmpeg", ["-version"]).then(() => true, () => false);
  if (!ok) return fallback;
  const dir = await mkdtemp(join(tmpdir(), "pj-meet-"));
  try {
    await writeFile(join(dir, "in"), audio);
    await run("ffmpeg", ["-v", "error", "-i", join(dir, "in"), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", join(dir, "a.mp3")]);
    return { base64: (await readFile(join(dir, "a.mp3"))).toString("base64"), format: "mp3" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const TRANSCRIBE =
  "Este é um trecho de uma reunião online. Transcreva em português exatamente o que foi dito, sem resumir. " +
  "Comece uma linha nova quando outra pessoa começar a falar; se der para saber o nome, ponha antes (Nome: fala). " +
  "Sem fala nenhuma, responda só [silêncio]. Responda só a transcrição.";

async function sessionTracer(sessionId: string) {
  const s = await one<{ user_id: string; execution_id: string | null; title: string }>("SELECT user_id, execution_id, title FROM meet_sessions WHERE id = $1", [sessionId]);
  if (!s) return null;
  const tracer = s.execution_id ? Tracer.attach(s.execution_id, s.user_id) : await Tracer.start({ trigger: "reuniao", userId: s.user_id, input: s.title });
  return { ...s, tracer };
}

export async function transcribeChunk(sessionId: string, seq: number) {
  const c = await one<{ audio: Buffer | null; mimetype: string | null; status: string }>("SELECT audio, mimetype, status FROM meet_chunks WHERE session_id = $1 AND seq = $2", [sessionId, seq]);
  if (!c || c.status === "pronto" || !c.audio) return;
  const s = await sessionTracer(sessionId);
  if (!s) return;
  const step = await s.tracer.step({ agent: "c_reunioes", type: "llm", name: `transcrever trecho ${seq + 1}`, input: { kb: Math.round(c.audio.length / 1024) } });
  try {
    const audio = await toMp3(c.audio, c.mimetype ?? "audio/webm");
    const model = await resolveModel("transcription");
    const r = await chatCompletion(model, {
      // 2,5 min de conversa rápida passam de 600 palavras: teto folgado mesmo se a tela Modelos baixar
      maxTokens: Math.max(model.maxTokens ?? 0, 2000),
      messages: [{ role: "user", content: [{ type: "text", text: TRANSCRIBE }, { type: "input_audio", input_audio: { data: audio.base64, format: audio.format } }] }],
    });
    const text = String(r.message.content ?? "").trim();
    const transcript = SILENCE.test(text) ? "" : text;
    await query("UPDATE meet_chunks SET transcript = $3, status = 'pronto', audio = NULL WHERE session_id = $1 AND seq = $2", [sessionId, seq, transcript]);
    await step.ok({ chars: transcript.length }, r);
  } catch (err) {
    await step.fail(err);
    throw err; // o pg-boss tenta de novo; a última falha marca o trecho no fim (finishMeet)
  }
}

export const MEET_WRITER = `Você é a secretária de uma reunião e escreve a ata a partir da transcrição, em português do Brasil.
A transcrição vem de áudio automático: corrija palavras óbvias, ignore conversa fora do assunto e nunca invente nome, número, data ou decisão que não foi dita.
Responda só o texto, neste formato:
SUBTÍTULO: uma linha com o assunto principal e quem participou, se deu para saber
## Resumo
2 a 4 parágrafos curtos: o objetivo da reunião e o que saiu dela.
## Tópicos discutidos
- um item por assunto, com o que foi dito de mais importante
## Decisões
- o que ficou decidido (se nada foi decidido, diga isso numa linha)
## Tarefas e responsáveis
| Tarefa | Quem | Prazo |
| ... | ... | ... |
(use "a definir" quando não foi dito; sem tarefas, uma linha dizendo isso)
## Sugestões
- 3 a 6 sugestões práticas suas para o próximo passo, riscos que ninguém comentou ou o que vale preparar
> uma dica curta de destaque, se tiver
## Pontos em aberto
- perguntas que ficaram sem resposta e o que precisa ser confirmado
Use **negrito** só no que importa. Sem IMAGEM, CAPA nem GRÁFICO.`;

/** Transcrição longa demais para uma chamada: resume em blocos primeiro (as notas cabem na ata). */
async function condense(text: string, tracer: Tracer) {
  if (text.length <= MEET_LIMITS.transcriptChars) return text;
  const model = await resolveModel("writer");
  const blocks: string[] = [];
  for (let i = 0; i < text.length; i += 40_000) blocks.push(text.slice(i, i + 40_000));
  const notes: string[] = [];
  for (const [i, b] of blocks.entries()) {
    const step = await tracer.step({ agent: "c_reunioes", type: "llm", name: `notas da parte ${i + 1} de ${blocks.length}` });
    try {
      const r = await chatCompletion(model, {
        maxTokens: 1500,
        reasoning: "off",
        messages: [
          { role: "system", content: "Anote em tópicos curtos, em português, tudo que importa deste pedaço de reunião: assuntos, números, nomes, decisões, tarefas com responsável e prazo, dúvidas. Sem inventar." },
          { role: "user", content: b },
        ],
      });
      notes.push(`Parte ${i + 1}:\n${String(r.message.content ?? "").trim()}`);
      await step.ok({ chars: notes.at(-1)!.length }, r);
    } catch (err) {
      await step.fail(err);
      throw err;
    }
  }
  return `(notas da reunião, que foi longa)\n${notes.join("\n\n")}`;
}

export function meetSpec(title: string, writerText: string): PdfSpec {
  const spec = parseWriterText(writerText);
  // a data da reunião já sai na capa (dia em que o PDF é feito, logo depois do "encerrar")
  return { title, subtitle: spec.subtitle, kicker: "Ata de reunião", toc: false, sections: spec.sections.map(({ image: _i, ...s }) => s) };
}

/** Fim da reunião: junta os trechos, escreve a ata, gera o PDF, guarda em Documentos e manda no WhatsApp. */
export async function finishMeet(sessionId: string, log?: { error: (...a: any[]) => void }) {
  const s = await sessionTracer(sessionId);
  if (!s) return;
  const meta = await one<{ status: string }>("SELECT status FROM meet_sessions WHERE id = $1", [sessionId]);
  if (meta?.status !== "resumindo") return;
  // trecho que o worker ainda não pegou (fila cheia, falha de rede): tenta agora, uma vez
  const pending = await many<{ seq: number }>("SELECT seq FROM meet_chunks WHERE session_id = $1 AND status = 'pendente' ORDER BY seq", [sessionId]);
  for (const p of pending) {
    await transcribeChunk(sessionId, p.seq).catch(async () => {
      await query("UPDATE meet_chunks SET status = 'erro', audio = NULL WHERE session_id = $1 AND seq = $2", [sessionId, p.seq]);
    });
  }
  const parts = await many<{ transcript: string | null }>("SELECT transcript FROM meet_chunks WHERE session_id = $1 AND status = 'pronto' ORDER BY seq", [sessionId]);
  const transcript = parts.map((p) => p.transcript ?? "").filter(Boolean).join("\n");
  const fail = async (msg: string) => {
    await query("UPDATE meet_sessions SET status = 'erro', error = $2 WHERE id = $1", [sessionId, msg]);
    await s.tracer.finish(msg, msg);
  };
  if (transcript.replace(/\s/g, "").length < 40) {
    await fail("Não deu para ouvir conversa nesta reunião. Confira se marcou \"Compartilhar áudio da guia\" ao escolher a guia do Meet.");
    return;
  }
  try {
    const material = await condense(transcript, s.tracer);
    const step = await s.tracer.step({ agent: "c_reunioes", type: "llm", name: "escrever a ata", input: { chars: material.length } });
    const model = await resolveModel("writer");
    let r;
    try {
      r = await chatCompletion(model, {
        maxTokens: Math.max(model.maxTokens ?? 0, 4000),
        reasoning: "off",
        messages: [
          { role: "system", content: MEET_WRITER },
          { role: "user", content: `Reunião: ${s.title}\n\nTranscrição:\n${material}` },
        ],
      });
      await step.ok({ chars: String(r.message.content ?? "").length, finish: r.finishReason }, r);
    } catch (err) {
      await step.fail(err);
      throw err;
    }
    const text = String(r.message.content ?? "").trim();
    const spec = meetSpec(s.title, text);
    if (!spec.sections.length) throw new Error("A ata voltou vazia");
    const pdf = await renderPdf(spec);
    const fileName = pdfFileName(s.title);
    const { saveDocument } = await import("./documents.js");
    const doc = await saveDocument({ userId: s.user_id, name: fileName, mimetype: "application/pdf", data: pdf, folder: "Reuniões", notes: spec.subtitle ?? null, source: "assistente" }).catch((err) => {
      log?.error({ err }, "ata da reunião não coube em Documentos");
      return null;
    });
    await query("UPDATE meet_sessions SET status = 'pronto', summary = $2, document_id = $3, error = NULL WHERE id = $1", [sessionId, text, doc?.id ?? null]);
    await s.tracer.finish(`ata pronta: ${spec.sections.length} seções`);
    const { notify } = await import("./notifications.js");
    await notify({ userId: s.user_id, kind: "reuniao", title: "Ata da reunião pronta", body: s.title, link: "/especialistas/reunioes" });
    const { notifyUser } = await import("./social.js");
    await notifyUser(s.user_id, `Prontinho, a ata de *${s.title}* está aqui 📝 Tem o resumo, os tópicos, as decisões, as tarefas de cada um e umas sugestões minhas.`, {
      base64: pdf.toString("base64"),
      mimetype: "application/pdf",
      kind: "document",
      fileName,
    }).catch((err) => log?.error({ err }, "ata da reunião não foi pelo WhatsApp"));
  } catch (err) {
    await fail(`Não consegui escrever a ata: ${(err as Error).message}`.slice(0, 300));
    throw err;
  }
}

export async function runMeetJob(job: MeetJob, log?: { error: (...a: any[]) => void }) {
  if (job.action === "chunk") return transcribeChunk(job.sessionId, job.seq);
  if (job.action === "finish") return finishMeet(job.sessionId, log);
}

/** Limpeza de hora em hora: a transcrição some em 7 dias (a ata fica); reunião largada aberta por 6 h é encerrada. */
export async function purgeMeets() {
  await query("DELETE FROM meet_chunks WHERE created_at < now() - interval '7 days'");
  const stale = await many<{ id: string; user_id: string }>("SELECT id, user_id FROM meet_sessions WHERE status IN ('gravando', 'entrando') AND started_at < now() - interval '6 hours'");
  for (const s of stale) await stopMeet(s.user_id, s.id).catch(() => {});
}
