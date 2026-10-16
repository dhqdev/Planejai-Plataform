import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import { LlmError } from "../llm/openrouter.js";
import { resolveModel } from "../llm/router.js";
import { voiceText } from "./voice-format.js";

const run = promisify(execFile);

/** Áudio longo demais custa e ninguém ouve: ~4 minutos de fala. */
export const TTS_MAX_CHARS = 3500;
/** Voz caprichada (ElevenLabs) custa ~65x o Kokoro: só em áudio curto (~1min20s); mais que isso vai na voz normal. */
export const TTS_CAPRICHADO_MAX_CHARS = 1200;
/** Som de fundo gerado no ffmpeg (sem custo nenhum): chuva fina, mar e um acorde suave. */
export const BACKGROUNDS = ["chuva", "mar", "calmo"] as const;
export type Background = (typeof BACKGROUNDS)[number];

/** Pedaço por chamada (o Kokoro aceita ~4K): corta em fim de frase. */
const CHUNK = 1200;

/** Texto para ser falado: sem marcação de WhatsApp, link, emoji nem lista. */
export function speakable(text: string) {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/[*_~`#>]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function splitForSpeech(text: string, size = CHUNK) {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const slice = rest.slice(0, size);
    const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "), slice.lastIndexOf("\n"));
    const at = cut > size / 3 ? cut + 1 : slice.lastIndexOf(" ") > 0 ? slice.lastIndexOf(" ") : size;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Voz de cada família de modelo; a do Kokoro (padrão) vem de TTS_VOICE. */
function voiceFor(model: string) {
  if (model.startsWith("hexgrad/kokoro")) return config.TTS_VOICE;
  if (model.startsWith("elevenlabs/")) return config.TTS_VOICE_CAPRICHADA;
  if (model.startsWith("google/")) return "Kore";
  if (model.startsWith("openai/")) return "nova";
  return undefined;
}

let prices: { at: number; map: Map<string, { prompt: number; completion: number }> } | null = null;

/** Preço por caractere do catálogo de voz do OpenRouter (cache de 1h). A resposta do /audio/speech não traz custo. */
async function priceOf(model: string) {
  if (!prices || Date.now() - prices.at > 3_600_000) {
    const map = new Map<string, { prompt: number; completion: number }>();
    try {
      const res = await fetch(`${config.OPENROUTER_BASE_URL}/models?output_modalities=speech`, { signal: AbortSignal.timeout(15_000) });
      const json: any = res.ok ? await res.json() : { data: [] };
      for (const m of json.data ?? []) map.set(m.id, { prompt: Number(m.pricing?.prompt ?? 0), completion: Number(m.pricing?.completion ?? 0) });
    } catch {
      // sem catálogo: usa o preço de referência abaixo
    }
    prices = { at: Date.now(), map };
  }
  return prices.map.get(model) ?? { prompt: model.startsWith("elevenlabs/") ? 40e-6 : 0.62e-6, completion: 0 };
}

async function speech(model: string, input: string, signal?: AbortSignal) {
  const voice = voiceFor(model);
  const res = await fetch(`${config.OPENROUTER_BASE_URL}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.PUBLIC_URL,
      "X-Title": "Planejai",
    },
    body: JSON.stringify({ model, input, response_format: "mp3", ...(voice ? { voice } : {}) }),
    signal: signal ? AbortSignal.any([AbortSignal.timeout(60_000), signal]) : AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new LlmError(`OpenRouter voz ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** Duração de um Ogg pela posição do último pacote (48 kHz no Opus). */
export function oggSeconds(buf: Buffer) {
  const at = buf.lastIndexOf("OggS");
  if (at < 0 || at + 14 > buf.length) return 0;
  return Math.round(Number(buf.readBigUInt64LE(at + 6)) / 48_000);
}

export interface Speech {
  base64: string;
  mimetype: string;
  /** true = mensagem de voz (Ogg/Opus); sem ffmpeg vai como arquivo de áudio mp3 */
  ptt: boolean;
  seconds: number;
  chars: number;
  model: string;
  costUsd: number;
}

export interface SpeechOptions {
  signal?: AbortSignal;
  /** voz bonita (rota "tts_caprichado"); texto longo demais cai na voz normal */
  caprichado?: boolean;
  /** som de fundo baixinho por baixo da voz */
  fundo?: Background;
}

/**
 * Texto -> mensagem de voz do WhatsApp. Modelo da rota "tts" (o mais barato com voz em pt-BR) ou "tts_caprichado",
 * um pedaço por chamada, e o ffmpeg junta tudo em Ogg/Opus mono (o formato da bolinha de voz), com som de fundo se pedido.
 * Antes da voz, `voiceText` passa valores, datas, horas e siglas para o jeito falado.
 */
export async function synthesize(text: string, opts: SpeechOptions = {}): Promise<Speech & { caprichado: boolean }> {
  const { signal } = opts;
  const clean = voiceText(speakable(text));
  if (!clean) throw new Error("Texto vazio para falar.");
  const caprichado = Boolean(opts.caprichado) && clean.length <= TTS_CAPRICHADO_MAX_CHARS;
  const route = await resolveModel(caprichado ? "tts_caprichado" : "tts");
  const models = [route.model, ...(route.fallbacks ?? [])];
  const parts = splitForSpeech(clean);
  let lastErr: unknown;
  for (const model of models) {
    try {
      const mp3s: Buffer[] = [];
      for (const p of parts) mp3s.push(await speech(model, p, signal));
      const price = await priceOf(model);
      const out = await toVoiceNote(mp3s, opts.fundo);
      const costUsd = ttsCost(price, clean.length, out.seconds || clean.length / 15);
      return { ...out, chars: clean.length, model, costUsd, caprichado: caprichado && model.startsWith("elevenlabs/") };
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Preço do catálogo: por caractere (Kokoro, ElevenLabs: só prompt), por segundo de áudio (Seed: só completion)
 * ou por token (Gemini: ~4 caracteres por token de entrada e 25 tokens por segundo de áudio).
 */
export function ttsCost(price: { prompt: number; completion: number }, chars: number, seconds: number) {
  if (!price.completion) return chars * price.prompt;
  if (!price.prompt) return seconds * price.completion;
  return (chars / 4) * price.prompt + seconds * 25 * price.completion;
}

/** Fonte do som de fundo no ffmpeg (lavfi), já baixinho: fica uns 20 dB abaixo da voz. */
export function backgroundSource(kind: Background, seconds: number) {
  const d = Math.max(1, Math.ceil(seconds));
  switch (kind) {
    case "chuva":
      return `anoisesrc=color=pink:amplitude=0.5:duration=${d}:sample_rate=48000,highpass=f=300,lowpass=f=6000,volume=0.12`;
    case "mar":
      // ruído marrom subindo e descendo devagar, como onda
      return `anoisesrc=color=brown:amplitude=0.7:duration=${d}:sample_rate=48000,lowpass=f=900,volume='0.02+0.05*pow(sin(PI*t/7),2)':eval=frame`;
    case "calmo":
      // acorde de lá maior bem suave, respirando
      return `sine=f=220:sample_rate=48000:duration=${d}[a];sine=f=277.18:sample_rate=48000:duration=${d}[b];sine=f=329.63:sample_rate=48000:duration=${d}[c];[a][b][c]amix=inputs=3,tremolo=f=0.15:d=0.5,lowpass=f=1500,volume=0.1`;
  }
}

/** Voz (Ogg) + som de fundo: a voz entra 0,8 s depois, o fundo sobe e desce suave e termina 1,5 s depois da voz. */
async function mixBackground(dir: string, voice: string, seconds: number, kind: Background) {
  const total = seconds + 2.3;
  const out = join(dir, "voz-fundo.ogg");
  const bed = `${backgroundSource(kind, total)},afade=t=in:d=1,afade=t=out:st=${(total - 1.5).toFixed(1)}:d=1.5[b]`;
  const graph = `${bed};[0:a]adelay=800:all=1,apad=pad_dur=1.5[v];[v][b]amix=inputs=2:duration=first:normalize=0`;
  await run("ffmpeg", ["-v", "error", "-i", voice, "-filter_complex", graph, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", out], { timeout: 60_000 });
  return out;
}

async function toVoiceNote(mp3s: Buffer[], fundo?: Background): Promise<Pick<Speech, "base64" | "mimetype" | "ptt" | "seconds">> {
  const dir = await mkdtemp(join(tmpdir(), "pj-tts-"));
  try {
    const files: string[] = [];
    for (const [i, b] of mp3s.entries()) {
      const f = join(dir, `p${i}.mp3`);
      await writeFile(f, b);
      files.push(f);
    }
    const out = join(dir, "voz.ogg");
    await run("ffmpeg", ["-v", "error", "-i", `concat:${files.join("|")}`, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "24k", "-application", "voip", out], {
      timeout: 60_000,
    });
    let ogg = await readFile(out);
    // som de fundo é enfeite: se o ffmpeg reclamar, vai só a voz
    if (fundo) ogg = await readFile(await mixBackground(dir, out, oggSeconds(ogg), fundo)).catch(() => ogg);
    return { base64: ogg.toString("base64"), mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: oggSeconds(ogg) };
  } catch {
    // sem ffmpeg: manda o mp3 como arquivo de áudio (toca igual, só não vira a bolinha de voz)
    const mp3 = Buffer.concat(mp3s);
    return { base64: mp3.toString("base64"), mimetype: "audio/mpeg", ptt: false, seconds: 0 };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
