import { describe, expect, it } from "vitest";
import { cleanNoteHtml, insertUnderHeading, noteHtmlToText, notePreview, textToNoteHtml } from "../src/notes.js";
import { ctoGroups, SPECIALISTS } from "../src/agent/team.js";

describe("anotações: HTML limpo", () => {
  it("tira script, eventos, estilo e link perigoso", () => {
    const dirty =
      '<h1 onclick="x()">Oi</h1><script>alert(1)</script><p style="color:red">texto <b>forte</b> <a href="javascript:alert(1)">mau</a> <a href="https://ok.com/a?b=1&amp;c=2">bom</a></p><img src=x onerror=alert(1)><iframe src="https://x"></iframe><style>p{}</style>';
    const out = cleanNoteHtml(dirty);
    expect(out).toBe(
      '<h1>Oi</h1><p>texto <strong>forte</strong> mau <a href="https://ok.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">bom</a></p>',
    );
  });

  it("mantém a lista de tarefas e o item feito", () => {
    expect(cleanNoteHtml('<ul data-check="1" class="x"><li data-done="1">a</li><li data-done="0">b</li></ul>')).toBe(
      '<ul data-check="1"><li data-done="1">a</li><li>b</li></ul>',
    );
  });

  it("escapa < solto e some com comentário e tag quebrada", () => {
    expect(cleanNoteHtml("<p>2 < 3 <!-- x --> ok</p><div>linha</div>")).toBe("<p>2 &lt; 3  ok</p><p>linha</p>");
    expect(cleanNoteHtml('<p><svg><script>alert(1)</script></svg>fim</p>')).toBe("<p>fim</p>");
  });
});

describe("anotações: texto do agente vira documento", () => {
  it("títulos, tópicos, subtópicos, numerada e tarefas", () => {
    const html = textToNoteHtml(
      ["# Festa", "## Comidas", "- *Salgados*", "  - coxinha", "  - empada", "- Bolo de _chocolate_", "", "## Passos", "1. Reservar salão", "2. Convites", "[ ] comprar balões", "[x] escolher data", "> não esquecer o gelo", "---", "Fim."].join("\n"),
    );
    expect(html).toBe(
      "<h1>Festa</h1><h2>Comidas</h2><ul><li><strong>Salgados</strong><ul><li>coxinha</li><li>empada</li></ul></li><li>Bolo de <em>chocolate</em></li></ul>" +
        '<h2>Passos</h2><ol><li>Reservar salão</li><li>Convites</li></ol><ul data-check="1"><li>comprar balões</li><li data-done="1">escolher data</li></ul>' +
        "<blockquote>não esquecer o gelo</blockquote><hr><p>Fim.</p>",
    );
  });

  it("título em negrito do WhatsApp vira seção e HTML digitado vira texto", () => {
    expect(textToNoteHtml("*Mercado*\n- arroz <b>x</b>")).toBe("<h3>Mercado</h3><ul><li>arroz &lt;b&gt;x&lt;/b&gt;</li></ul>");
  });

  it("link só http(s)", () => {
    expect(textToNoteHtml("[site](https://a.com) e [mau](javascript:alert(1))")).toBe(
      '<p><a href="https://a.com" target="_blank" rel="noopener noreferrer">site</a> e [mau](javascript:alert(1))</p>',
    );
  });

  it("volta para texto com a mesma marcação (o agente lê assim)", () => {
    const src = ["# Festa", "## Comidas", "- *Salgados*", "  - coxinha", "1. Reservar", "[ ] balões", "[x] data", "> gelo"].join("\n");
    expect(noteHtmlToText(textToNoteHtml(src))).toBe(src);
    expect(notePreview(textToNoteHtml(src))).toBe("Festa Comidas Salgados coxinha Reservar balões data gelo");
  });

  it("acrescenta dentro da seção certa (antes do próximo título do mesmo nível)", () => {
    const base = textToNoteHtml("## Mercado\n- arroz\n## Farmácia\n- dipirona");
    const out = insertUnderHeading(base, "mercado", textToNoteHtml("- feijão"));
    expect(noteHtmlToText(out)).toBe("## Mercado\n- arroz\n- feijão\n## Farmácia\n- dipirona");
    expect(noteHtmlToText(insertUnderHeading(base, "Padaria", textToNoteHtml("- pão")))).toBe("## Mercado\n- arroz\n## Farmácia\n- dipirona\n## Padaria\n- pão");
  });
});

describe("anotações: time", () => {
  it("Zulmira está no time com as ferramentas de anotação", () => {
    const z = SPECIALISTS.find((s) => s.id === "anotacoes")!;
    expect(z.persona).toBe("Zulmira");
    expect(z.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["note_write", "note_list", "note_read", "note_delete"]));
  });

  it("o CTO ganha note_write quando pedem para anotar em tópicos", () => {
    for (const msg of ["anota em tópicos o que falamos", "cria uma anotação com as ideias", "põe na minha lista de tarefas: lavar o carro"]) {
      expect(ctoGroups(msg).some((g) => g.id === "anotacoes")).toBe(true);
    }
    expect(ctoGroups("gastei 30 no mercado").some((g) => g.id === "anotacoes")).toBe(false);
  });
});
