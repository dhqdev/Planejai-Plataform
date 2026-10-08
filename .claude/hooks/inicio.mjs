// Início de sessão do Claude Code: mostra onde o main está e o que outras sessões publicaram,
// para ninguém começar em cima de código velho. Nunca falha nem trava (timeout curto, sempre exit 0).
import { spawnSync } from "node:child_process";

const git = (args, timeout = 4000) => {
  const r = spawnSync("git", args, { encoding: "utf8", timeout, windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : "";
};

try {
  if (git(["rev-parse", "--is-inside-work-tree"]) !== "true") process.exit(0);
  const fetched = spawnSync("git", ["fetch", "-q", "origin", "main"], { timeout: 8000, windowsHide: true }).status === 0;
  const branch = git(["branch", "--show-current"]) || "(sem branch)";
  const [behind, ahead] = (git(["rev-list", "--left-right", "--count", "origin/main...HEAD"]) || "0 0").split(/\s+/);
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
  const log = git(["log", "--format=%h %ar  %s", "-10", "origin/main"]);
  const recent = git(["log", "--since=3 hours ago", "--name-only", "--format=", "origin/main"])
    .split("\n")
    .filter(Boolean);
  const hot = [...recent.reduce((m, f) => m.set(f, (m.get(f) ?? 0) + 1), new Map())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([f, n]) => `${f} (${n})`);

  const out = [
    "Planejai: leia .claude/skills/planejai/SKILL.md (mapa, onde procurar, modelos) e paralelo.md antes de commitar.",
    `git: ${branch}, ${ahead} commit(s) seus não publicados, ${behind} atrás do origin/main${fetched ? "" : " (fetch falhou, pode estar velho)"}, ${dirty} arquivo(s) alterado(s).`,
    Number(behind) > 0 && Number(ahead) === 0 && dirty === 0 ? "Atualize antes de mexer: git pull --rebase origin main" : "",
    log ? `Últimos commits no main:\n${log}` : "",
    hot.length ? `Arquivos mexidos nas últimas 3h (outras sessões podem estar neles): ${hot.join(", ")}` : "",
  ].filter(Boolean);
  console.log(out.join("\n"));
} catch {
  // sem git, sem rede: a sessão segue sem o resumo
}
process.exit(0);
