import { type CSSProperties, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./icons";

/** Como funcionam as compras pelo assistente: o fluxo animado do Pix direto, com o recado certo para o cliente ou para o dono. */

type Audience = "cliente" | "dono";
type NodeId = "voce" | "assistente" | "loja" | "banco";

interface Step {
  from: NodeId;
  to: NodeId;
  /** dinheiro viaja como moeda roxa; mensagem viaja como balão */
  kind: "msg" | "money";
  chip: string;
  caption: string;
}

const NODES: NodeId[] = ["voce", "assistente", "loja", "banco"];
const NODE_ICON: Record<NodeId, string> = { voce: "user", assistente: "sparkle", loja: "shop", banco: "briefcase" };
/** tempo de cada passo no automático */
const STEP_MS = 3800;

function nodeLabel(id: NodeId, dono: boolean) {
  if (id === "voce") return dono ? "Cliente" : "Você";
  if (id === "assistente") return "Assistente";
  if (id === "loja") return "Loja";
  return dono ? "Banco" : "Seu banco";
}

function buildSteps(dono: boolean): Step[] {
  const v = (cliente: string, owner: string) => (dono ? owner : cliente);
  return [
    { from: "voce", to: "assistente", kind: "msg", chip: "quero esse", caption: v("Você pede pelo WhatsApp. O assistente acha o produto e confere preço e frete.", "O cliente pede pelo WhatsApp. O assistente acha o produto e confere preço e frete.") },
    { from: "assistente", to: "loja", kind: "msg", chip: "carrinho", caption: v("Ele entra na loja com a sua conta (conectada uma vez no painel), monta o carrinho e escolhe Pix no checkout.", "Ele entra na loja com a conta do próprio cliente (conectada uma vez no painel), monta o carrinho e escolhe Pix no checkout.") },
    { from: "loja", to: "assistente", kind: "msg", chip: "Pix da loja", caption: "A loja gera o Pix. O servidor lê o valor exato direto do código e confere os limites." },
    { from: "assistente", to: "voce", kind: "msg", chip: "total R$ 152,90", caption: "Mostra o total exato, com frete, e quem vai receber o Pix." },
    { from: "voce", to: "assistente", kind: "msg", chip: "sim", caption: v("Nada segue sem o seu \"sim\".", "Nada segue sem o \"sim\" do cliente, conferido pelo servidor.") },
    { from: "assistente", to: "voce", kind: "msg", chip: "Pix copia e cola", caption: v("Você recebe o código copia e cola no WhatsApp.", "O cliente recebe o código copia e cola no WhatsApp.") },
    { from: "voce", to: "banco", kind: "money", chip: "R$ 152,90", caption: v("Você paga no app do seu banco, como qualquer Pix.", "O cliente paga no app do banco dele, como qualquer Pix.") },
    { from: "banco", to: "loja", kind: "money", chip: "Pix", caption: "O dinheiro vai direto para a loja. Não passa pela Planejai e não tem taxa." },
    { from: "loja", to: "voce", kind: "msg", chip: "pedido a caminho", caption: v("Pedido confirmado, com entrega no seu endereço.", "Pedido confirmado, com entrega no endereço do cliente.") },
  ];
}

const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Explicação animada das compras pelo assistente, que fecham com Pix direto da pessoa para a loja. */
export function ComoFuncionaCompras({ audience }: { audience: Audience }) {
  const dono = audience === "dono";
  const steps = buildSteps(dono);
  const total = steps.length;
  const [step, setStep] = useState(0);
  // quem pediu menos movimento começa parado e anda no próprio ritmo
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % total), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, step, total]);

  const current = steps[Math.min(step, total - 1)]!;
  const a = NODES.indexOf(current.from);
  const b = NODES.indexOf(current.to);
  const go = (d: number) => {
    setPlaying(false);
    setStep((s) => (s + d + total) % total);
  };
  const stage = { "--n": NODES.length, "--a": a, "--b": b, "--lo": Math.min(a, b), "--hi": Math.max(a, b) } as CSSProperties;

  return (
    <section className="cf" aria-label="Como funcionam as compras pelo assistente">
      <div className="card cf-card">
        <div className={`cf-stage${a === b ? " cf-self" : ""}`} style={stage}>
          <div className="cf-line" aria-hidden="true" />
          {a !== b && <div className="cf-seg" aria-hidden="true" />}
          <ol className="cf-nodes">
            {NODES.map((id) => (
              <li key={id} className={`cf-node${id === current.to ? " is-to" : ""}${id === current.from ? " is-from" : ""}`}>
                <span className="cf-node-ico"><Icon name={NODE_ICON[id]} size={20} /></span>
                <span className="cf-node-label">{nodeLabel(id, dono)}</span>
              </li>
            ))}
          </ol>
          <span key={step} className={`cf-trip cf-${current.kind}`} aria-hidden="true">
            {current.kind === "money" ? <span className="cf-coin">R$</span> : <Icon name="mail" size={13} />}
            <span className="cf-chip">{current.chip}</span>
          </span>
        </div>

        <div className="cf-foot">
          <p className="cf-caption" aria-live="polite">
            <span className="cf-count">Passo {step + 1} de {total}</span>
            <span key={step} className="cf-caption-text">{current.caption}</span>
          </p>
          <div className="cf-controls">
            <div className="cf-dots" aria-hidden="true">
              {steps.map((_, i) => (
                <span key={i} className={i === step ? "on" : i < step ? "done" : ""} />
              ))}
            </div>
            <button type="button" className="icon-btn sm" aria-label="Passo anterior" onClick={() => go(-1)}><Icon name="chevron-left" size={16} /></button>
            <button type="button" className="icon-btn sm" aria-label={playing ? "Pausar" : "Reproduzir"} onClick={() => setPlaying((p) => !p)}>
              <Icon name={playing ? "pause" : "play"} size={15} />
            </button>
            <button type="button" className="icon-btn sm" aria-label="Próximo passo" onClick={() => go(1)}><Icon name="chevron-right" size={16} /></button>
          </div>
        </div>
      </div>

      {dono ? <OwnerBox /> : <ClientBox />}
    </section>
  );
}

