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
  it("lê foto da capa e das seções, números, gráfico e atenção", () => {
    const spec = parseWriterText(
      "SUBTÍTULO: Do sofá aos 5 km\nCAPA: corrida de rua\n## Começo\nIMAGEM: pessoa correndo\nNÚMERO: 30 min | por treino\nNÚMERO: R$ 0 | para começar\nTexto.\n>! Dor que não passa: pare\n## Plano\nGRÁFICO: Minutos | Semana 1: 8; Semana 2: 1.234,5; sem número: x\nMais texto.",
    );
    expect(spec.coverImage).toBe("corrida de rua");
    expect(spec.sections[0]).toMatchObject({ image: "pessoa correndo", warning: "Dor que não passa: pare", stats: [{ value: "30 min", label: "por treino" }, { value: "R$ 0", label: "para começar" }] });
    expect(spec.sections[1]!.chart).toEqual({ title: "Minutos", bars: [{ label: "Semana 1", value: 8, text: "8" }, { label: "Semana 2", value: 1234.5, text: "1.234,5" }] });
  });
  it("só embute foto em data URL e monta cartões, barras e atenção", async () => {
    const { buildPdfHtml, chartNumber } = await import("../src/pdf.js");
    expect([chartNumber("R$ 1.234,50"), chartNumber("45%"), chartNumber("1.500"), chartNumber("3.5"), chartNumber("nada")]).toEqual([1234.5, 45, 1500, 3.5, null]);
    const spec = { title: "T", sections: [{ title: "A", text: "x", stats: [{ value: "30", label: "min" }], chart: { bars: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }, warning: "cuidado" }, { title: "B", text: "y" }] };
    const ok = buildPdfHtml(spec, new Date(), { cover: { src: "data:image/jpeg;base64,AAAA", credit: "site.com" }, sections: { 1: { src: "https://evil.example/x.jpg" } } });
    expect(ok).toContain(`class="cv-photo"`);
    expect(ok).toContain("Foto: site.com");
    expect(ok).not.toContain("evil.example");
    expect(ok).toContain('class="stat"');
    expect(ok).toContain('style="width:100%"');
    expect(ok).toContain('class="warn"');
    expect(buildPdfHtml(spec)).not.toContain(`class="cv-photo"`);
  });
});
