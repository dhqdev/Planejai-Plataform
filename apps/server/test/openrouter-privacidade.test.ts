import { afterEach, describe, expect, it, vi } from "vitest";

describe("privacidade e modelos grátis no OpenRouter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: "oi" } }], usage: { cost: 0 } }), { status: 200 });
  const noPolicy = () => new Response('{"error":{"message":"No endpoints found matching your data policy"}}', { status: 404 });

  async function load(responses: (() => Response)[]) {
    process.env.OPENROUTER_API_KEY = "sk-teste";
    vi.resetModules();
    const bodies: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return (responses.shift() ?? ok)();
      }),
    );
    const mod = await import("../src/llm/openrouter.js");
    return { ...mod, bodies };
  }
  const req = { messages: [{ role: "user" as const, content: "gastei 30 no mercado" }] };

  it("rota de cliente pede provedor sem coleta de dados", async () => {
    const { chatCompletion, bodies } = await load([]);
    await chatCompletion({ model: "deepseek/deepseek-v4.1-flash" }, req);
    expect(bodies[0].provider).toEqual({ data_collection: "deny" });
  });

  it("rota pública (blog) não leva a trava", async () => {
    const { chatCompletion, bodies } = await load([]);
    await chatCompletion({ model: "openrouter/free", fallbacks: ["deepseek/deepseek-v4.1-flash"], publicData: true }, req);
    expect(bodies[0].provider).toBeUndefined();
    expect(bodies[0].models).toEqual(["openrouter/free", "deepseek/deepseek-v4.1-flash"]);
  });

  it("modelo grátis numa rota de cliente sai da lista e a trava fica", async () => {
    const { chatCompletion, bodies } = await load([noPolicy]);
    await chatCompletion({ model: "google/gemma-4-31b-it:free", fallbacks: ["deepseek/deepseek-v4.1-flash"] }, req);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].model).toBe("deepseek/deepseek-v4.1-flash");
    expect(bodies[1].provider).toEqual({ data_collection: "deny" });
  });

  it("modelo pago sem provedor privado responde sem a trava e não repete a tentativa recusada", async () => {
    const { chatCompletion, bodies } = await load([noPolicy]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await chatCompletion({ model: "xiaomi/mimo-v2.6-flash" }, req);
    await chatCompletion({ model: "xiaomi/mimo-v2.6-flash" }, req);
    expect(bodies).toHaveLength(3);
    expect(bodies[1].provider).toBeUndefined();
    expect(bodies[2].provider).toBeUndefined();
  });

  it("withoutFree tira os grátis e mantém o pago de reserva", async () => {
    const { withoutFree, isFreeModel } = await load([]);
    expect(isFreeModel("openrouter/free")).toBe(true);
    expect(isFreeModel("deepseek/deepseek-v4.1-flash")).toBe(false);
    expect(withoutFree({ model: "openrouter/free", fallbacks: ["deepseek/deepseek-v4.1-flash", "google/gemini-3.8-flash"], publicData: true })).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      fallbacks: ["google/gemini-3.8-flash"],
    });
  });
});
