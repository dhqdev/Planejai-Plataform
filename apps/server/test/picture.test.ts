import { afterEach, describe, expect, it, vi } from "vitest";

/** Foto pedida no WhatsApp: busca de imagem ou modelo barato da rota "image", nunca navegador. */
process.env.OPENROUTER_API_KEY ||= "sk-test";
vi.mock("../src/llm/router.js", () => ({ resolveModel: async () => ({ model: "fake/image" }) }));
vi.mock("../src/integrations/registry.js", () => ({ getCredentials: async () => null }));

const png = Buffer.alloc(9_000, 1).toString("base64");

function fakeCtx() {
  const steps: any[] = [];
  const media: any[] = [];
  const ctx: any = {
    outbox: { addMedia: (m: any) => (media.push(m), `m${media.length}`) },
    tracer: { step: async (s: any) => (steps.push(s), { ok: async (_o: any, u: any) => (s.usage = u), fail: async () => {} }) },
  };
  return { ctx, steps, media };
}

afterEach(() => vi.unstubAllGlobals());

describe("make_picture", () => {
  it("gera pela rota image (modalities) e guarda o custo no Tracer", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ model: "fake/image", choices: [{ message: { content: "", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] } }], usage: { prompt_tokens: 20, completion_tokens: 1290, cost: 0.039 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const { getPicture } = await import("../src/agent/tools/images.js");
    const { ctx, steps, media } = fakeCtx();
    const r: any = await getPicture.run({ description: "um gato laranja de óculos", mode: "gerar" }, ctx);
    expect(r.media_id).toBe("m1");
    expect(r.note).toBeUndefined();
    expect(calls[0]).toMatchObject({ model: "fake/image", modalities: ["image", "text"] });
    expect(calls[0].reasoning).toBeUndefined();
    expect(media[0]).toMatchObject({ mimetype: "image/png", base64: png, fileName: "imagem.png" });
    expect(steps[0]).toMatchObject({ agent: "imagem", name: "gerar imagem", usage: { costUsd: 0.039 } });
  });

  it("buscar sem chave de busca: gera e avisa que não é foto real", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: null, images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }], usage: {} }), { status: 200 }),
    );
    const { getPicture } = await import("../src/agent/tools/images.js");
    const { ctx } = fakeCtx();
    const r: any = await getPicture.run({ description: "Torre Eiffel" }, ctx);
    expect(r.media_id).toBe("m1");
    expect(r.note).toContain("gerada");
  });
});
