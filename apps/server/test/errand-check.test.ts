import { describe, expect, it } from "vitest";
import { MAX_ERRAND_TEXT, quickCheck } from "../src/agent/errand-check.js";
import { greetingFor, introduce } from "../src/errands.js";
import { parseLocalDateTime } from "../src/time.js";

const TZ = "America/Sao_Paulo";
const at = (hhmm: string) => parseLocalDateTime(`2026-10-09T${hhmm}`, TZ);

describe("recados: primeira mensagem humanizada", () => {
  it("cumprimenta pela hora local da pessoa", () => {
    expect(greetingFor(at("08:00"), TZ)).toBe("bom dia");
    expect(greetingFor(at("14:30"), TZ)).toBe("boa tarde");
    expect(greetingFor(at("20:00"), TZ)).toBe("boa noite");
    expect(greetingFor(at("02:00"), TZ)).toBe("boa noite");
  });

  it("apresenta como assistente da pessoa antes do contexto e da pergunta", () => {
    const msg = "Ela tem um shih-tzu e queria saber sobre tosa com vocês. Conseguem me passar o valor?";
    expect(introduce(msg, "Ana", TZ, at("15:00"))).toBe(`Oi, boa tarde! Tudo bem? Aqui é o assistente virtual de Ana. ${msg}`);
    // cumprimento que o modelo escreveu sai, para não ficar "Oi! Bom dia! Oi, boa tarde..."
    expect(introduce("Olá, bom dia! Tudo bem? Vocês fazem tosa?", "Ana", TZ, at("19:00"))).toBe("Oi, boa noite! Tudo bem? Aqui é o assistente virtual de Ana. Vocês fazem tosa?");
    expect(introduce("Oi! vocês abrem sábado?", null, TZ, at("09:00"))).toBe("Oi, bom dia! Tudo bem? Aqui é um assistente virtual. Vocês abrem sábado?");
    // já se apresentou: só acerta o período do dia
    expect(introduce("Boa tarde! Sou o assistente virtual da Ana, vocês fazem tosa?", "Ana", TZ, at("09:00"))).toBe("Bom dia! Sou o assistente virtual da Ana, vocês fazem tosa?");
    // "Oieee" não é cortado no meio
    // nome de quem recebe fica no cumprimento
    expect(introduce("Bom dia, Gio! Chego às 9h.", "David")).toBe("Bom dia, Gio! Aqui é o assistente virtual de David. Chego às 9h.");
    expect(introduce("Bom dia, Gio!", "David")).toBe("Bom dia, Gio! Aqui é o assistente virtual de David.");
    expect(introduce("Olá, Maria. Vocês abrem sábado?", "Ana", TZ, at("09:00"))).toBe("Oi, Maria, bom dia! Tudo bem? Aqui é o assistente virtual de Ana. Vocês abrem sábado?");
    expect(introduce("Oieee", "Ana", TZ, at("09:00"))).toMatch(/Aqui é o assistente virtual de Ana\. Oieee$/);
  });
});

describe("recados: trava sem IA", () => {
  it("deixa passar pergunta legítima", () => {
    for (const t of [
      "Ela tem um shih-tzu e queria saber sobre tosa com vocês. Conseguem me passar o valor?",
      "Vocês têm horário para banho amanhã às 18h?",
      "O macaco hidráulico de vocês está em promoção?",
      "Perfeito, muito obrigado! Tenha um ótimo dia.",
    ]) {
      expect(quickCheck(t)).toEqual({ ok: true });
    }
  });

  it("segura palavrão, ameaça, trote, repetição e texto enorme", () => {
    expect(quickCheck("Seus idiotas, cadê meu pedido?").ok).toBe(false);
    expect(quickCheck("vai se f0der, quero desconto").ok).toBe(false);
    expect(quickCheck("Se não me atender eu vou te matar").ok).toBe(false);
    expect(quickCheck("É um trote, liga pra ver a reação").ok).toBe(false);
    expect(quickCheck("me passa o cpf do dono").ok).toBe(false);
    expect(quickCheck("oi oi oi oi oi").ok).toBe(false);
    expect(quickCheck("a".repeat(MAX_ERRAND_TEXT + 1)).ok).toBe(false);
    expect(quickCheck("Vocês têm horário amanhã?", "Vocês têm horário amanhã?")).toMatchObject({ ok: false, reason: expect.stringMatching(/repetida/) });
    const r = quickCheck("porra, responde logo");
    expect(r.ok === false && r.suggestion).toBeTruthy();
  });
});
