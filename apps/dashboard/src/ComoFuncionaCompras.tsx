import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./icons";

/** Como funcionam as compras pelo assistente: um fluxo animado por forma de pagamento, com o recado certo para o cliente ou para o dono. */

type Audience = "cliente" | "dono";
type MethodKey = "pix" | "card" | "wallet";
type NodeId = "voce" | "assistente" | "loja" | "asaas" | "banco";

interface Step {
  from: NodeId;
  to: NodeId;
  /** dinheiro viaja como moeda roxa; mensagem viaja como balão */
  kind: "msg" | "money";
  chip: string;
  caption: string;
}
interface Flow {
  label: string;
  icon: string;
  nodes: NodeId[];
  steps: Step[];
}

const NODE_ICON: Record<NodeId, string> = { voce: "user", assistente: "sparkle", loja: "shop", asaas: "shield", banco: "briefcase" };
const ORDER: MethodKey[] = ["pix", "card", "wallet"];
/** tempo de cada passo no automático */
const STEP_MS = 3800;

function nodeLabel(id: NodeId, dono: boolean) {
  if (id === "voce") return dono ? "Cliente" : "Você";
  if (id === "assistente") return "Assistente";
  if (id === "loja") return "Loja";
  if (id === "asaas") return "Asaas";
  return dono ? "Banco" : "Seu banco";
}

function buildFlows(dono: boolean): Record<MethodKey, Flow> {
  const v = (cliente: string, owner: string) => (dono ? owner : cliente);
  return {
    pix: {
      label: "Pix direto",
      icon: "send",
      nodes: ["voce", "assistente", "loja", "banco"],
      steps: [
        { from: "voce", to: "assistente", kind: "msg", chip: "quero esse", caption: v("Você pede pelo WhatsApp. O assistente acha o produto e confere preço e frete.", "O cliente pede pelo WhatsApp. O assistente acha o produto e confere preço e frete.") },
        { from: "assistente", to: "loja", kind: "msg", chip: "carrinho", caption: v("Ele entra na loja com a sua conta (conectada uma vez no painel), monta o carrinho e chega no checkout.", "Ele entra na loja com a conta do próprio cliente (conectada uma vez no painel), monta o carrinho e chega no checkout.") },
        { from: "assistente", to: "voce", kind: "msg", chip: "total R$ 152,90", caption: "Mostra o total exato, com frete, e pergunta se pode fechar." },
        { from: "voce", to: "assistente", kind: "msg", chip: "sim", caption: v("O pedido só é feito com o seu \"sim\".", "O pedido só é feito com o \"sim\" do cliente, conferido pelo servidor.") },
        { from: "loja", to: "voce", kind: "msg", chip: "Pix copia e cola", caption: v("A loja gera o Pix e o assistente te manda o código copia e cola no WhatsApp.", "A loja gera o Pix e o assistente manda o código copia e cola no WhatsApp do cliente.") },
        { from: "voce", to: "banco", kind: "money", chip: "R$ 152,90", caption: v("Você paga no app do seu banco, como qualquer Pix.", "O cliente paga no app do banco dele, como qualquer Pix.") },
        { from: "banco", to: "loja", kind: "money", chip: "Pix", caption: "O dinheiro vai direto para a loja. Não passa pela Planejai e não tem taxa." },
        { from: "loja", to: "voce", kind: "msg", chip: "pedido a caminho", caption: v("Pedido confirmado, com entrega no seu endereço.", "Pedido confirmado, com entrega no endereço do cliente.") },
      ],
    },
    card: {
      label: "Cartão",
      icon: "card",
      nodes: ["voce", "assistente", "asaas", "loja"],
      steps: [
        { from: "voce", to: "assistente", kind: "msg", chip: "compra pra mim", caption: v("Você pede pelo WhatsApp. O assistente acha o produto e monta o carrinho.", "O cliente pede pelo WhatsApp. O assistente acha o produto e monta o carrinho.") },
        { from: "assistente", to: "loja", kind: "msg", chip: "checkout", caption: v("Chega no checkout da loja com a sua conta e pede o pagamento por Pix.", "Chega no checkout da loja com a conta do cliente e pede o pagamento por Pix.") },
        { from: "loja", to: "assistente", kind: "msg", chip: "Pix da loja", caption: "A loja gera o Pix. O servidor confere se o valor bate certinho com o total." },
        { from: "assistente", to: "voce", kind: "msg", chip: "total + taxa · final 4242", caption: "Antes de cobrar, mostra o total, a taxa do serviço e o final do cartão." },
        { from: "voce", to: "assistente", kind: "msg", chip: "sim", caption: v("Só segue com o seu \"sim\". Cada compra e cada mês têm limite.", "Só segue com o \"sim\" do cliente. Cada compra e cada mês têm limite.") },
        { from: "voce", to: "asaas", kind: "money", chip: "cartão", caption: v("O Asaas cobra o cartão. Na primeira vez você digita os dados na página segura dele; depois vale o cartão salvo lá. A Planejai nunca guarda o número.", "O Asaas cobra o cartão. Na primeira vez o cliente digita os dados na página segura dele; depois vale o cartão salvo lá. A Planejai nunca guarda o número.") },
        { from: "asaas", to: "loja", kind: "money", chip: "Pix", caption: "Com a cobrança aprovada, a Planejai paga o Pix da loja pela conta dela no Asaas." },
        { from: "loja", to: "voce", kind: "msg", chip: "pedido confirmado", caption: "Pedido feito. Se algo falhar depois da cobrança, o cartão é estornado sozinho." },
      ],
    },
    wallet: {
      label: "Saldo",
      icon: "wallet",
      nodes: ["voce", "assistente", "asaas", "loja"],
      steps: [
        { from: "voce", to: "asaas", kind: "money", chip: "Pix R$ 200,00", caption: v("Você coloca saldo por Pix (só Pix). Tudo aparece no extrato do painel, em centavos.", "O cliente coloca saldo por Pix (só Pix). Tudo aparece no extrato do painel, em centavos.") },
        { from: "voce", to: "assistente", kind: "msg", chip: "compra pra mim", caption: v("Na hora de comprar, você pede pelo WhatsApp e o assistente monta o carrinho.", "Na hora de comprar, o cliente pede pelo WhatsApp e o assistente monta o carrinho.") },
        { from: "assistente", to: "loja", kind: "msg", chip: "checkout", caption: "Chega no checkout e pega o Pix da loja. O servidor confere o valor exato." },
        { from: "assistente", to: "voce", kind: "msg", chip: "total + taxa", caption: "Mostra o total, a taxa e quanto sobra de saldo." },
        { from: "voce", to: "assistente", kind: "msg", chip: "sim", caption: v("Só segue com o seu \"sim\".", "Só segue com o \"sim\" do cliente, conferido pelo servidor.") },
        { from: "asaas", to: "asaas", kind: "money", chip: "reserva", caption: "O valor fica reservado no saldo, para não ser usado duas vezes." },
        { from: "asaas", to: "loja", kind: "money", chip: "Pix", caption: "A Planejai paga o Pix da loja pelo Asaas e a reserva vira débito no extrato." },
        { from: "loja", to: "voce", kind: "msg", chip: "pedido confirmado", caption: "Pedido feito. Se o pagamento falhar, a reserva volta para o saldo." },
      ],
    },
  };
}

const prefersReducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Explicação animada das compras pelo assistente: Pix direto, cartão e saldo. Sem `methods`, mostra as três. */
export function ComoFuncionaCompras({ audience, methods }: { audience: Audience; methods?: { pix: boolean; card: boolean; wallet: boolean } }) {
  const dono = audience === "dono";
  const flows = buildFlows(dono);
  const enabled = ORDER.filter((k) => !methods || methods[k]);
  const [picked, setPicked] = useState<MethodKey>(enabled[0] ?? "pix");
  const [step, setStep] = useState(0);
  // quem pediu menos movimento começa parado e anda no próprio ritmo
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());

  const tab = enabled.includes(picked) ? picked : enabled[0];
  const flow = tab ? flows[tab] : null;
  const total = flow?.steps.length ?? 0;

  useEffect(() => {
    if (!playing || !total) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % total), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, step, total]);

  if (!tab || !flow) return null;

  const current = flow.steps[Math.min(step, total - 1)]!;
  const a = flow.nodes.indexOf(current.from);
  const b = flow.nodes.indexOf(current.to);
  const pick = (k: MethodKey) => {
    setPicked(k);
    setStep(0);
  };
  const go = (d: number) => {
    setPlaying(false);
    setStep((s) => (s + d + total) % total);
  };
  const stage = { "--n": flow.nodes.length, "--a": a, "--b": b, "--lo": Math.min(a, b), "--hi": Math.max(a, b) } as CSSProperties;

  return (
    <section className="cf" aria-label="Como funcionam as compras pelo assistente">
      {enabled.length > 1 && (
        <div className="tabs cf-tabs" role="tablist" aria-label="Formas de pagamento">
          {enabled.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={k === tab} className={k === tab ? "active" : ""} onClick={() => pick(k)}>
              <Icon name={flows[k].icon} size={15} /> {flows[k].label}
            </button>
          ))}
        </div>
      )}

      <div className="card cf-card">
        <div className={`cf-stage${a === b ? " cf-self" : ""}`} style={stage}>
          <div className="cf-line" aria-hidden="true" />
          {a !== b && <div className="cf-seg" aria-hidden="true" />}
          <ol className="cf-nodes">
            {flow.nodes.map((id) => (
              <li key={id} className={`cf-node${id === current.to ? " is-to" : ""}${id === current.from ? " is-from" : ""}`}>
                <span className="cf-node-ico"><Icon name={NODE_ICON[id]} size={20} /></span>
                <span className="cf-node-label">{nodeLabel(id, dono)}</span>
              </li>
            ))}
          </ol>
          <span key={`${tab}-${step}`} className={`cf-trip cf-${current.kind}`} aria-hidden="true">
            {current.kind === "money" ? <span className="cf-coin">R$</span> : <Icon name="mail" size={13} />}
            <span className="cf-chip">{current.chip}</span>
          </span>
        </div>

        <div className="cf-foot">
          <p className="cf-caption" aria-live="polite">
            <span className="cf-count">Passo {step + 1} de {total}</span>
            <span key={`${tab}-${step}`} className="cf-caption-text">{current.caption}</span>
          </p>
          <div className="cf-controls">
            <div className="cf-dots" aria-hidden="true">
              {flow.steps.map((_, i) => (
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

      {dono ? <OwnerBox method={tab} /> : <ClientBox method={tab} />}
    </section>
  );
}

function OwnerBox({ method }: { method: MethodKey }) {
  const site = typeof window === "undefined" ? "" : window.location.origin;
  const asaasSetup = (
    <>
      Ligue a permissão de <strong>pagamento de Pix pela API</strong> e o <strong>webhook de validação de saque</strong> em <code>{site}/webhooks/asaas/saque</code>, com o mesmo token do webhook.
    </>
  );
  const rows: { icon: string; title: string; body: ReactNode }[] =
    method === "pix"
      ? [
          { icon: "wallet", title: "Onde fica o dinheiro", body: "Nunca com você. O cliente paga a loja direto do banco dele." },
          { icon: "receipt", title: "Taxa", body: "Não tem taxa por compra: não há dinheiro passando pela sua conta." },
          { icon: "settings", title: "No Asaas", body: "Nada a ligar. O cliente só conecta a conta da loja em Compras." },
        ]
      : method === "card"
        ? [
            { icon: "wallet", title: "Onde fica o dinheiro", body: "Minutos na sua conta Asaas: entra a cobrança do cartão e sai o Pix da loja. Só que o dinheiro do cartão cai uns 30 dias depois, então você precisa de capital de giro ou de antecipação. E existe risco de chargeback." },
            { icon: "receipt", title: "O que a taxa cobre", body: "A tarifa do Asaas no cartão, a antecipação (se usar) e o risco de chargeback." },
            { icon: "settings", title: "No Asaas", body: asaasSetup },
          ]
        : [
            { icon: "wallet", title: "Onde fica o dinheiro", body: "Dias ou meses na sua conta: é dinheiro do cliente guardado com você. Isso esbarra nas regras do Banco Central para contas pré-pagas, então fale com um advogado e um contador antes de ligar. Recarga só por Pix." },
            { icon: "receipt", title: "O que a taxa cobre", body: "O Pix de saída para a loja e a operação do saldo." },
            { icon: "settings", title: "No Asaas", body: asaasSetup },
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

function ClientBox({ method }: { method: MethodKey }) {
  const items =
    method === "pix"
      ? ["Conectar a sua conta da loja em Compras (uma vez só)."]
      : method === "card"
        ? ["Conta da loja conectada em Compras.", "CPF, data de nascimento e endereço no cadastro.", "Aceitar os Termos de compra.", "O cartão você coloca na primeira compra, na página segura do Asaas."]
        : ["Conta da loja conectada em Compras.", "Colocar saldo por Pix."];
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
    "Sempre pede o seu \"sim\" antes de pagar qualquer coisa.",
    "Mostra o total exato (produto, frete e taxa, quando tiver) antes de você confirmar.",
    "Cada compra e cada mês têm limite.",
    "Se a loja falhar, o dinheiro volta: estorno no cartão ou de volta para o saldo.",
    "Seus dados vão só para o Asaas (pagamento) e para a loja (entrega).",
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
