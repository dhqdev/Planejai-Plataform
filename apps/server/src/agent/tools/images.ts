import { renderImage, type ImageKind } from "../../images.js";
import { defineTool, obj } from "./types.js";

export const makeImage = defineTool<{
  kind: ImageKind;
  title: string;
  subtitle?: string;
  sections?: { title: string; items?: string[]; text?: string }[];
  columns?: string[];
  rows?: string[][];
  text?: string;
}>({
  name: "make_image",
  description:
    "Imagem com o conteúdo que VOCÊ escreve (sem custo): mapa_mental (title = tema, sections = ramos com items), lista (cartões), " +
    "passos, tabela (columns + rows) ou frase (text). Textos curtos, 2 a 5 itens por ramo. Devolve media_id para [[media:ID]].",
  parameters: obj(
    {
      kind: { type: "string", enum: ["mapa_mental", "lista", "passos", "tabela", "frase"] },
      title: { type: "string" },
      subtitle: { type: "string" },
      sections: {
        type: "array",
        description: "Até 10",
        items: obj(
          {
            title: { type: "string" },
            items: { type: "array", items: { type: "string" } },
            text: { type: "string" },
          },
          ["title"],
        ),
      },
      columns: { type: "array", items: { type: "string" }, description: "Só tabela" },
      rows: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Só tabela" },
      text: { type: "string", description: "Só frase" },
    },
    ["kind", "title"],
  ),
  async run(args, ctx) {
    if (args.kind !== "tabela" && args.kind !== "frase" && !args.sections?.length) return { ok: false, error: "Mande sections com o conteúdo." };
    if (args.kind === "tabela" && !(args.columns?.length && args.rows?.length)) return { ok: false, error: "Tabela precisa de columns e rows." };
    const base64 = await renderImage(args);
    const id = ctx.outbox.addMedia({ base64, mimetype: "image/png", caption: undefined, fileName: "imagem.png" });
    return { media_id: id, how_to_send: `Coloque [[media:${id}]] na resposta, com uma frase curta.` };
  },
});
