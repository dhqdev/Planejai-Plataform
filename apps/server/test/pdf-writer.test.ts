import { describe, expect, it } from "vitest";
import { parseWriterText } from "../src/agent/tools/pdf.js";

describe("parseWriterText", () => {
  it("lê seções, itens, destaque e tabela, e tolera aspas e corte no fim", () => {
    const spec = parseWriterText(
      'SUBTÍTULO: A jornada de Cristão\n## Quem foi Bunyan\nEscreveu "O Peregrino" na prisão.\n\nOutro parágrafo.\n> Leia devagar\n## Personagens\n| Nome | Significado |\n|---|---|\n| Fiel | lealdade |\n## Temas\n- fé\n- perseveran',
    );
    expect(spec.subtitle).toBe("A jornada de Cristão");
    expect(spec.sections.map((s) => s.title)).toEqual(["Quem foi Bunyan", "Personagens", "Temas"]);
    expect(spec.sections[0]!.text).toContain('"O Peregrino"');
    expect(spec.sections[0]!.highlight).toBe("Leia devagar");
    expect(spec.sections[1]!.table).toEqual({ columns: ["Nome", "Significado"], rows: [["Fiel", "lealdade"]] });
    expect(spec.sections[2]!.items).toEqual(["fé", "perseveran"]);
  });
  it("ainda aceita JSON", () => {
    expect(parseWriterText('{"sections":[{"title":"A","text":"b"}]}').sections[0]!.title).toBe("A");
  });
});
