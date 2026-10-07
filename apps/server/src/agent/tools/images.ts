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
    "Cria uma imagem simples e bonita com o conteúdo que VOCÊ escreve: mapa_mental (title = tema central, sections = ramos com items), " +
    "lista (resumo em cartões), passos (passo a passo numerado), tabela (columns + rows) ou frase (text em destaque). " +
    "Use quando a pessoa pedir mapa mental, resumo em imagem, infográfico, esquema, tabela ou card. Sai em segundos e quase sem custo. " +
    "Textos curtos (ramos com 2 a 5 itens de poucas palavras). Retorna media_id para pôr [[media:ID]] na resposta.",
  parameters: obj(
    {
      kind: { type: "string", enum: ["mapa_mental", "lista", "passos", "tabela", "frase"] },
      title: { type: "string", description: "Título; no mapa mental é o tema central (ex.: nome do livro)" },
      subtitle: { type: "string", description: "Linha de apoio (ex.: autor)" },
      sections: {
        type: "array",
        description: "Ramos/cartões/passos (até 10)",
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
