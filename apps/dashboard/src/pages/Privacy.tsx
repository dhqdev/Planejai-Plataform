import { useEffect, useState } from "react";
import { api } from "../api";

interface Legal {
  name: string;
  document: string;
  email: string;
  city: string;
}

/**
 * Termos de uso e política de privacidade (LGPD e CDC). Página pública em /privacidade, aberta pelo cadastro
 * e pelo link que vai no convite do WhatsApp. Quem responde pelos dados vem de Configurações > Responsável pelos dados.
 */
export function PrivacyPage() {
  const [legal, setLegal] = useState<Legal | null>(null);
  const [pricing, setPricing] = useState<{ enabled: boolean; welcome: number } | null>(null);
  useEffect(() => {
    api<{ legal?: Legal; pricing?: { enabled: boolean; welcome: number } }>("/api/auth/config").then(
      (c) => {
        setLegal(c.legal ?? null);
        setPricing(c.pricing?.enabled ? c.pricing : null);
      },
      () => {},
    );
  }, []);
  const who = legal?.name ? `${legal.name}${legal.document ? ` (${legal.document})` : ""}` : "o responsável pela plataforma Planejai";
  const contact = legal?.email ? (
    <a href={`mailto:${legal.email}`}>{legal.email}</a>
  ) : (
    "o próprio assistente (peça para falar com o responsável)"
  );

  return (
    <div className="legal">
      <div className="card card-pad legal-card">
        <a href="/" className="muted" style={{ fontSize: 13 }}>Voltar</a>
        <h1>Termos de uso e privacidade</h1>
        <p className="muted">Atualizado em 9 de outubro de 2026.</p>

        <h3>Quem somos</h3>
        <p>
          O Planejai é um assistente pessoal no WhatsApp (e no Telegram, se você ligar) que anota gastos, cria lembretes, pesquisa, fica de olho em
          preços e manda recados por você. Ele usa modelos de inteligência artificial para entender suas mensagens. Quem decide como seus dados
          são tratados (controlador, na LGPD) é {who}. Para qualquer assunto sobre seus dados, inclusive falar com o encarregado, use {contact}.
        </p>
        <p>O Planejai é para maiores de 18 anos.</p>

        <h3>Quais dados tratamos, para quê e por quanto tempo</h3>
        <ul>
          <li>
            <b>Cadastro</b> (nome, WhatsApp, e-mail e senha guardada de forma irreversível): para criar e proteger sua conta, enquanto ela existir.
          </li>
          <li>
            <b>Suas mensagens</b>: ficam na memória curta do assistente por até 24 horas e depois viram um resumo curto. A conversa completa continua
            só no seu WhatsApp.
          </li>
          <li>
            <b>Registros técnicos</b> de cada resposta, para achar erros e medir custo: o texto some em 24 horas; ficam números como tempo, custo e
            modelo usado, por até 7 dias. Quem administra a plataforma vê só esses números das suas respostas, nunca o texto.
          </li>
          <li>
            <b>Ajuste automático</b>: uma vez por dia, uma revisão feita por computador (sem ninguém lendo) usa os registros do dia para ajustar como o
            assistente fala com você e quais agentes te ajudam. Se não concordar com algum ajuste, peça para desfazer.
          </li>
          <li>
            <b>O que você pede para guardar</b> (gastos, receitas, contas fixas, limites, lembretes, memórias, acompanhamentos e documentos que você
            salvou): até você apagar ou pedir para apagar tudo.
          </li>
          <li>
            <b>Fotos, áudios e documentos</b> que você manda: são lidos para entender o pedido. Só ficam guardados se você pedir (em Documentos). O que
            foi extraído deles (por exemplo, o valor de um comprovante) entra nos seus dados. Gravações de tela e prints feitos pelo assistente ficam
            até 7 dias.
          </li>
          <li>
            <b>Plano e grãos</b> (se houver cobrança): nome, CPF ou CNPJ, e-mail e telefone vão para o Asaas, que processa o pagamento. O CPF/CNPJ e
            os dados do cartão não ficam no Planejai; ficam o plano, o saldo e o extrato de grãos, as datas e o final do cartão, enquanto a conta existir e
            pelo prazo que a lei fiscal exigir.
          </li>
          <li>
            <b>Compras pelo assistente</b> (se você usar): o endereço de entrega, se você cadastrar, fica criptografado e vai só para a loja. Você
            paga a loja direto do seu banco, então nenhum dado de pagamento passa por aqui. Da sua conta na loja guardamos o login (cookies)
            criptografado, nunca a senha, até você desconectar. O histórico das compras fica enquanto a conta existir. As regras estão nos <a href="/termos-de-compra">Termos de compra</a>.
          </li>
          <li>
            <b>Contas conectadas</b> (Google Agenda, Gmail e outras que você ligar): usadas só para o que você pedir. As chaves ficam criptografadas e
            você desconecta quando quiser.
          </li>
          <li>
            <b>Cookies</b>: só os necessários para manter você logado (7 dias) e reconhecer um navegador já confirmado (1 ano). Nada de publicidade ou
            rastreamento.
          </li>
        </ul>
        <p>
          <b>Bases legais (LGPD, art. 7º):</b> execução do serviço que você contratou (cadastro, mensagens, lembretes, finanças, assinatura), seu
          consentimento (contas conectadas, recados e envios para terceiros, que só saem depois do seu "sim"), legítimo interesse (segurança,
          prevenção de abuso e registros técnicos) e obrigação legal (dados fiscais da assinatura).
        </p>

        <h3>Com quem os dados são compartilhados</h3>
        <ul>
          <li>Provedores de inteligência artificial (via OpenRouter), só com o trecho necessário para responder cada pedido.</li>
          <li>Serviços de busca e de mapas, com o termo ou o endereço pesquisado.</li>
          <li>WhatsApp (Meta) e Telegram, para entregar as mensagens.</li>
          <li>Asaas, para a cobrança da assinatura e, nas compras pelo assistente, para ler o valor de um Pix da loja (só leitura).</li>
          <li>Lojas onde você pede para o assistente comprar, com o que a compra precisa (produto e endereço de entrega), usando a sua própria conta nelas.</li>
          <li>Google e outros serviços que você mesmo conectar, só no que você pedir.</li>
          <li>
            Pessoas e estabelecimentos para quem você pede para mandar algo (convites, recados, agendamentos), com o que você aprovou. Você é
            responsável pelo que pede para enviar.
          </li>
          <li>Contatos com quem você compartilhou suas Finanças ou Agenda, só para ver, até você tirar o acesso.</li>
          <li>Autoridades, quando a lei ou uma ordem judicial exigir.</li>
        </ul>
        <p>
          Alguns desses serviços (como os provedores de IA, o OpenRouter e o Google) ficam fora do Brasil. A transferência acontece para cumprir o
          serviço que você pediu (LGPD, art. 33), com empresas que têm suas próprias regras de segurança. Não vendemos seus dados nem usamos para
          publicidade.
        </p>

        <h3>Segurança</h3>
        <p>
          Senhas guardadas com hash, chaves de integração criptografadas, acesso restrito a cada pessoa (inclusive para quem administra), conexão
          criptografada e cópias de segurança diárias. Nenhum sistema é infalível: se acontecer um incidente que possa te prejudicar, avisamos você e
          a ANPD (LGPD, art. 48).
        </p>

        <h3>Seus direitos (LGPD, art. 18)</h3>
        <p>
          Você pode confirmar se tratamos seus dados, ver, corrigir, levar para outro serviço (portabilidade), saber com quem compartilhamos, revogar
          um consentimento e pedir a exclusão. Para apagar tudo, mande "apague todos os meus dados" para o assistente ou use o botão "Apagar minha
          conta e meus dados" em Minha conta no painel. A exclusão é definitiva e inclui gastos, lembretes, memórias, documentos, contatos e o login;
          só as cópias de segurança guardam o que foi apagado por até 14 dias, até serem substituídas. Os outros pedidos vão para {contact}, e
          respondemos em até 15 dias. Se não ficar satisfeito, você pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD).
        </p>

        {pricing && (
          <>
            <h3>Plano e grãos</h3>
            <ul>
              <li>
                O assistente funciona com grãos: cada resposta gasta alguns, conforme o trabalho que deu.{pricing.welcome > 0 ? ` Toda conta nova ganha ${pricing.welcome.toLocaleString("pt-BR")} grãos para começar.` : ""}
              </li>
              <li>
                O plano mensal recarrega os grãos dele a cada mês pago (o que sobra do mês não acumula). Pacotes avulsos não vencem. Os preços estão em
                Plano e grãos no painel; o preço de quem já assina só muda com aviso antes.
              </li>
              <li>Você cancela quando quiser, em Plano e grãos no painel; os grãos que já estão na conta continuam valendo até acabar.</li>
              <li>
                Direito de arrependimento (Código de Defesa do Consumidor, art. 49): nos 7 dias depois de uma compra, você pode desistir e receber o
                valor de volta, pelo mesmo canal de contato acima.
              </li>
              <li>Sem grãos ou com a mensalidade vencida, o assistente pausa até comprar mais; seus dados não são apagados por isso.</li>
            </ul>
          </>
        )}

        <h3>Regras de uso</h3>
        <ul>
          <li>Não use o assistente para golpes, spam, assédio ou qualquer coisa ilegal, nem para mandar mensagens a quem não quer recebê-las.</li>
          <li>Pagamentos, envios, recados e convites só acontecem depois que você confirma.</li>
          <li>
            As respostas são geradas por IA e podem conter erros: confira antes de decisões importantes, principalmente com dinheiro, saúde ou
            assuntos jurídicos. O assistente não substitui um profissional.
          </li>
          <li>O acesso pode ser suspenso em caso de abuso ou de risco para outras pessoas ou para o serviço.</li>
          <li>Dependemos do WhatsApp e de outros serviços; se algum deles sair do ar, o assistente pode ficar indisponível por um tempo.</li>
        </ul>

        <h3>Mudanças e foro</h3>
        <p>
          Quando estes termos mudarem de forma importante, avisamos pelo assistente antes de valer. Vale a lei brasileira
          {legal?.city ? `, com foro na comarca de ${legal.city}, ressalvado o seu direito de usar o foro do seu domicílio como consumidor` : ", com foro no seu domicílio como consumidor"}.
        </p>
      </div>
    </div>
  );
}
