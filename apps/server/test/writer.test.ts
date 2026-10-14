import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: any[] = [];
let replies: { content: string | null; finishReason?: string }[] = [];
vi.mock("../src/llm/openrouter.js", () => ({
  chatCompletion: vi.fn(async (choice: any, req: any) => {
    calls.push({ model: choice.model, maxTokens: req.maxTokens, reasoning: req.reasoning });
    const r = replies.shift() ?? { content: "" };
    return { message: { content: r.content }, model: choice.model, tokensIn: 10, tokensOut: 100, costUsd: 0.001, finishReason: r.finishReason ?? "stop" };
  }),
}));
vi.mock("../src/llm/router.js", () => ({
  resolveModel: vi.fn(async () => ({ model: "principal", fallbacks: ["reserva"], maxTokens: 8000 })),
}));

const step = { ok: vi.fn(async () => {}), fail: vi.fn(async () => {}) };
const ctx: any = { tracer: { step: vi.fn(async () => step) } };

describe("writeLong (redator)", () => {
  beforeEach(() => {
    calls.length = 0;
    step.ok.mockClear();
  });
  it("sem raciocínio, e texto vazio tenta de novo no modelo reserva com o dobro de teto", async () => {
    const { writeLong } = await import("../src/agent/writer.js");
    replies = [{ content: "", finishReason: "length" }, { content: "## Dia 1\nMagic Kingdom" }];
    expect(await writeLong(ctx, { name: "texto do PDF", system: "s", ask: "guia de Orlando", maxTokens: 8000 })).toBe("## Dia 1\nMagic Kingdom");
    expect(calls).toEqual([
      { model: "principal", maxTokens: 8000, reasoning: "off" },
      { model: "reserva", maxTokens: 16000, reasoning: "off" },
    ]);
    expect((step.ok.mock.calls[0] as unknown[])[0]).toMatchObject({ nova_tentativa: true });
  });
  it("cortado logo no começo também tenta de novo; texto bom sai na primeira", async () => {
    const { writeLong } = await import("../src/agent/writer.js");
    replies = [{ content: "SUBTÍTULO: Guia\n## Intro", finishReason: "length" }, { content: "texto inteiro" }];
    expect(await writeLong(ctx, { name: "x", system: "s", ask: "a" })).toBe("texto inteiro");
    calls.length = 0;
    replies = [{ content: "x".repeat(500) }];
    expect(await writeLong(ctx, { name: "x", system: "s", ask: "a" })).toHaveLength(500);
    expect(calls).toHaveLength(1);
  });
});
