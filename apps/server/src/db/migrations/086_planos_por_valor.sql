-- Planos só por valor (pedido do David em 23/out/2026): todo plano libera tudo e muda só no preço e nos grãos,
-- com o grão mais barato quanto maior o plano. Tira o "o que libera" (level) dos planos salvos e troca o que ainda
-- estava no padrão de 20/out: Dia a dia 4.000 -> 5.500, Completo 10.000 -> 12.500; benefícios e frase do padrão
-- antigo saem para valerem os novos do código (perksOf cai no plano padrão de mesmo id).
UPDATE settings
   SET value = (
         SELECT jsonb_agg(
                  CASE
                    WHEN p->>'id' = 'leve' THEN
                      (p - 'level')
                      - (CASE WHEN p->'perks' = '["Gastos, cartões e contas fixas pelo WhatsApp", "Lembretes e Google Agenda", "Áudio, foto e comprovante viram anotação", "Agenda e finanças no painel"]'::jsonb THEN 'perks' ELSE '' END)
                      || (CASE WHEN p->>'blurb' = 'Seus gastos e sua agenda pelo WhatsApp.' THEN '{"blurb": "Para quem fala com ele algumas vezes por dia."}'::jsonb ELSE '{}'::jsonb END)
                    WHEN p->>'id' = 'dia-a-dia' THEN
                      (CASE WHEN (p->>'grains') = '4000' AND (p->>'price') = '39.9' THEN p || '{"grains": 5500}'::jsonb ELSE p END)
                      - 'level'
                      - (CASE WHEN p->'perks' = '["Tudo do Leve, com o time inteiro", "Pesquisa na internet, resumos, imagens e PDFs", "Mensagens e recados para outras pessoas", "Até 2 especialistas da loja"]'::jsonb THEN 'perks' ELSE '' END)
                      || (CASE WHEN p->>'blurb' = 'O time inteiro trabalhando no seu dia.' THEN '{"blurb": "Para quem usa todo dia, o dia inteiro."}'::jsonb ELSE '{}'::jsonb END)
                    WHEN p->>'id' = 'completo' THEN
                      (CASE WHEN (p->>'grains') = '10000' AND (p->>'price') = '79.9' THEN p || '{"grains": 12500}'::jsonb ELSE p END)
                      - 'level'
                      - (CASE WHEN p->'perks' = '["2,5 vezes os grãos do Dia a dia", "Até 6 especialistas, Secretária de reuniões inclusa", "Agentes criados sob medida para você", "Notion, GitHub e n8n conectados", "Voz caprichada nos áudios"]'::jsonb THEN 'perks' ELSE '' END)
                      || (CASE WHEN p->>'blurb' = 'Tudo liberado, com agentes feitos para você.' THEN '{"blurb": "Para quem usa muito: imagens, áudios e reuniões."}'::jsonb ELSE '{}'::jsonb END)
                    ELSE p - 'level'
                  END
                  ORDER BY ord)
           FROM jsonb_array_elements(value) WITH ORDINALITY AS t(p, ord)
       ),
       updated_at = now()
 WHERE key = 'billingPlans' AND jsonb_typeof(value) = 'array' AND jsonb_array_length(value) > 0;

-- Pacotes avulsos com desconto maior quanto maior o pacote (só os que ainda estavam no preço padrão)
UPDATE settings
   SET value = (
         SELECT jsonb_agg(
                  CASE
                    WHEN k->>'id' = 'p2000' AND (k->>'grains') = '2000' AND (k->>'price') = '34.9' THEN k || '{"price": 29.9}'::jsonb
                    WHEN k->>'id' = 'p5000' AND (k->>'grains') = '5000' AND (k->>'price') = '79.9' THEN k || '{"price": 59.9}'::jsonb
                    ELSE k
                  END
                  ORDER BY ord)
           FROM jsonb_array_elements(value) WITH ORDINALITY AS t(k, ord)
       ),
       updated_at = now()
 WHERE key = 'billingPacks' AND jsonb_typeof(value) = 'array' AND jsonb_array_length(value) > 0;
