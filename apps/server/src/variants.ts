/**
 * Variação do produto (tamanho, cor, voltagem, capacidade). O link certo é o que já cai na variação que a pessoa quer:
 * tênis 42 preto, air fryer 220V, iPhone 128 GB. Aqui ficam as regras de texto, sem rede:
 * o que falta perguntar antes de buscar, o que a pessoa pediu, o que um anúncio diz e o que bate.
 */

export type Dim = "size" | "color" | "voltage" | "capacity";
export type Wanted = Partial<Record<Dim, string>>;

/** minúsculas, sem acento, sem pontuação, e "128 GB" / "220 V" juntos ("128gb", "220v") para comparar */
export const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(\d+)\s+(gb|tb|v)\b/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()} `;

const COLORS: [RegExp, string][] = [
  [/ (preto|preta|black) /, "preto"],
  [/ (branco|branca|white|off white) /, "branco"],
  [/ (azul marinho|marinho) /, "azul marinho"],
  [/ (azul|blue) /, "azul"],
  [/ (vermelho|vermelha|red) /, "vermelho"],
  [/ (verde|green) /, "verde"],
  [/ (amarelo|amarela) /, "amarelo"],
  [/ (rosa|pink) /, "rosa"],
  [/ (roxo|roxa|lilas|violeta) /, "roxo"],
  [/ (cinza|grafite|chumbo) /, "cinza"],
  [/ (prata|prateado|prateada|silver) /, "prata"],
  [/ (dourado|dourada|gold) /, "dourado"],
  [/ (marrom|caramelo|chocolate) /, "marrom"],
  [/ (bege|nude|areia|creme) /, "bege"],
  [/ (laranja) /, "laranja"],
  [/ (vinho|bordo) /, "vinho"],
];

const SHOE = / (tenis|sapato|sapatenis|chinelo|sandalia|bota|botina|coturno|chuteira|sapatilha|rasteirinha|tamanco|mocassim|scarpin|slide|crocs) /;
const CLOTHES =
  / (camiseta|camisa|blusa|calca|bermuda|short|shorts|vestido|saia|jaqueta|casaco|moletom|regata|cueca|calcinha|sutia|pijama|legging|macacao|blazer|polo|jeans|body|cropped|biquini|maio|sunga|uniforme) /;
const VOLTAGE =
  / (air fryer|airfryer|fritadeira|liquidificador|micro ondas|microondas|cafeteira|ventilador|aspirador|batedeira|sanduicheira|chaleira eletrica|ferro de passar|secador|chapinha|prancha|geladeira|refrigerador|freezer|maquina de lavar|lavadora|lava e seca|forno eletrico|panela eletrica|mixer|processador|multiprocessador|purificador|bebedouro|furadeira|parafusadeira|esmerilhadeira|serra|lava jato|lavadora de alta pressao|climatizador|ar condicionado|grill|torradeira|espremedor|cooktop|lava louca|lava loucas|fogao eletrico|cervejeira|adega|depurador|coifa|aquecedor) /;
const CAPACITY = / (iphone|celular|smartphone|galaxy|redmi|xiaomi|motorola|moto g|moto e|poco|realme|ssd|pendrive|pen drive|cartao de memoria|micro sd|microsd|hd externo|ipad|tablet) /;
/** quem pediu a capinha do celular não precisa dizer a memória */
const ACCESSORY = / (capa|capinha|case|pelicula|suporte|cabo|carregador|fonte|adaptador|fone|smartwatch|relogio|bateria|tela|display) /;

/** "tanto faz": a pessoa respondeu que qualquer variação serve */
export const anyVariant = (v?: string | null) => Boolean(v && / (tanto faz|qualquer|indiferente|nao importa|nao sei|sem preferencia) /.test(norm(v)));

/**
 * O que a pessoa quer, lido do texto. `loose` (texto que é só a variação, ou a etiqueta de uma opção da loja):
 * número solto 33–48 é tamanho de calçado e P/M/G é tamanho de roupa. No nome do produto isso seria chute.
 */
export function parseWanted(text: string | null | undefined, loose = false): Wanted {
  if (!text) return {};
  const t = norm(text);
  const w: Wanted = {};
  const volts = t.match(/ (bivolt|110v?|127v?|220v?) /);
  if (volts) w.voltage = volts[1] === "bivolt" ? "bivolt" : volts[1]!.startsWith("220") ? "220" : "127";
  const cap = t.match(/ (\d{1,4}(?:gb|tb)) /);
  if (cap) w.capacity = cap[1]!;
  const size = t.match(/ (?:tamanho|tam|numero|num|n) (\d{2}|pp|p|m|g|gg|xg|xgg|exg|eg) /) ?? (loose ? t.match(/ (3[3-9]|4[0-8]|pp|p|m|g|gg|xg|xgg|exg|eg) /) : null);
  if (size) w.size = size[1]!;
  for (const [re, name] of COLORS) {
    if (re.test(t)) {
      w.color = name;
      break;
    }
  }
  return w;
}

/** A variação que já vem no pedido: "iphone 15 128gb", "air fryer 220v", "tênis nike 42" (número solto só em calçado). */
export function parseQuery(query: string): Wanted {
  const w = parseWanted(query);
  const t = norm(query);
  const shoe = SHOE.test(t) ? t.match(/ (3[3-9]|4[0-8]) /) : null;
  if (!w.size && shoe) w.size = shoe[1]!;
  return w;
}

/**
 * O que perguntar antes de buscar: tamanho e cor para calçado e roupa, voltagem para eletro, memória para celular e armazenamento.
 * Se a pessoa já respondeu (`variant`), ou disse que tanto faz, nada a perguntar.
 */
export function variantQuestions(query: string, variant?: string | null): string[] {
  if (variant?.trim()) return [];
  const t = norm(query);
  const w = parseQuery(query);
  const out: string[] = [];
  const wear = SHOE.test(t) || CLOTHES.test(t);
  if (SHOE.test(t) && !w.size) out.push("qual o número do calçado");
  else if (CLOTHES.test(t) && !w.size && !/ (pp|p|m|g|gg|xg|xgg) /.test(t)) out.push("qual o tamanho (P, M, G...)");
  // roupa e calçado: a cor também (o dono pediu); eletrônico pega qualquer cor se a pessoa não disser
  if (wear && !w.color) out.push("qual a cor");
  if (VOLTAGE.test(t) && !w.voltage) out.push("qual a voltagem (110 ou 220)");
  if (CAPACITY.test(t) && !ACCESSORY.test(t) && !w.capacity) out.push("quanta memória (ex.: 128 GB)");
  return out;
}

const LABEL: Record<Dim, (v: string) => string> = {
  size: (v) => `tamanho ${v.toUpperCase()}`,
  color: (v) => v,
  voltage: (v) => (v === "bivolt" ? "bivolt" : `${v}V`),
  capacity: (v) => v.replace(/(gb|tb)$/, (u) => ` ${u.toUpperCase()}`),
};
const ORDER: Dim[] = ["size", "color", "voltage", "capacity"];

/** "tamanho 42, preto" */
export function describe(w: Wanted, dims: Dim[] = ORDER) {
  return dims
    .filter((d) => w[d])
    .map((d) => LABEL[d](w[d]!))
    .join(", ");
}

/** o texto do anúncio já diz essa variação */
export function mentions(dim: Dim, value: string, text: string) {
  const got = parseWanted(text)[dim];
  if (dim === "voltage") return Boolean(got && (got === value || got === "bivolt"));
  if (dim === "size") return got === value;
  if (dim === "color") return got === value;
  return allCapacities(text).includes(value);
}

const allCapacities = (text: string) => [...norm(text).matchAll(/ (?=(\d{1,4}(?:gb|tb)) )/g)].map((m) => m[1]!);
const allVolts = (text: string): string[] =>
  [...norm(text).matchAll(/ (?=(bivolt|110v|127v|220v) )/g)].map((m) => (m[1] === "bivolt" ? "bivolt" : m[1]!.startsWith("220") ? "220" : "127"));

/**
 * O título diz com todas as letras outra variação: "Air Fryer 110V" para quem quer 220, "256GB" para quem quer 128.
 * Cor e tamanho não contam (o título costuma listar várias, ou nenhuma).
 */
export function conflicts(w: Wanted, title: string) {
  if (w.voltage && w.voltage !== "bivolt") {
    const v = allVolts(title);
    if (v.length && !v.includes("bivolt") && !v.includes(w.voltage)) return true;
  }
  if (w.capacity) {
    const c = allCapacities(title);
    if (c.length && !c.includes(w.capacity)) return true;
  }
  return false;
}

/** Qual dimensão um seletor da loja escolhe ("Cor", "Tamanho", "Voltagem", "Memória interna"), pelo nome ou pelas opções. */
export function pickerDim(name: string, labels: string[]): Dim | null {
  const n = norm(name);
  if (/ (cor|color|cores) /.test(n)) return "color";
  if (/ (tamanho|size|numero|numeracao) /.test(n)) return "size";
  if (/ (voltagem|voltage|tensao) /.test(n)) return "voltage";
  if (/ (memoria|capacidade|armazenamento|capacity|storage) /.test(n)) return "capacity";
  const parsed = labels.slice(0, 6).map((l) => parseWanted(l, true));
  for (const d of ["voltage", "capacity", "color", "size"] as Dim[]) if (parsed.length && parsed.every((p) => p[d])) return d;
  return null;
}

/** a opção do seletor serve para o que a pessoa quer (bivolt serve para 127 e 220) */
export function optionFits(dim: Dim, value: string, label: string) {
  const got = parseWanted(label, true)[dim];
  if (!got) return dim === "capacity" ? allCapacities(label).includes(value) : false;
  return got === value || (dim === "voltage" && got === "bivolt");
}
