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
  maxCents: number;
  monthMaxCents: number;
  termsVersion: string;
}

/**
 * Termos de compra: as regras das compras feitas pelo assistente em nome da pessoa (CDC e LGPD).
 * Página pública em /termos-de-compra. Os limites vêm das Configurações do dono.
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

  return (
    <div className="legal">
      <div className="card card-pad legal-card">
        <a href="/" className="muted" style={{ fontSize: 13 }}>Voltar</a>
        <h1>Termos de compra</h1>
        <p className="muted">Atualizado em 9 de outubro de 2026. Valem junto com os <a href="/privacidade">Termos de uso e privacidade</a>.</p>

        <h3>O que é</h3>
        <p>
          Quando você pede, o assistente do Planejai compra para você numa loja online (por exemplo Mercado Livre, Shopee, Amazon ou Magalu): acha o
          produto, monta o carrinho na <b>sua conta da loja</b>, com o seu endereço, e vai até o Pix do checkout. Quem paga é você, pelo seu
          banco. É um serviço de compra assistida prestado por {who}. Quem vende o produto é a loja (ou o vendedor dentro dela), não o Planejai.
        </p>

        <h3>Nada é fechado sem o seu sim</h3>
        <ul>
          <li>Antes de fechar, o assistente mostra o produto, o total da loja (com frete) e quem vai receber o Pix. Só segue com o seu "sim".</li>
          <li>O valor vem do próprio código Pix gerado pela loja, lido pelo sistema, nunca digitado pelo assistente.</li>
          <li>Um "sim" vale para uma compra só, e o pedido expira em 30 minutos. Um Pix que você não pagou em 2 dias sai da lista.</li>
        </ul>

        <h3>Como você paga</h3>
        <p>
          Depois do seu sim, o assistente te manda o Pix copia e cola da loja e você paga pelo app do seu banco, como qualquer Pix. O dinheiro vai
          direto para a loja e não passa pelo Planejai. Não há taxa de serviço por compra. Confira no seu banco, antes de pagar, se quem recebe é a
          loja certa.
        </p>
        {rules && (
          <p>
            Limites atuais: até {reais(rules.maxCents)} por compra e {reais(rules.monthMaxCents)} a cada 30 dias. Eles podem mudar, sempre valendo o
            que aparece antes da compra.
          </p>
        )}

        <h3>Se algo der errado</h3>
        <ul>
          <li>Como o pagamento é feito por você direto para a loja, reembolso, entrega, troca, garantia e defeito são com a loja, pelas regras dela e pelo Código de Defesa do Consumidor. O assistente te ajuda a pedir, mas a decisão é da loja.</li>
          <li>Direito de arrependimento (CDC, art. 49): nos 7 dias depois de receber o produto você pode desistir da compra pela loja, e a loja devolve o dinheiro.</li>
          <li>Se o assistente montar algo diferente do que você pediu, não pague o Pix: o pedido não é fechado e cai sozinho. Dúvidas: {contact}.</li>
        </ul>

        <h3>Sua conta na loja</h3>
        <ul>
          <li>Você entra na sua conta da loja pelo painel, numa janela que mostra a página da própria loja. Senha e códigos vão direto para a loja; o assistente nunca vê sua senha.</li>
          <li>Guardamos o login que a loja devolve (cookies), ou os cookies que você colar da loja já logada, criptografado, para o assistente entrar na sua conta na hora de comprar. Você desconecta quando quiser em Compras.</li>
          <li>
            <b>Login automático (opcional):</b> se você salvar o e-mail e a senha de uma loja, eles ficam criptografados e, quando o login vencer, o
            sistema digita os dois direto no site daquela loja, sem o assistente ver. Se a loja mandar um código por e-mail e o seu Gmail estiver
            conectado, o sistema procura o código só nos e-mails recentes daquela loja e digita do mesmo jeito. Você apaga o acesso quando quiser.
          </li>
          <li>Você também pode cadastrar uma loja que não está na lista, pelo site dela. A compra só fecha se a loja aceitar Pix.</li>
          <li>O assistente só usa a sua conta para as compras que você pedir, e nunca digita cartão em site nenhum.</li>
        </ul>

        <h3>Seus dados nas compras</h3>
        <p>
          Se você cadastrar, o endereço de entrega fica criptografado, só aparece para você e vai só para a loja. Sem ele, o assistente usa o
          endereço da sua conta na loja. Para ler o valor de um Pix dinâmico, o código Pix da loja pode ser consultado no Asaas (só leitura, nada é
          cobrado). O histórico das compras fica enquanto sua conta existir. Você corrige ou apaga em Compras, ou apagando a conta. Mais detalhes
          nos <a href="/privacidade">Termos de uso e privacidade</a>.
        </p>

        <h3>O que o assistente não compra</h3>
        <p>
          Nada ilegal, armas e munição, remédios que pedem receita, bebida alcoólica ou cigarro, cartões-presente e saldo de outras plataformas,
          criptomoedas, ou qualquer coisa para revenda em quantidade. Pedidos assim são recusados.
        </p>

        <h3>Responsabilidades</h3>
        <ul>
          <li>Confira o produto, o tamanho, a cor e o endereço antes de dizer sim. O assistente pode errar, e o resumo antes do sim existe para isso.</li>
          <li>Respondemos pelo nosso serviço (montar a compra e te mandar o Pix certo da loja). Problemas com o produto ou com a entrega são da loja.</li>
          <li>As compras pelo assistente são para maiores de 18 anos e podem ser pausadas em caso de abuso ou suspeita de fraude.</li>
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
