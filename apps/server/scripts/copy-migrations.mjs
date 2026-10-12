import { cpSync } from "node:fs";
cpSync("src/db/migrations", "dist/db/migrations", { recursive: true });
// figurinhas do Bolinho (agent/stickers.ts lê de dist/assets/stickers)
cpSync("src/assets", "dist/assets", { recursive: true });
