-- Mesmo celular gravado duas vezes: com o nono dígito (cadastro no painel) e sem ele (número que o WhatsApp entrega).
-- A mensagem que chegava pelo WhatsApp criava um segundo usuário "aguardando aprovação", e a pessoa recém-cadastrada
-- recebia o aviso de "só quem assina". Junta os dois: a conversa vai para o cadastro de verdade e o duplicado sai.
CREATE TEMP TABLE celular_duplicado ON COMMIT DROP AS
WITH r AS (
  SELECT u.id, u.status,
    EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id) AS tem_conta,
    regexp_replace(u.phone, '^55(\d{2})9?(\d{8})$', '55\1\2') AS chave,
    row_number() OVER (
      PARTITION BY regexp_replace(u.phone, '^55(\d{2})9?(\d{8})$', '55\1\2')
      ORDER BY (u.status = 'blocked') DESC, EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id) DESC,
        (u.status = 'active') DESC, u.created_at, u.id
    ) AS pos
  FROM users u
  WHERE u.phone ~ '^55\d{2}9?\d{8}$'
)
SELECT d.id AS dup, k.id AS keep
FROM r d JOIN r k ON k.chave = d.chave AND k.pos = 1
WHERE d.pos > 1 AND d.status = 'pending' AND NOT d.tem_conta;

UPDATE conversations c SET user_id = x.keep FROM celular_duplicado x WHERE c.user_id = x.dup;
UPDATE users k SET last_seen_at = GREATEST(k.last_seen_at, d.last_seen_at)
  FROM celular_duplicado x JOIN users d ON d.id = x.dup WHERE k.id = x.keep;
DELETE FROM users WHERE id IN (SELECT dup FROM celular_duplicado);
