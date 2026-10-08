import { CORE_FACES, type Face } from "../../faces";
import { TRIGGER_ICON, TRIGGER_LABEL, agentMeta, delegateTarget, shortModel, toolLabel } from "./labels";
import type { Step } from "./steps";

/* Desenho do canvas: onde fica cada nó e por onde passa cada seta. Só geometria, sem React. */

export const NODE_W = 190;
const H = 64;

export interface FlowNode { key: string; x: number; y: number; icon: string; face?: Face | null; title: string; sub: string; status: string; step?: Step }
export interface FlowEdge { key: string; d: string; peer: boolean; active: boolean; label?: string; lx: number; ly: number }
export interface Flow { nodes: FlowNode[]; edges: FlowEdge[]; width: number; height: number }

const statusOf = (list: Step[]) => (list.some((s) => s.status === "error") ? "err" : list.length && list.every((s) => s.status === "success") ? "ok" : "");

/**
 * Colunas no estilo do n8n: gatilho → CTO → especialistas → resposta. Setas entre especialistas
 * mostram quando um consultou o outro; o rótulo é quantas vezes conversaram.
 */
export function flowLayout(data: any, steps: Step[]): Flow {
  const talks = steps.filter((s) => s.type === "delegate");
  const targetOf = (s: Step) => delegateTarget(s.name);
  const agents: string[] = [];
  for (const t of talks) for (const a of [t.agent, targetOf(t)]) if (a !== "cto" && !agents.includes(a)) agents.push(a);
  const sends = steps.filter((s) => s.type === "channel");
  const ctoLlm = steps.filter((s) => s.agent === "cto" && s.type === "llm");
  const col = (i: number) => 30 + i * 232;
  const rows = Math.max(1, agents.length);
  const height = Math.max(200, rows * 92 + 50);
  const midY = height / 2 - H / 2;

  const nodes: FlowNode[] = [
    { key: "trigger", x: col(0), y: midY, icon: TRIGGER_ICON[data.trigger] ?? "play", title: "Gatilho", sub: TRIGGER_LABEL[data.trigger] ?? data.trigger, status: "ok" },
    { key: "cto", x: col(1), y: midY, icon: "brain", face: CORE_FACES.cto?.face, title: "Téo · CTO", sub: `${ctoLlm.length} chamadas · ${shortModel(ctoLlm[0]?.model)}`, status: statusOf(ctoLlm), step: ctoLlm[0] },
    ...agents.map((a, i) => {
      const own = steps.filter((s) => s.agent === a);
      const tools = [...new Set(own.filter((s) => s.type === "tool").map((s) => toolLabel(s.name).toLowerCase()))];
      const first = talks.find((t) => targetOf(t) === a);
      const m = agentMeta(a, data.client_agents ?? []);
      return {
        key: a,
        x: col(2),
        y: 25 + i * 92 + (rows - agents.length) * 46,
        icon: m.icon,
        face: m.face,
        title: m.persona ? `${m.persona} · ${m.name}` : m.name,
        sub: tools.join(", ") || "conversou",
        status: statusOf(own),
        step: first,
      };
    }),
    { key: "out", x: col(agents.length ? 3 : 2) + (agents.length ? 36 : 0), y: midY, icon: "send", title: "Resposta", sub: sends.length ? `${sends.length} mensagem(ns)` : data.output === "[[silencio]]" ? "silêncio (só reação)" : "–", status: statusOf(sends), step: sends[0] },
  ];
  const pos = new Map(nodes.map((n) => [n.key, n]));
  const running = data.status === "running";

  // conversas únicas (de -> para) com contagem
  const pairs = new Map<string, { from: string; to: string; n: number; active: boolean }>();
  for (const t of talks) {
    const k = `${t.agent}>${targetOf(t)}`;
    const p = pairs.get(k) ?? { from: t.agent, to: targetOf(t), n: 0, active: false };
    p.n++;
    p.active ||= t.status === "running";
    pairs.set(k, p);
  }

  const edges: FlowEdge[] = [];
  const curve = (a: string, b: string, active = false, label?: string) => {
    const p = pos.get(a);
    const q = pos.get(b);
    if (!p || !q) return;
    if (p.x === q.x) {
      // colega -> colega: arco pela direita
      const x = p.x + NODE_W;
      const y1 = p.y + H / 2;
      const y2 = q.y + H / 2;
      const bulge = 40 + Math.abs(y2 - y1) * 0.25;
      edges.push({ key: `${a}-${b}`, d: `M${x},${y1} C${x + bulge},${y1} ${x + bulge},${y2} ${x},${y2}`, peer: true, active, label, lx: x + bulge * 0.8, ly: (y1 + y2) / 2 });
      return;
    }
    const x1 = p.x + NODE_W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2, dx = (x2 - x1) / 2;
    edges.push({ key: `${a}-${b}`, d: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`, peer: false, active, label, lx: x1 + dx, ly: (y1 + y2) / 2 - 6 });
  };
  curve("trigger", "cto", running);
  for (const p of pairs.values()) curve(p.from, p.to, running && p.active, p.n > 1 ? `${p.n}×` : undefined);
  curve("cto", "out");

  return { nodes, edges, width: pos.get("out")!.x + NODE_W + 40, height };
}
