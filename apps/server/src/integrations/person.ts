import { AsyncLocalStorage } from "node:async_hooks";

/**
 * De quem é a conversa que está rodando agora. As integrações pessoais (Google, Notion...) leem daqui
 * de quem são as credenciais: o dono usa as da plataforma, cada cliente só as que ele mesmo conectou.
 * Fora de uma conversa (painel do dono, jobs do sistema) não há pessoa e vale a plataforma.
 */
export interface Person {
  userId: string;
  owner: boolean;
}

const store = new AsyncLocalStorage<Person>();

export function asPerson<T>(person: Person, fn: () => T): T {
  return store.run(person, fn);
}

export function currentPerson(): Person | null {
  return store.getStore() ?? null;
}
