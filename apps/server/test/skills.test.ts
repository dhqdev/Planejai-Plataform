import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A skill .claude/skills/planejai é o mapa que toda IA lê antes de mexer no projeto.
 * Este teste pega o que ela cita entre crases (arquivo ou CONSTANTE) e confere que ainda existe,
 * para o mapa não apodrecer quando alguém renomeia ou apaga algo e esquece o texto.
 */
const repo = resolve(__dirname, "../../..");
const skillDir = join(repo, ".claude/skills/planejai");
// onde um caminho curto citado na skill pode morar
const ROOTS = [
  "",
  "apps",
  "apps/server",
  "apps/server/src",
  "apps/server/src/agent",
  "apps/server/src/agent/tools",
  "apps/server/src/llm",
  "apps/server/src/api/routes",
  "apps/server/test",
  "apps/dashboard",
  "apps/dashboard/src",
  ".claude/skills/planejai",
  ".github/workflows",
];
// gerados no build, não existem no repositório
const GENERATED = new Set(["version.json"]);

const skillFiles = readdirSync(skillDir).filter((f) => f.endsWith(".md"));
const cited = skillFiles.flatMap((file) =>
  [...readFileSync(join(skillDir, file), "utf8").matchAll(/`([^`\n]+)`/g)].map((m) => ({ file, token: m[1].trim() })),
);

describe("skill planejai (mapa do projeto)", () => {
  it("todo arquivo citado existe", () => {
    const isPath = (t: string) =>
      !t.startsWith("/") && !t.includes("<") && !/NN/.test(t) && /^[\w.\-/]+\.(ts|tsx|md|sql|yml|json|mjs|css|webmanifest)$/.test(t);
    const missing = cited
      .filter(({ token }) => isPath(token) && !GENERATED.has(token))
      .filter(({ token }) => !ROOTS.some((r) => existsSync(join(repo, r, token))))
      .map(({ file, token }) => `${file}: ${token}`);
    expect(missing).toEqual([]);
  });

  it("toda CONSTANTE ou variável de ambiente citada existe no código", () => {
    const tracked = execFileSync("git", ["ls-files", "apps", ".env.example", ".github", "deploy", "Dockerfile", "install.sh"], { cwd: repo, encoding: "utf8" })
      .split("\n")
      .filter((f) => f && /\.(ts|tsx|mjs|js|sql|yml|yaml|json|example|css|sh)$|Dockerfile$/.test(f));
    const corpus = tracked.map((f) => readFileSync(join(repo, f), "utf8")).join("\n");
    const missing = cited
      .filter(({ token }) => /^[A-Z][A-Z0-9_]{3,}$/.test(token) && !corpus.includes(token))
      .map(({ file, token }) => `${file}: ${token}`);
    expect(missing).toEqual([]);
  });

  it("todo arquivo da skill aparece na tabela do SKILL.md", () => {
    const index = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    const orphans = skillFiles.filter((f) => f !== "SKILL.md" && !index.includes(`\`${f}\``));
    expect(orphans).toEqual([]);
  });
});
