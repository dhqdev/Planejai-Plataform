import { cpSync } from "node:fs";
cpSync("src/db/migrations", "dist/db/migrations", { recursive: true });
// figurinhas do Mascote (agent/stickers.ts lê de dist/assets/stickers)
cpSync("src/assets", "dist/assets", { recursive: true });
