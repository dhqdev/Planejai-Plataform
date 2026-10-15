import { describe, expect, it } from "vitest";
import { applyEdit, branchName, failureExcerpt, lineDiff, parseModelJson, pathProblem } from "../src/devpipeline/edits.js";
import { parseRepo } from "../src/devpipeline/github.js";

describe("esteira: partes puras", () => {
  it("lê o JSON do modelo com cerca, texto em volta ou quebrado", () => {
    expect(parseModelJson('Aqui:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('ok {"b": [1, 2]} fim')).toEqual({ b: [1, 2] });
    expect(parseModelJson("sem json")).toBeNull();
    expect(parseModelJson('{"a": ')).toBeNull();
  });

  it("branch sem acento e curto; repositório só no formato dono/nome", () => {
    expect(branchName(12, "Lembrete repetido não para!")).toBe("esteira/12-lembrete-repetido-nao-para");
    expect(branchName(3, "***")).toBe("esteira/3-chamado");
    expect(parseRepo("dhqdev/Planejai-Plataform")).toEqual({ owner: "dhqdev", name: "Planejai-Plataform" });
    expect(parseRepo("https://github.com/a/b.git")).toEqual({ owner: "a", name: "b" });
    expect(parseRepo("a/b/c")).toBeNull();
    expect(parseRepo("../x")).toBeNull();
  });

  it("não escreve em workflow, .env, lock, migração aplicada nem fora do repositório", () => {
    const existing = new Set(["apps/server/src/db/migrations/001_init.sql"]);
    expect(pathProblem(".github/workflows/ci.yml", existing)).toMatch(/workflows/);
    expect(pathProblem(".env", existing)).toMatch(/\.env/);
    expect(pathProblem(".env.example", existing)).toBeNull();
    expect(pathProblem("package-lock.json", existing)).toMatch(/npm/);
    expect(pathProblem("apps/server/src/db/migrations/001_init.sql", existing)).toMatch(/migração/);
    expect(pathProblem("apps/server/src/db/migrations/099_nova.sql", existing)).toBeNull();
    expect(pathProblem("../etc/passwd", existing)).toMatch(/inválido/);
    expect(pathProblem("/abs.ts", existing)).toMatch(/inválido/);
    expect(pathProblem("apps/server/src/x.ts", existing)).toBeNull();
  });

  it("troca de trecho só quando o trecho aparece uma vez", () => {
    const src = "const a = 1;\nconst b = 2;\nconst b2 = 2;\n";
    expect(applyEdit(src, { path: "x.ts", action: "edit", edits: [{ search: "const a = 1;", replace: "const a = 10;" }] })).toEqual({ content: "const a = 10;\nconst b = 2;\nconst b2 = 2;\n" });
    expect(applyEdit(src, { path: "x.ts", action: "edit", edits: [{ search: "= 2;", replace: "= 3;" }] })).toMatchObject({ error: expect.stringMatching(/mais de uma vez/) });
    expect(applyEdit(src, { path: "x.ts", action: "edit", edits: [{ search: "nada", replace: "x" }] })).toMatchObject({ error: expect.stringMatching(/não existe/) });
    expect(applyEdit(null, { path: "x.ts", action: "edit", edits: [{ search: "a", replace: "b" }] })).toMatchObject({ error: expect.stringMatching(/create/) });
    expect(applyEdit(null, { path: "n.ts", action: "create", content: "novo" })).toEqual({ content: "novo" });
    expect(applyEdit(src, { path: "x.ts", action: "delete" })).toEqual({ content: null });
  });

  it("diff mostra só o bloco mudado e o log do CI só o que explica a falha", () => {
    const d = lineDiff("x.ts", "a\nb\nc\nd\ne\nf", "a\nb\nC\nd\ne\nf");
    expect(d).toContain("-c");
    expect(d).toContain("+C");
    expect(d).not.toContain(" f");
    const log = `${"2026-10-15T10:00:00.0000000Z linha boa\n".repeat(300)}2026-10-15T10:00:01.0000000Z FAIL test/x.test.ts > soma\nAssertionError: expected 3 to be 4\n`;
    const out = failureExcerpt(log);
    expect(out).toContain("FAIL test/x.test.ts");
    expect(out).toContain("expected 3 to be 4");
    expect(out).not.toMatch(/^2026-/m);
    expect(out.length).toBeLessThan(2000);
  });
});
