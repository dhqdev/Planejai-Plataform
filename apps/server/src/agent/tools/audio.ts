import { synthesize, TTS_MAX_CHARS } from "../tts.js";
import { writeLong } from "../writer.js";
import { defineTool, obj } from "./types.js";

const SPOKEN = `Você escreve o texto de uma mensagem de voz em português do Brasil, a partir do pedido. Responda só o texto que vai ser falado:
corrido, natural, como alguém contando, sem lista, título, link, emoji ou marcação, até ${Math.floor(TTS_MAX_CHARS * 0.9)} caracteres. Não invente dados.`;

export const makeAudio = defineTool<{ text?: string; brief?: string }>({
  name: "make_audio",
  description:
    "Mensagem de voz (pt-BR, voz barata). Texto curto e pronto: mande text. Conteúdo longo (história, resumo, explicação): mande só brief " +
    `(o que falar, tom, duração e dados da conversa) e a ferramenta escreve. Até ${TTS_MAX_CHARS} caracteres. Devolve media_id para [[media:ID]].`,
  parameters: obj(
    {
      text: { type: "string", description: "O que vai ser falado, já pronto (curto)" },
      brief: { type: "string", description: "Em vez de text, para conteúdo longo: o que falar, tom, duração, dados" },
    },
    [],
  ),
  async run(args, ctx) {
    let text = String(args.text ?? "").trim();
    if (!text && args.brief?.trim()) text = await writeLong(ctx, { name: "texto do áudio", system: SPOKEN, ask: args.brief.trim() });
    if (!text) return { ok: false, error: "Mande text (o que vai ser falado) ou brief (o que o áudio deve dizer)." };
    if (text.length > TTS_MAX_CHARS) {
      // texto longo demais: corta na última frase que cabe em vez de devolver erro (o modelo repetia a chamada)
      const cut = text.slice(0, TTS_MAX_CHARS);
      text = cut.slice(0, Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? ")) + 1) || cut;
    }
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
