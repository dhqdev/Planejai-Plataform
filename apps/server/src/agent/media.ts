import { promptText } from "./prompt-overrides.js";
import { createHash } from "node:crypto";
import { cacheGet, cacheSet } from "../shortmem.js";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Channel } from "../channels/types.js";
import { query } from "../db/pool.js";
import { chatCompletion } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import type { ChatResult } from "../llm/types.js";
import type { Tracer } from "./trace.js";
import { htmlToText, plainPage, tavilyExtract } from "./tools/research.js";
import { checkedUrl, safeFetch, BlockedUrlError } from "../net.js";

const run = promisify(execFile);

/** Quanto do documento entra direto no contexto do CTO (o resto fica disponível em read_document). */
export const DOC_PREVIEW_CHARS = 2500;
const DOC_MAX_CHARS = 60_000;
/** interpretação de mídia repetida (mesmo arquivo) fica 30 dias no Redis */
const MEDIA_CACHE_SECONDS = 30 * 86400;
/** texto de documento fica 24h para read_document (a mensagem em si não é guardada) */
const DOC_CACHE_SECONDS = 86400;

export const VISION_PROMPT =
  "Descreva esta imagem em português, objetivo e completo, para um assistente que não pode vê-la. " +
  "Transcreva todo texto visível (valores, datas, nomes, códigos). " +
  "Se for comprovante, Pix, nota fiscal, cupom, recibo, fatura ou boleto, comece com a linha " +
  "'FINANCEIRO: tipo=<comprovante|nota|boleto|fatura>; valor_total=<número com ponto decimal>; data=<AAAA-MM-DD ou ?>; estabelecimento=<nome de quem recebeu o dinheiro>; pago=<sim|não|?>; direcao=<saida|entrada|?>' " +
  "e depois liste os itens. Se for uma lista de vários gastos ou receitas (extrato, fatura, print do banco, anotação, planilha), " +
  "comece com 'FINANCEIRO: tipo=lista; itens=<quantidade>' e depois uma linha por lançamento: " +
  "'ITEM: data=<AAAA-MM-DD ou ?>; descricao=<texto>; valor=<número com ponto decimal>; tipo=<gasto|receita>'. " +
  "Nunca invente o ano: data sem ano na imagem (ex.: 'terça, 06 de outubro') vira '??-10-06' (dia e mês, ano desconhecido).";

const ext = (fileName?: string | null) => (fileName?.split(".").pop() ?? "").toLowerCase();

export function documentKind(mimetype: string, fileName?: string | null): "pdf" | "docx" | "xlsx" | "text" | "html" | "unknown" {
  const e = ext(fileName);
  if (mimetype.includes("pdf") || e === "pdf") return "pdf";
  if (mimetype.includes("wordprocessingml") || e === "docx") return "docx";
  if (mimetype.includes("spreadsheetml") || e === "xlsx") return "xlsx";
  if (mimetype.includes("html") || e === "html" || e === "htm") return "html";
  if (mimetype.startsWith("text/") || ["txt", "csv", "md", "json", "xml", "ofx", "tsv", "log"].includes(e) || mimetype.includes("json") || mimetype.includes("csv")) return "text";
  return "unknown";
}

/** Extrai o texto de PDF, DOCX, XLSX, CSV/TXT/JSON/HTML localmente (sem gastar token). */
export async function extractDocumentText(buf: Buffer, mimetype: string, fileName?: string | null): Promise<{ text: string; pages?: number; kind: string }> {
  const kind = documentKind(mimetype, fileName);
  let text = "";
  let pages: number | undefined;
  if (kind === "pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const r = await extractText(pdf, { mergePages: false });
    pages = r.totalPages;
    text = (r.text as string[]).map((t, i) => (r.totalPages > 1 ? `--- página ${i + 1} ---\n${t}` : t)).join("\n");
  } else if (kind === "docx") {
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer: buf })).value;
  } else if (kind === "xlsx") {
    const { default: readXlsx } = await import("read-excel-file/node");
    const sheets = (await readXlsx(buf)) as { sheet: string; data: unknown[][] }[];
    text = sheets
      .map((s) => `--- planilha ${s.sheet} ---\n${s.data.map((row) => row.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c ?? "")).join(" | ")).join("\n")}`)
      .join("\n");
  } else if (kind === "html") {
    text = htmlToText(buf.toString("utf8"));
  } else if (kind === "text") {
    text = buf.toString("utf8");
  }
  text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { text: text.slice(0, DOC_MAX_CHARS), pages, kind };
}

