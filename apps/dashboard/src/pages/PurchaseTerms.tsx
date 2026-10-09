import { useEffect, useState } from "react";
import { api, brl } from "../api";

interface Legal {
  name: string;
  document: string;
  email: string;
  city: string;
}
interface Rules {
  enabled: boolean;
  methods: { pix: boolean; card: boolean; wallet: boolean };
  feePercent: number;
  feeMinCents: number;
  maxCents: number;
  monthMaxCents: number;
  walletMaxCents: number;
  termsVersion: string;
}

/**
 * Termos de compra: as regras das compras feitas pelo assistente em nome da pessoa (CDC e LGPD).
 * Página pública em /termos-de-compra. Valores (taxa, limites) vêm das Configurações do dono.
 * Mudou algo importante aqui: suba TERMS_VERSION em purchases.ts para todo mundo aceitar de novo.
 */
export function PurchaseTermsPage() {
  const [legal, setLegal] = useState<Legal | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  useEffect(() => {
    api<{ legal?: Legal; purchases?: Rules }>("/api/auth/config").then(
      (c) => {
        setLegal(c.legal ?? null);
        setRules(c.purchases ?? null);
      },
      () => {},
    );
  }, []);
  const who = legal?.name ? `${legal.name}${legal.document ? ` (${legal.document})` : ""}` : "o responsável pela plataforma Planejai";
  const contact = legal?.email ? <a href={`mailto:${legal.email}`}>{legal.email}</a> : "o próprio assistente (peça para falar com o responsável)";
  const reais = (c?: number) => brl((c ?? 0) / 100);
  const fee = rules ? `${rules.feePercent}% do valor da loja, com mínimo de ${reais(rules.feeMinCents)}` : "a taxa mostrada antes de cada compra";

  return (
    <div className="legal">
      <div className="card card-pad legal-card">
        <a href="/" className="muted" style={{ fontSize: 13 }}>Voltar</a>
        <h1>Termos de compra</h1>
        <p className="muted">Atualizado em 9 de outubro de 2026. Valem junto com os <a href="/privacidade">Termos de uso e privacidade</a>.</p>

        <h3>O que é</h3>
        <p>
          Quando você pede, o assistente do Planejai compra para você numa loja online (por exemplo Mercado Livre, Shopee, Amazon ou Magalu): acha o
          produto, monta o carrinho na <b>sua conta da loja</b>, com o seu endereço, e vai até o pagamento. É um serviço de compra assistida
          prestado por {who}. Quem vende o produto é a loja (ou o vendedor dentro dela), não o Planejai.
        </p>

        <h3>Nada é pago sem o seu sim</h3>
        <ul>
          <li>Antes de pagar, o assistente mostra o produto, o total da loja (com frete), a taxa de serviço, quando houver, e a forma de pagamento. Só segue com o seu "sim".</li>
          <li>O valor vem do próprio código Pix gerado pela loja e é conferido pelo sistema na hora de pagar. Se mudar um centavo, a compra para.</li>
          <li>Um "sim" vale para uma compra só, e o pedido expira em 30 minutos.</li>
        </ul>

        <h3>Formas de pagar</h3>
        <ul>
          <li>
            <b>Pix direto:</b> o assistente te manda o Pix copia e cola da loja e você paga pelo seu banco. O dinheiro vai direto para a loja e não
            passa pelo Planejai. Sem taxa de serviço.
          </li>
          <li>
            <b>Cartão:</b> cobramos no seu cartão, pelo Asaas, o valor da loja mais a taxa de serviço ({fee}) e, aprovado, pagamos a loja por Pix. Na
            primeira vez você digita o cartão na página segura do Asaas; o número do cartão nunca passa pelo Planejai, que guarda só a bandeira e o
            final. Você pode tirar o cartão salvo quando quiser.
          </li>
          <li>
            <b>Saldo:</b> você carrega por Pix um saldo para compras e o assistente paga as lojas com ele (mais a taxa de serviço). O saldo não rende
            juros, não é conta bancária e só serve para compras pelo assistente. O que sobrar é devolvido por Pix para uma conta no seu CPF quando
            você pedir, em até 10 dias úteis.
          </li>
        </ul>
        {rules && (
          <p>
            Limites atuais: até {reais(rules.maxCents)} por compra e {reais(rules.monthMaxCents)} a cada 30 dias
            {rules.methods.wallet ? `; saldo máximo de ${reais(rules.walletMaxCents)}` : ""}. Eles podem mudar, sempre valendo o que aparece antes da compra.
          </p>
        )}

        <h3>Se algo der errado</h3>
        <ul>
          <li>Se a loja não aceitar o pagamento depois que você foi cobrado (sem estoque, Pix vencido, erro no checkout), o valor volta sozinho: estorno no cartão ou devolução para o saldo, e você recebe um aviso.</li>
          <li>Entrega, troca, garantia e defeito são com a loja, pelas regras dela e pelo Código de Defesa do Consumidor. O assistente te ajuda a pedir, mas a decisão é da loja.</li>
          <li>
            Direito de arrependimento (CDC, art. 49): nos 7 dias depois de receber o produto você pode desistir da compra pela loja. Quando a loja
            devolver o dinheiro de uma compra paga no cartão ou no saldo, o valor volta para você pelo mesmo caminho, junto com a taxa de serviço.
          </li>
          <li>Contestar no banco uma compra que foi entregue certinho atrasa a solução e pode suspender as compras pelo assistente. Fale com a gente primeiro: {contact}.</li>
        </ul>

        <h3>Sua conta na loja</h3>
        <ul>
          <li>Você entra na sua conta da loja pelo painel, numa janela que mostra a página da própria loja. Senha e códigos vão direto para a loja; o assistente nunca vê nem guarda sua senha.</li>
          <li>Guardamos só o login que a loja devolve (cookies), criptografado, para o assistente entrar na sua conta na hora de comprar. Você desconecta quando quiser em Compras.</li>
          <li>O assistente só usa a sua conta para as compras que você pedir, e nunca digita senha, código ou cartão em site nenhum.</li>
        </ul>

        <h3>Seus dados nas compras</h3>
        <p>
          Para comprar no cartão ou com saldo pedimos nome completo, CPF, data de nascimento e endereço de entrega. Eles ficam criptografados, só
          aparecem para você e vão apenas para o Asaas (para cobrar e cumprir as regras de pagamento) e para a loja (o endereço de entrega). Ficam
          enquanto sua conta existir e pelo prazo que a lei fiscal exigir. Você corrige ou apaga em Compras, ou apagando a conta. Mais detalhes nos{" "}
          <a href="/privacidade">Termos de uso e privacidade</a>.
        </p>

        <h3>O que o assistente não compra</h3>
        <p>
          Nada ilegal, armas e munição, remédios que pedem receita, bebida alcoólica ou cigarro, cartões-presente e saldo de outras plataformas,
          criptomoedas, ou qualquer coisa para revenda em quantidade. Pedidos assim são recusados.
        </p>

        <h3>Responsabilidades</h3>
        <ul>
          <li>Confira o produto, o tamanho, a cor e o endereço antes de dizer sim. O assistente pode errar, e o resumo antes do sim existe para isso.</li>
          <li>Respondemos pelo nosso serviço (montar a compra e pagar o valor aprovado). Problemas com o produto ou com a entrega são da loja.</li>
          <li>As compras pelo assistente são para maiores de 18 anos e podem ser pausadas em caso de abuso, suspeita de fraude ou contestação indevida.</li>
        </ul>

        <h3>Mudanças e foro</h3>
        <p>
          Quando estas regras mudarem de forma importante, você precisa aceitar de novo antes da próxima compra. Vale a lei brasileira
          {legal?.city ? `, com foro na comarca de ${legal.city}, ressalvado o seu direito de usar o foro do seu domicílio como consumidor` : ", com foro no seu domicílio como consumidor"}.
        </p>
      </div>
    </div>
  );
}
