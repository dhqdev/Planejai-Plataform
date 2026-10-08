import { synthesize, TTS_MAX_CHARS } from "../tts.js";
import { defineTool, obj } from "./types.js";

export const makeAudio = defineTool<{ text: string }>({
  name: "make_audio",
  description:
    "Transforma o texto que VOCÊ escreve em mensagem de voz (pt-BR, voz barata). Texto corrido como se fosse falado, " +
    `sem lista, link nem emoji, até ${TTS_MAX_CHARS} caracteres. Devolve media_id para [[media:ID]].`,
  parameters: obj({ text: { type: "string", description: "O que vai ser falado, já pronto" } }, ["text"]),
  async run(args, ctx) {
    const text = String(args.text ?? "").trim();
    if (!text) return { ok: false, error: "Mande o texto que vai ser falado." };
    if (text.length > TTS_MAX_CHARS) return { ok: false, error: `Texto longo demais para áudio (${text.length} caracteres). Resuma para até ${TTS_MAX_CHARS}.` };
    const s = await synthesize(text);
    const id = ctx.outbox.addMedia({ kind: "audio", base64: s.base64, mimetype: s.mimetype, ptt: s.ptt, seconds: s.seconds, spoken: text });
    return {
      media_id: id,
      segundos: s.seconds || undefined,
      how_to_send: `Coloque [[media:${id}]] na resposta. No máximo uma frase curta junto; não repita o conteúdo do áudio em texto.`,
      _usage: { model: s.model, tokensIn: 0, tokensOut: 0, costUsd: s.costUsd },
    };
  },
});
