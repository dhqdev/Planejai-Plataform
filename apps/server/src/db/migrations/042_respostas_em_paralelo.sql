-- Várias respostas ao mesmo tempo na mesma conversa: cada rodada reserva as mensagens que vai responder
-- (claimed_at) e a próxima pergunta, que chega enquanto a primeira ainda trabalha, vai para outra rodada.
-- Reserva mais velha que o prazo da execução é de um processo que morreu e volta a valer.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