let ffmpegOk: boolean | null = null;
async function hasFfmpeg() {
  if (ffmpegOk == null) ffmpegOk = await run("ffmpeg", ["-version"]).then(() => true, () => false);
  return ffmpegOk;
}

/** Vídeo -> até 4 quadros (JPEG) + áudio (mp3), para descrever com visão e transcrever. */
async function splitVideo(buf: Buffer): Promise<{ frames: string[]; audio: string | null } | null> {
  if (!(await hasFfmpeg())) return null;
  const dir = await mkdtemp(join(tmpdir(), "pj-video-"));
  try {
    const input = join(dir, "in");
    await writeFile(input, buf);
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", input]).catch(() => ({ stdout: "0" }));
    const duration = Math.max(1, Number(probe.stdout.trim()) || 1);
    const fps = Math.min(1, 4 / duration);
    await run("ffmpeg", ["-v", "error", "-i", input, "-vf", `fps=${fps},scale=640:-2`, "-frames:v", "4", "-q:v", "5", join(dir, "f%02d.jpg")]);
    let audio: string | null = null;
    try {
      await run("ffmpeg", ["-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", join(dir, "a.mp3")]);
      audio = (await readFile(join(dir, "a.mp3"))).toString("base64");
    } catch {
      audio = null; // vídeo sem som
    }
    const frames = [];
    for (const f of (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort()) frames.push((await readFile(join(dir, f))).toString("base64"));
    return { frames, audio };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transcribe(base64: string, format: string) {
  return chatCompletion(await resolveModel("transcription"), {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Transcreva este áudio em português exatamente como falado. Responda só com a transcrição." },
          { type: "input_audio", input_audio: { data: base64, format } },
        ],
      },
    ],
  });
}

async function describeImages(images: { base64: string; mimetype: string }[], prompt?: string) {
  return chatCompletion(await resolveModel("vision"), {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt ?? (await promptText("visao", VISION_PROMPT)) }, ...images.map((i) => ({ type: "image_url" as const, image_url: { url: `data:${i.mimetype};base64,${i.base64}` } }))],
      },
    ],
  });
}

