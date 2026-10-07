/**
 * Reação instantânea, antes de qualquer IA: escolhe um emoji pelo tema da mensagem (cinema 🍿, viagem ✈️...).
 * É a primeira coisa que a pessoa vê, em milissegundos e sem gastar token. O CTO pode trocar depois por ✅
 * quando concluir uma tarefa (no WhatsApp a reação nova substitui a anterior).
 */
const THEMES: [RegExp, string][] = [
  [/\b(obrigad|valeu|vlw|agradec|brigad)/, "🙏"],
  [/\b(kkk|haha|rsrs|kkkk|hahaha|engracad|piada)/, "😂"],
  [/\b(te amo|amo voce|saudade|amor|namorad|casamento|noiva)/, "❤️"],
  [/\b(parabens|aniversario|niver|festa|comemor|formatura|passei|consegui)/, "🎉"],
  [/\b(gastei|paguei|comprei|pix|boleto|fatura|conta de|dinheiro|salario|recebi|transferi|gasto|despesa|orcamento|economizar)/, "💸"],
  [/\b(cinema|filme|serie|netflix|sessao|ingresso|estreia|pipoca)/, "🍿"],
  [/\b(show\b|musica|cantor|banda|spotify|playlist|festival)/, "🎵"],
  [/\b(futebol|jogo do|campeonato|time do|gol\b|palmeiras|corinthians|flamengo|sao paulo|santos)/, "⚽"],
  [/\b(academia|treino|corrida|correr|dieta|emagrec|musculac)/, "💪"],
  [/\b(medic|doente|dor de|hospital|remedio|consulta|febre|saude)/, "🩺"],
  [/\b(viagem|viajar|voo|passagem|hotel|ferias|praia|aeroporto|airbnb)/, "✈️"],
  [/\b(restaurante|jantar|almoc|comida|pizza|hamburguer|lanche|receita|cozinhar|cafe da manha|ifood)/, "🍽️"],
  [/\b(cerveja|bar\b|drink|vinho|happy hour|balada)/, "🍻"],
  [/\b(celular|iphone|samsung|xiaomi|notebook|computador|fone|airpods|tablet|ipad|playstation|ps5|xbox)/, "📱"],
  [/\b(carro|moto|uber|gasolina|combustivel|estacionamento|ipva|oficina)/, "🚗"],
  [/\b(casa|aluguel|apartamento|mudanca|condominio|imovel)/, "🏠"],
  [/\b(preco|promocao|desconto|oferta|mercado livre|comprar|loja|black friday)/, "🛒"],
  [/\b(lembr|lembrete|agenda|reuniao|compromisso|amanha as|horario|marcar)/, "📅"],
  [/\b(chuva|tempo amanha|previsao|calor|frio|temperatura|clima)/, "🌦️"],
  [/\b(trabalho|chefe|emprego|entrevista|curriculo|projeto|cliente|reuniao)/, "💼"],
  [/\b(estud|prova|faculdade|escola|curso|livro|ler\b)/, "📚"],
  [/\b(cachorro|gato|pet|veterinari)/, "🐶"],
  [/\b(triste|chateado|cansado|estressad|ansios|mal hoje|dificil)/, "🫂"],
  [/\b(bom dia|boa tarde|boa noite|oi|ola|e ai|eai|opa)\b/, "👋"],
];

const strip = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

export function pickReaction(text: string, kind?: string): string {
  const t = strip(text ?? "");
  for (const [re, emoji] of THEMES) if (re.test(t)) return emoji;
  if (kind === "audio") return "🎧";
  if (kind === "image" || kind === "sticker") return "👀";
  if (kind === "document") return "📄";
  if (t.includes("?")) return "👀";
  return "👍";
}

/**
 * Mensagem que só agradece/confirma ("valeu", "ok", "kkk", "👍"): a reação já responde e nem chama a IA.
 * "ok"/"sim"/"pode" só contam como agradecimento se o assistente não acabou de perguntar algo.
 */
const THANKS = /^(valeu+|vlw+|obrigad[oa]s?|obg|brigad[oa]|tmj|show( de bola)?|top|massa|perfeito|otimo|blz|beleza|kk+|k{3,}|ha(ha)+|rs(rs)*|boa|show demais|muito obrigad[oa]|valeu mesmo|fechou|tranquilo|de nada)$/;
const CONFIRM = /^(ok+|okay|certo|ta|ta bom|entendi|sim|pode|isso|combinado|fechado|blz|beleza)$/;
export function isAckOnly(texts: string[], assistantAsked: boolean) {
  if (!texts.length) return false;
  return texts.every((raw) => {
    const t = strip(raw).replace(/[!.,~]+/g, " ").replace(/\s+/g, " ").trim();
    const noEmoji = t.replace(/[\p{Extended_Pictographic}\u200d\ufe0f\u{1F3FB}-\u{1F3FF}]/gu, "").trim();
    if (!noEmoji) return t.length > 0; // só emoji
    if (t.length > 40) return false;
    const words = noEmoji.replace(/ (a?mig[oa]|cara|mano|demais|viu|ai|hein|entao)$/g, "");
    return THANKS.test(words) || (!assistantAsked && CONFIRM.test(words));
  });
}
