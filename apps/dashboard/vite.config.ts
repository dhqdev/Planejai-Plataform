import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Cada build ganha um id. O app compara com /version.json e mostra "Atualizar" quando sai versão nova. */
// a versão do push vem do CI (APP_VERSION); sem ela, a do package.json
const APP_VERSION: string = process.env.APP_VERSION || JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const BUILD = `${Date.now().toString(36)}${process.env.GITHUB_SHA ? `-${process.env.GITHUB_SHA.slice(0, 7)}` : ""}`;

function buildVersion(): Plugin {
  return {
    name: "planejai-build-version",
    apply: "build",
    writeBundle(opts) {
      const out = opts.dir!;
      fs.writeFileSync(path.join(out, "version.json"), JSON.stringify({ build: BUILD, version: APP_VERSION }));
      // o service worker muda a cada build, então o navegador instala o novo e limpa o cache antigo
      const sw = path.join(out, "sw.js");
      if (fs.existsSync(sw)) fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(/const VERSION = "[^"]*";/, `const VERSION = "planejai-${BUILD}";`));
    },
  };
}

/**
 * Comprime o build uma vez (brotli no máximo e gzip): o servidor entrega o .br/.gz pronto (preCompressed), sem gastar CPU
 * por pedido. Corre depois do buildVersion porque ele reescreve o sw.js.
 */
function precompress(): Plugin {
  const TEXT = /\.(js|css|html|svg|json|webmanifest|txt|xml)$/;
  let outDir = "";
  return {
    name: "planejai-precompress",
    apply: "build",
    enforce: "post",
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
      for (const file of walk(outDir)) {
        if (!TEXT.test(file)) continue;
        const raw = fs.readFileSync(file);
        if (raw.length < 1024) continue;
        fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }));
        fs.writeFileSync(`${file}.gz`, zlib.gzipSync(raw, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), buildVersion(), precompress()],
  define: { __BUILD__: JSON.stringify(BUILD), __APP_VERSION__: JSON.stringify(APP_VERSION) },
  build: { outDir: "../server/public", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000", "/webhooks": "http://localhost:3000" },
  },
});
