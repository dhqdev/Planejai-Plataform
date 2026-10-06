import { useState } from "react";
import { Link } from "react-router-dom";
import { ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";

/** O time de agentes desenhado como um workflow do n8n: WhatsApp → CTO → especialistas. */
export function AgentsPage() {
  const { data, error } = useApi<any[]>("/api/agents");
  const [sel, setSel] = useState("cto");
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;

  const cto = data[0];
  const specialists = data.slice(1);
  const W = 210;
  const H = 70;
  const gap = 96;
  const height = Math.max(360, specialists.length * gap + 40);
  const midY = height / 2 - H / 2;
  const nodes = [
    { id: "whatsapp", x: 30, y: midY, icon: "💬", title: "WhatsApp", sub: "mensagens, áudios, fotos" },
    { id: "cto", x: 300, y: midY, icon: cto.emoji, title: cto.name, sub: cto.model },
    ...specialists.map((s: any, i: number) => ({ id: s.id, x: 600, y: 20 + i * gap, icon: s.emoji, title: s.name, sub: s.model })),
  ];
  const at = new Map(nodes.map((n) => [n.id, n]));
  const path = (a: string, b: string) => {
    const p = at.get(a)!;
    const q = at.get(b)!;
    const x1 = p.x + W, y1 = p.y + H / 2, x2 = q.x, y2 = q.y + H / 2, dx = (x2 - x1) / 2;
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  };
  const agent = data.find((a) => a.id === sel);

  return (
    <div className="page-wide">
      <PageHead
        title="Time de agentes"
        subtitle="O CTO conversa com a pessoa e delega para especialistas, cada um com suas ferramentas e seu modelo"
        actions={<Link className="btn" to="/models">Trocar modelos</Link>}
      />
      <div className="canvas" style={{ height }}>
        <div style={{ position: "relative", width: 860, height }}>
          <svg className="edges" width={860} height={height}>
            <path className="edge" d={path("whatsapp", "cto")} />
            {specialists.map((s: any) => (
              <path key={s.id} className={`edge ${sel === s.id ? "active" : ""}`} d={path("cto", s.id)} />
            ))}
          </svg>
          {nodes.map((n) => (
            <div key={n.id} className={`node ${sel === n.id ? "selected" : ""}`} style={{ left: n.x, top: n.y, width: W }} onClick={() => n.id !== "whatsapp" && setSel(n.id)}>
              <div className="node-title">
                <div className="node-icon">{n.icon}</div>
                {n.title}
              </div>
              <div className="node-sub ellipsis" style={{ maxWidth: W - 24 }}>{n.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {agent && (
        <div className="card card-pad" style={{ marginTop: 14 }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>{agent.emoji} {agent.name}</h3>
            <span className="badge badge-info">{agent.model}</span>
          </div>
          <p className="muted">{agent.role}</p>
          <table className="table">
            <thead><tr><th>Ferramenta</th><th>O que faz</th><th>Status</th></tr></thead>
            <tbody>
              {agent.tools.map((t: any) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td className="muted">{t.description}</td>
                  <td>
                    {t.available ? (
                      <span className="badge badge-ok">disponível</span>
                    ) : (
                      <Link to="/integrations" className="badge badge-warn">conectar {t.integration}</Link>
                    )}
                  </td>
                </tr>
              ))}
              {agent.id === "cto" && (
                <tr>
                  <td className="mono">ask_*</td>
                  <td className="muted">Delegação para cada especialista (em paralelo quando faz sentido)</td>
                  <td><span className="badge badge-ok">disponível</span></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
