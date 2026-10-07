import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Cada build ganha um id. O app compara com /version.json e mostra "Atualizar" quando sai versão nova. */
const BUILD = `${Date.now().toString(36)}${process.env.GITHUB_SHA ? `-${process.env.GITHUB_SHA.slice(0, 7)}` : ""}`;

function buildVersion(): Plugin {
  return {
    name: "planejai-build-version",
    apply: "build",
    writeBundle(opts) {
      const out = opts.dir!;
      fs.writeFileSync(path.join(out, "version.json"), JSON.stringify({ build: BUILD }));
      // o service worker muda a cada build, então o navegador instala o novo e limpa o cache antigo
      const sw = path.join(out, "sw.js");
      if (fs.existsSync(sw)) fs.writeFileSync(sw, fs.readFileSync(sw, "utf8").replace(/const VERSION = "[^"]*";/, `const VERSION = "planejai-${BUILD}";`));
    },
  };
}

export default defineConfig({
  plugins: [react(), buildVersion()],
  define: { __BUILD__: JSON.stringify(BUILD) },
  build: { outDir: "../server/public", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000", "/webhooks": "http://localhost:3000" },
  },
});