/** PDF escaneado (sem texto): o OpenRouter lê com OCR. */
async function ocrPdf(base64: string, fileName: string) {
  return chatCompletion(await resolveModel("vision"), {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Transcreva o conteúdo deste documento. ${await promptText("visao", VISION_PROMPT)}` },
          { type: "file", file: { filename: fileName, file_data: `data:application/pdf;base64,${base64}` } },
        ] as any,
      },
    ],
    plugins: [{ id: "file-parser", pdf: { engine: "mistral-ocr" } }],
  });
}

/** Como uma mensagem aparece para os agentes (curto: documentos longos ficam em read_document). */
export function describeMessage(m: any): string {
  const parts: string[] = [];
  const meta = m.meta ?? {};
  if (meta.kind === "audio") parts.push(`[áudio] ${meta.transcript ?? "(não consegui transcrever)"}`);
  if (meta.kind === "image") parts.push(`[foto] ${meta.image_description ?? (meta.image_error ? `(não consegui descrever: ${meta.image_error})` : "(não consegui ver a imagem)")}`);
  if (meta.kind === "video") parts.push(`[vídeo] ${meta.video_description ?? ""}${meta.transcript ? ` Fala no vídeo: ${meta.transcript}` : ""}`);
  if (meta.kind === "document") {
    const name = meta.fileName ?? "documento";
    if (meta.doc_text) {
      const len = meta.doc_chars ?? meta.doc_text.length;
      const preview = String(meta.doc_text).slice(0, DOC_PREVIEW_CHARS);
      parts.push(
        `[documento ${name}${meta.doc_pages ? `, ${meta.doc_pages} pág.` : ""}]\n${preview}` +
          (len > DOC_PREVIEW_CHARS ? `\n(... mais ${len - DOC_PREVIEW_CHARS} caracteres: use read_document com message_id ${m.id})` : ""),
      );
    } else parts.push(`[documento ${name}] ${meta.doc_error ? `(não consegui ler: ${meta.doc_error})` : ""}`);
  }
  if (meta.kind === "sticker") parts.push("[figurinha]");
  if (meta.quoted?.text) parts.push(`(respondendo a: "${String(meta.quoted.text).slice(0, 200)}")`);
  if (meta.link_title || meta.link_text) {
    parts.push(`[link: ${meta.link_title ?? "site"}]\n${meta.link_text ?? ""}`);
  } else if (meta.link_error) {
    parts.push(`[link] não consegui abrir o link: ${meta.link_error}`);
  }
  if (m.content) parts.push(m.content);
  return parts.join(" ").trim();
}

const audioFormat = (mimetype: string) =>
  mimetype.includes("mpeg") || mimetype.includes("mp3") ? "mp3" : mimetype.includes("wav") ? "wav" : mimetype.includes("mp4") || mimetype.includes("m4a") ? "m4a" : "ogg";

const URL_REGEX = /(?:https?:\/\/|www\.)[a-zA-Z0-9-._~:/?#\[\]@!$&'()*+,;=%]+/gi;

function extractYouTubeId(urlStr: string): string | null {
  try {
    const u = new URL(urlStr.startsWith("http") ? urlStr : `https://${urlStr}`);
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split(/[?#]/)[0] || null;
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      if (u.pathname.startsWith("/shorts/") || u.pathname.startsWith("/embed/")) {
        return u.pathname.split("/")[2] || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function processLink(rawUrl: string, tracer: Tracer): Promise<{ title: string; text: string; error?: string; usage?: ChatResult }> {
  const ytId = extractYouTubeId(rawUrl);
  if (ytId) {
    const step = await tracer.step({ agent: "cto", type: "tool", name: "assistir_video", input: { url: rawUrl, youtube_id: ytId } });
    try {
      let title = "Vídeo do YouTube";
      let author = "";
      try {
        const oembedRes = await safeFetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${ytId}`)}&format=json`);
        if (oembedRes.ok) {
          const j = await oembedRes.json() as any;
          if (j.title) title = j.title;
          if (j.author_name) author = j.author_name;
        }
      } catch {}

      let transcript = "";
      try {
        const subRes = await safeFetch(`https://www.youtube.com/api/timedtext?v=${encodeURIComponent(ytId)}&lang=pt`);
        if (subRes.ok) {
          const xml = await subRes.text();
          transcript = htmlToText(xml).slice(0, 10_000);
        }
      } catch {}

      const hasSub = transcript.trim().length > 40;
      const summaryPrompt = hasSub
        ? `Faça um resumo objetivo deste vídeo em português. Comece na primeira linha com o título exato. Depois pule uma linha e liste de 3 a 5 pontos principais.\nTítulo: ${title}${author ? ` por ${author}` : ""}\nTranscrição/Legenda:\n${transcript}`
        : `Não encontramos legendas disponíveis para este vídeo. Faça um resumo ou apresentação em português com base no título e autor informados. Não invente conteúdo que não esteja presente. Comece na primeira linha com o título exato. Depois pule uma linha e liste pontos com o que se sabe.\nTítulo: ${title}${author ? ` por ${author}` : ""}\nAviso: Sem legenda/transcrição disponível.`;

      const usage = await chatCompletion(await resolveModel("vision"), {
        messages: [{ role: "user", content: summaryPrompt }],
      });

      const content = usage.message.content?.trim() ?? "";
      const lines = content.split("\n");
      const finalTitle = lines[0]?.replace(/^#+\s*/, "").trim() || title;
      const finalText = lines.slice(1).join("\n").trim() || content;

      await step.ok({ title: finalTitle, summary: finalText, has_transcript: hasSub }, usage);
      return { title: finalTitle, text: finalText, usage };
    } catch (err) {
      const msg = err instanceof BlockedUrlError ? "Endereço bloqueado ou privado" : "Não foi possível acessar as informações do vídeo";
      await step.fail(err);
      return { title: "Vídeo do YouTube", text: "", error: msg };
    }
  }

  const step = await tracer.step({ agent: "cto", type: "tool", name: "ler_link", input: { url: rawUrl } });
  try {
    const safe = await checkedUrl(rawUrl);
    let text = await plainPage(safe);
    if (!text || text.length < 300) {
      text = (await tavilyExtract(safe)) ?? text ?? "";
    }
    if (!text || text.trim().length === 0) {
      throw new Error("Página veio vazia ou inacessível");
    }

    const slice = text.slice(0, 12_000);
    const usage = await chatCompletion(await resolveModel("vision"), {
      messages: [
        {
          role: "user",
          content: `Extraia as informações principais desta página em português. Na primeira linha coloque apenas o título principal da página. Depois pule uma linha e apresente um resumo com 3 a 5 pontos mais importantes.\n\nConteúdo extraído:\n${slice}`,
        },
      ],
    });

    const content = usage.message.content?.trim() ?? "";
    const lines = content.split("\n");
    const pageTitle = lines[0]?.replace(/^#+\s*/, "").trim() || safe;
    const pageSummary = lines.slice(1).join("\n").trim() || content;

    await step.ok({ title: pageTitle, summary: pageSummary }, usage);
    return { title: pageTitle, text: pageSummary, usage };
  } catch (err) {
    const msg = err instanceof BlockedUrlError ? "Endereço bloqueado ou inválido (URL privada ou não encontrada)" : "Não consegui abrir esse link (bloqueado ou inacessível)";
    await step.fail(err);
    return { title: rawUrl, text: "", error: msg };
  }
}

/**
 * Interpreta mídia das mensagens pendentes uma única vez: áudio vira texto, foto vira descrição
 * (com extração de comprovantes), documento vira texto (local, sem token) e vídeo vira quadros + fala.
 * O resultado fica em meta e o arquivo pesado sai do banco.
 */
export async function preprocessMedia(pending: any[], channel: Channel, tracer: Tracer, remoteJid: string, opts: { persist?: boolean } = {}) {
  for (const m of pending) {
    if (m.meta == null) m.meta = {};
    const textContent = typeof m.content === "string" ? m.content : "";
    const urlMatch = textContent.match(URL_REGEX);
    if (urlMatch && !m.meta.link_title && !m.meta.link_text && !m.meta.link_error) {
      const foundUrl = urlMatch[0];
      const urlHash = createHash("sha256").update(foundUrl).digest("hex").slice(0, 32);
      const memo = await cacheGet<Record<string, unknown>>(`link:${urlHash}`);
      if (memo) {
        Object.assign(m.meta, memo);
      } else {
        const res = await processLink(foundUrl, tracer);
        if (res.error) {
          m.meta.link_error = res.error;
        } else {
          m.meta.link_title = res.title;
          m.meta.link_text = res.text;
          await cacheSet(`link:${urlHash}`, { link_title: res.title, link_text: res.text }, MEDIA_CACHE_SECONDS);
        }
        if (opts.persist !== false) {
          await query("UPDATE messages SET meta = $2 WHERE id = $1", [m.id, m.meta]);
        }
      }
    }

    const kind = m.meta?.kind;
    if (!m.media || !["audio", "image", "document", "video"].includes(kind)) continue;
    if (m.meta.transcript || m.meta.image_description || m.meta.doc_text || m.meta.video_description) continue;
    const names: Record<string, string> = { audio: "transcrever_audio", image: "descrever_imagem", document: "ler_documento", video: "assistir_video" };
    const step = await tracer.step({ agent: "cto", type: "tool", name: names[kind]!, input: { message: m.id, mimetype: m.media.mimetype, fileName: m.media.fileName } });
    try {
      const media = await channel.downloadMedia({ externalId: m.external_id, remoteJid, media: m.media } as any);
      if (!media) throw new Error("Não foi possível baixar a mídia");
      // foto fica em memória só durante esta resposta, para poder ser encaminhada a um contato
      if (kind === "image") m.inboundImage = { base64: media.base64, mimetype: media.mimetype };
      // documento ou foto também pode ir para a pasta de Documentos (document_save), só nesta rodada
      if (kind === "image" || kind === "document") m.inboundFile = { base64: media.base64, mimetype: media.mimetype, fileName: m.media.fileName ?? m.meta.fileName ?? undefined };
      // a mesma mídia já interpretada antes (encaminhada, reenviada): reaproveita do cache, sem gastar token
      const hash = createHash("sha256").update(media.base64).digest("hex").slice(0, 40);
      const memo = await cacheGet<Record<string, unknown>>(`media:${kind}:${hash}`);
      if (memo) {
        Object.assign(m.meta, memo);
        await step.ok({ cache: true, ...memo });
      }
      let usage: ChatResult | undefined;
      if (memo) {
        /* já interpretada */
      } else if (kind === "audio") {
        usage = await transcribe(media.base64, audioFormat(media.mimetype));
        m.meta.transcript = usage.message.content?.trim();
        await step.ok({ transcript: m.meta.transcript }, usage);
      } else if (kind === "image") {
        usage = await describeImages([media]);
        const desc = usage.message.content?.trim();
        if (!desc) throw new Error("modelo de visão não devolveu descrição");
        m.meta.image_description = desc;
        await step.ok({ description: m.meta.image_description }, usage);
      } else if (kind === "document") {
        const buf = Buffer.from(media.base64, "base64");
        const fileName = m.media.fileName ?? m.meta.fileName ?? "documento";
        let doc = await extractDocumentText(buf, media.mimetype, fileName).catch((err) => ({ text: "", kind: "erro", pages: undefined, error: (err as Error).message }));
        if (doc.text.length < 40 && doc.kind === "pdf") {
          usage = await ocrPdf(media.base64, fileName);
          doc = { ...doc, text: usage.message.content?.trim() ?? "" };
        } else if (doc.kind === "unknown" && media.mimetype.startsWith("image/")) {
          usage = await describeImages([media]);
          doc = { ...doc, text: usage.message.content?.trim() ?? "" };
        }
        m.meta.doc_text = doc.text || null;
        m.meta.doc_chars = doc.text.length;
        m.meta.doc_pages = doc.pages ?? null;
        if (!doc.text) m.meta.doc_error = (doc as any).error ?? `formato não suportado (${media.mimetype})`;
        await step.ok({ kind: doc.kind, pages: doc.pages, chars: doc.text.length, preview: doc.text.slice(0, 400) }, usage);
      } else if (kind === "video") {
        const parts = await splitVideo(Buffer.from(media.base64, "base64"));
        if (!parts) throw new Error("ffmpeg não disponível para ler vídeo");
        if (parts.frames.length) {
          usage = await describeImages(
            parts.frames.map((base64) => ({ base64, mimetype: "image/jpeg" })),
            "Estes são quadros em sequência de um vídeo. Descreva em português o que acontece, transcrevendo textos visíveis. Seja breve.",
          );
          m.meta.video_description = usage.message.content?.trim();
        }
        if (parts.audio) {
          const t = await transcribe(parts.audio, "mp3").catch(() => null);
          if (t?.message.content) m.meta.transcript = t.message.content.trim();
          // a transcrição também custou: soma no passo (senão sai de graça nos grãos e some do custo)
          if (t) {
            usage = usage
              ? { ...usage, tokensIn: usage.tokensIn + t.tokensIn, tokensOut: usage.tokensOut + t.tokensOut, costUsd: usage.costUsd + t.costUsd }
              : t;
          }
        }
        await step.ok({ description: m.meta.video_description, transcript: m.meta.transcript }, usage);
      }
      if (!memo) {
        const keep = ["transcript", "image_description", "video_description", "doc_text", "doc_chars", "doc_pages"];
        const out = Object.fromEntries(keep.filter((k) => m.meta[k] != null).map((k) => [k, m.meta[k]]));
        if (Object.keys(out).length) await cacheSet(`media:${kind}:${hash}`, out, MEDIA_CACHE_SECONDS);
      }
    } catch (err) {
      if (kind === "document") m.meta.doc_error = (err as Error).message;
      if (kind === "image") m.meta.image_error = (err as Error).message;
      await step.fail(err);
    }
    // o arquivo só serve até aqui; não guarda mídia pesada no banco
    const { base64: _drop, ...mediaMeta } = m.media;
    m.media = mediaMeta;
    // mídia de quem não está na tabela messages (recado, resposta de contato) não grava no banco
    if (opts.persist === false) continue;
    if (m.meta.doc_text) await cacheSet(`doc:${m.conversation_id}:${m.id}`, m.meta.doc_text, DOC_CACHE_SECONDS);
    await query("UPDATE messages SET meta = $2, media = $3 WHERE id = $1", [m.id, m.meta, mediaMeta]);
  }
}
