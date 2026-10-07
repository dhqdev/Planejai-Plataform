/**
 * Termos de uso e política de privacidade (LGPD). Página pública em /privacidade, aberta pelo cadastro
 * e pelo link que vai no convite do WhatsApp.
 */
export function PrivacyPage() {
  return (
    <div className="legal">
      <div className="card card-pad legal-card">
        <a href="/" className="muted" style={{ fontSize: 13 }}>Voltar</a>
        <h1>Termos de uso e privacidade</h1>
        <p className="muted">Atualizado em 7 de outubro de 2026.</p>

        <h3>O que é o Planejai</h3>
        <p>
          Um assistente no WhatsApp (e no Telegram, se você ligar) que anota gastos, cria lembretes, pesquisa coisas e fica de olho em preços para
          você. Ele usa modelos de inteligência artificial para entender suas mensagens. A entrada é só por convite.
        </p>

        <h3>Quais dados guardamos e por quanto tempo</h3>
        <ul>
          <li>Seu nome, número de WhatsApp e e-mail (se você criar login no painel): enquanto sua conta existir.</li>
          <li>Suas mensagens: ficam só na memória curta do assistente por até 24 horas e depois viram um resumo curto. A conversa completa continua só no seu WhatsApp.</li>
          <li>Registros técnicos de cada resposta (para achar erros e medir custo): o texto é apagado depois de 24 horas; ficam só números como tempo, custo e modelo usado, por até 7 dias.</li>
          <li>Gastos, receitas, limites, lembretes, memórias que você pediu para guardar e acompanhamentos: até você apagar ou pedir para apagar tudo.</li>
          <li>Fotos, áudios e documentos que você manda: são lidos para entender o pedido e não ficam guardados. O que foi extraído deles (por exemplo, o valor de um comprovante) entra nos seus dados.</li>
        </ul>

        <h3>Com quem os dados são compartilhados</h3>
        <ul>
          <li>Provedores de inteligência artificial (via OpenRouter), só com o trecho necessário para responder cada pedido.</li>
          <li>Serviços de busca na internet, com o termo pesquisado.</li>
          <li>O WhatsApp e o Telegram, para entregar as mensagens.</li>
          <li>Contatos que você convidou, só quando você pede para mandar algo para eles.</li>
        </ul>
        <p>Não vendemos seus dados nem usamos para publicidade.</p>

        <h3>Seus direitos (LGPD, art. 18)</h3>
        <p>
          Você pode ver, corrigir e apagar seus dados quando quiser. Para apagar tudo, mande "apague todos os meus dados" para o assistente ou use
          o botão "Apagar minha conta e meus dados" em Minha conta no painel. A exclusão é definitiva e inclui gastos, lembretes, memórias,
          contatos e o login.
        </p>

        <h3>Regras de uso</h3>
        <ul>
          <li>Não use o assistente para golpes, spam, assédio ou qualquer coisa ilegal.</li>
          <li>Pagamentos, envios e convites só acontecem depois que você confirma.</li>
          <li>As respostas são geradas por IA e podem conter erros: confira antes de decisões importantes, principalmente com dinheiro.</li>
          <li>O acesso pode ser suspenso em caso de abuso.</li>
        </ul>

        <h3>Contato</h3>
        <p>Dúvidas sobre seus dados: fale com quem te convidou ou mande mensagem para o próprio assistente pedindo para falar com o responsável.</p>
      </div>
    </div>
  );
}