function OwnerBox() {
  const rows: { icon: string; title: string; body: string }[] = [
    { icon: "wallet", title: "Onde fica o dinheiro", body: "Nunca com você. O cliente paga a loja direto do banco dele." },
    { icon: "receipt", title: "Taxa", body: "Não tem taxa por compra: não passa dinheiro pela sua conta." },
    { icon: "settings", title: "O que ligar", body: "Só ligar e ajustar os limites em Configurações. O Asaas é opcional: com ele, o assistente lê o valor de Pix dinâmico que não traz o valor escrito." },
  ];
  return (
    <div className="cf-box">
      <h4>Para você (dono)</h4>
      <ul>
        {rows.map((r) => (
          <li key={r.title}>
            <Icon name={r.icon} size={16} />
            <span><strong>{r.title}:</strong> {r.body}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ClientBox() {
  const items = ["Aceitar os Termos de compra.", "Conectar a sua conta da loja em Compras (uma vez só).", "Pagar o Pix no app do seu banco quando ele chegar."];
  return (
    <div className="cf-box">
      <h4>O que você precisa</h4>
      <ul>
        {items.map((t) => (
          <li key={t}>
            <Icon name="check" size={16} />
            <span>{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Resumo dos Termos de compra em tópicos, com link para o texto completo. */
export function ComprasPoliticaResumo() {
  const items = [
    "Sempre pede o seu \"sim\" antes de fechar qualquer compra.",
    "Mostra o total exato, com frete, lido do próprio Pix da loja.",
    "Você paga a loja direto do seu banco: o dinheiro não passa pela Planejai e não tem taxa.",
    "Cada compra e cada 30 dias têm limite.",
    "Entrega, troca e devolução são com a loja, como numa compra feita por você.",
    "Você desconecta a conta da loja quando quiser.",
  ];
  return (
    <div className="cf-box cf-policy">
      <h4><Icon name="shield" size={16} /> Regras das compras</h4>
      <ul>
        {items.map((t) => (
          <li key={t}>
            <Icon name="check" size={16} />
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <Link to="/termos-de-compra" className="cf-link">Ler os Termos de compra <Icon name="chevron-right" size={14} /></Link>
    </div>
  );
}
