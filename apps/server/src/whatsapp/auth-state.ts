import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from "baileys";
import { many, one, query } from "../db/pool.js";

/** Estado de autenticação do Baileys guardado no Postgres (tabela wa_auth). */
export async function usePgAuthState(session: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const read = async (key: string) => {
    const row = await one<{ value: string }>("SELECT value FROM wa_auth WHERE session = $1 AND key = $2", [session, key]);
    return row ? JSON.parse(row.value, BufferJSON.reviver) : null;
  };
  const write = (key: string, value: unknown) =>
    query(
      `INSERT INTO wa_auth (session, key, value, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (session, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [session, key, JSON.stringify(value, BufferJSON.replacer)],
    );
  const remove = (key: string) => query("DELETE FROM wa_auth WHERE session = $1 AND key = $2", [session, key]);

  const creds: AuthenticationCreds = (await read("creds")) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [id: string]: SignalDataTypeMap[typeof type] } = {};
          if (!ids.length) return data;
          const rows = await many<{ key: string; value: string }>("SELECT key, value FROM wa_auth WHERE session = $1 AND key = ANY($2)", [
            session,
            ids.map((id) => `${type}-${id}`),
          ]);
          const byKey = new Map(rows.map((r) => [r.key, r.value]));
          for (const id of ids) {
            const raw = byKey.get(`${type}-${id}`);
            if (!raw) continue;
            let value = JSON.parse(raw, BufferJSON.reviver);
            if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            for (const [id, value] of Object.entries(data[type] ?? {})) {
              if (value) await write(`${type}-${id}`, value);
              else await remove(`${type}-${id}`);
            }
          }
        },
      },
    },
    saveCreds: async () => {
      await write("creds", creds);
    },
  };
}

export async function clearAuthState(session: string) {
  await query("DELETE FROM wa_auth WHERE session = $1", [session]);
}
