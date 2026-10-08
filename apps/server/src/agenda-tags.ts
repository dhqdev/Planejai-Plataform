import { many, one } from "./db/pool.js";

/**
 * Tags da agenda: cada compromisso tem um assunto (Saúde, Trabalho, Pet...) e uma cor.
 * O assunto sai do nome que o assistente mandou ou, sem ele, do próprio texto (sem IA).
 * Tag parecida com uma que a pessoa já tem (mesmo nome sem acento/plural ou mesmo assunto) é reaproveitada.
 */
type Subject = { name: string; color: string; re: RegExp };

// ordem importa: "clínica veterinária" é Pet, não Saúde
export const SUBJECTS: Subject[] = [
  { name: "Pet", color: "#e8710a", re: /\b(veterinari\w*|vet|pet(?!ro|ic|i)\w*|cachorr\w*|cao|caes|gat[oa]s?|tosa|racao)\b/ },
  { name: "Saúde", color: "#e03150", re: /\b(saude|medic[oa]s?|consultas?|dentista|exames?|clinica|hospital|terapia|psicolog\w*|fisio\w*|remedios?|vacinas?|laboratorio|nutri\w*|dermato\w*|cardio\w*|ortopedista|oftalmo\w*|ginecolog\w*|pediatra)\b/ },
  { name: "Trabalho", color: "#2a6fdb", re: /\b(trabalho|reuniao|reunioes|clientes?|call|entrega|projetos?|escritorio|apresentacao|expediente|chefe|equipe)\b/ },
  { name: "Finanças", color: "#0c8040", re: /\b(financas|pagar|pagamento|boletos?|faturas?|banco|imposto|ir|ipva|iptu|cartao|emprestimo)\b/ },
  { name: "Estudos", color: "#7c3aed", re: /\b(estudos?|aulas?|provas?|curso|faculdade|escola|vestibular|enem|tcc|matricula)\b/ },
  { name: "Família", color: "#d63384", re: /\b(familia|aniversario|mae|pai|filh[oa]s?|esposa|marido|avo|avos|sogr[oa]|irma[o]?)\b/ },
  { name: "Casa", color: "#0f8b8d", re: /\b(casa|mercado|supermercado|compras|faxina|diarista|conserto|encanador|eletricista|aluguel|condominio|mudanca)\b/ },
  { name: "Esporte", color: "#4f46e5", re: /\b(esportes?|academia|treino|corrida|futebol|pilates|yoga|natacao|crossfit|musculacao)\b/ },
  { name: "Viagem", color: "#0369a1", re: /\b(viagem|voo|aeroporto|hotel|passagem|rodoviaria|hospedagem)\b/ },
  { name: "Lazer", color: "#b45309", re: /\b(lazer|cinema|show|jantar|festa|bar|restaurante|passeio|churrasco|teatro)\b/ },
];
/** Cores para tag que não é de nenhum assunto conhecido (texto branco legível em todas). */
export const EXTRA_COLORS = ["#5b45e8", "#16a3a3", "#c2410c", "#9333ea", "#475569", "#be185d", "#15803d", "#a16207"];
export const MAX_TAGS = 30;

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
/** chave de comparação: sem acento, sem caixa e sem plural simples */
export const tagKey = (s: string) => norm(s).replace(/s$/, "");
export const subjectOf = (text: string) => {
  const t = norm(text);
  return t ? SUBJECTS.find((s) => tagKey(s.name) === tagKey(t) || s.re.test(t)) ?? null : null;
};
export const isColor = (c: unknown): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c);
const cleanName = (s: string) => {
  const t = s.replace(/[#\n\r\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24);
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
};

export async function listTags(userId: string) {
  return many<{ name: string; color: string }>("SELECT name, color FROM agenda_tags WHERE user_id = $1 ORDER BY lower(name)", [userId]);
}

/**
 * Acha ou cria a tag do compromisso. `name` é o que o assistente sugeriu; sem nome, tenta o assunto pelo `text`.
 * Nome que cai num assunto conhecido vira o assunto ("Veterinário" -> Pet), para não espalhar tags parecidas;
 * `exact` (tela) guarda o nome como a pessoa escreveu. Devolve null quando não dá para saber o assunto.
 */
export async function resolveTag(userId: string, name: string | null | undefined, text = "", opts: { color?: string | null; exact?: boolean } = {}) {
  const wanted = cleanName(name ?? "");
  const subject = opts.exact ? null : subjectOf(wanted || text);
  if (!wanted && !subject) return null;
  const tags = await listTags(userId);
  const same =
    (wanted && tags.find((t) => tagKey(t.name) === tagKey(wanted))) ||
    (subject && tags.find((t) => subjectOf(t.name)?.name === subject.name)) ||
    null;
  if (same) return { ...same, created: false };
  if (tags.length >= MAX_TAGS) return null;
  const used = new Set(tags.map((t) => t.color.toLowerCase()));
  const color = isColor(opts.color)
    ? opts.color
    : subject?.color ?? EXTRA_COLORS.find((c) => !used.has(c)) ?? EXTRA_COLORS[tags.length % EXTRA_COLORS.length]!;
  const row = await one<{ name: string; color: string }>(
    `INSERT INTO agenda_tags (user_id, name, color) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, lower(name)) DO UPDATE SET name = agenda_tags.name RETURNING name, color`,
    [userId, subject?.name ?? wanted, color],
  );
  return { ...row!, created: true };
}
