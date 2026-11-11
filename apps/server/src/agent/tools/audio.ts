import { promptText } from "../prompt-overrides.js";
import { BACKGROUNDS, type Background, synthesize, TTS_CAPRICHADO_MAX_CHARS, TTS_MAX_CHARS } from "../tts.js";
import { writeLong } from "../writer.js";
import { defineTool, obj } from "./types.js";

export const SPOKEN = `Você escreve o texto de uma mensagem de voz em português do Brasil, a partir do pedido. Responda só o texto que vai ser falado:
corrido, natural, como alguém contando, sem lista, título, link, emoji ou marcação, até ${Math.floor(TTS_MAX_CHARS * 0.9)} caracteres. Não invente dados.`;

/**
 * Pedido de áudio dito com todas as letras ("manda em áudio", "quero ouvir", "grava pra mim").
 * Sem isso a resposta sai por escrito, igual para todo mundo: antes o modelo decidia sozinho e
 * a mesma oração saía em voz para uma pessoa e em texto para outra.
 */
const AUDIO_ASK = /(?<!\p{L})(áudios?|audios?|voz|gravad[oa]|grav(?:a|e|ar|ando)|ouvir|escutar|falad[oa]|podcast)(?!\p{L})/iu;
export function audioAsked(text?: string): boolean {
  // marcas como [áudio] (mensagem dela foi de voz) e [msg_id=...] não contam como pedido; o que ela falou conta
  return AUDIO_ASK.test(String(text ?? "").replace(/\[[^\]]*\]/g, " "));
}

export const makeAudio = defineTool<{ text?: string; brief?: string; caprichado?: boolean; fundo?: string }>({
  name: "make_audio",
  description:
    "Mensagem de voz (pt-BR, voz barata). Só quando pedirem áudio com todas as letras; sem pedido, responda por escrito (oração, história, recado, tudo). Texto curto e pronto: mande text. Conteúdo longo (história, resumo, explicação): mande só brief " +
    `(o que falar, tom, duração e dados da conversa) e a ferramenta escreve. Até ${TTS_MAX_CHARS} caracteres. Devolve media_id para [[media:ID]]. ` +
    `caprichado=true usa uma voz bem mais bonita e cara: só quando a pessoa pedir voz melhor ou em ocasião especial (história para criança, parabéns, homenagem, recado carinhoso), até ${TTS_CAPRICHADO_MAX_CHARS} caracteres; no dia a dia, voz normal. ` +
    "fundo (chuva, mar, calmo) põe um som baixinho por baixo, de graça: história, ninar, meditação ou quando pedirem.",
  parameters: obj(
    {
      text: { type: "string", description: "O que vai ser falado, já pronto (curto)" },
      brief: { type: "string", description: "Em vez de text, para conteúdo longo: o que falar, tom, duração, dados" },
      caprichado: { type: "boolean", description: "Voz mais bonita (ocasião especial ou pedido da pessoa). Padrão: false" },
      fundo: { type: "string", enum: [...BACKGROUNDS], description: "Som de fundo baixinho (opcional)" },
    },
    [],
  ),
  async run(args, ctx) {
    // regra igual para todos: áudio só com pedido explícito nesta rodada (ou no objetivo da conversa delegada)
    if (!audioAsked(ctx.inboundText)) return { ok: false, error: "Ninguém pediu áudio: responda por escrito, com o mesmo conteúdo." };
    let text = String(args.text ?? "").trim();
    if (!text && args.brief?.trim()) text = await writeLong(ctx, { name: "texto do áudio", system: await promptText("redator_audio", SPOKEN), ask: args.caprichado ? `${args.brief.trim()}\n\nNo máximo ${TTS_CAPRICHADO_MAX_CHARS} caracteres.` : args.brief.trim() });
    if (!text) return { ok: false, error: "Mande text (o que vai ser falado) ou brief (o que o áudio deve dizer)." };
    if (text.length > TTS_MAX_CHARS) {
      // texto longo demais: corta na última frase que cabe em vez de devolver erro (o modelo repetia a chamada)
      const cut = text.slice(0, TTS_MAX_CHARS);
      text = cut.slice(0, Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? ")) + 1) || cut;
    }
    const fundo = BACKGROUNDS.includes(args.fundo as Background) ? (args.fundo as Background) : undefined;
    const s = await synthesize(text, { caprichado: args.caprichado === true, fundo });
    const id = ctx.outbox.addMedia({ kind: "audio", base64: s.base64, mimetype: s.mimetype, ptt: s.ptt, seconds: s.seconds, spoken: text });
    return {
      media_id: id,
      segundos: s.seconds || undefined,
      ...(args.caprichado && !s.caprichado ? { voz: "normal (texto longo demais para a voz caprichada)" } : {}),
      how_to_send: `Coloque [[media:${id}]] na resposta. No máximo uma frase curta junto; não repita o conteúdo do áudio em texto.`,
      _usage: { model: s.model, tokensIn: 0, tokensOut: 0, costUsd: s.costUsd },
    };
  },
});
