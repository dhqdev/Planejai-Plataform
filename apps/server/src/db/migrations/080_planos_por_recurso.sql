-- Planos por recurso (escolha do David em 20/out/2026): o Leve fica só com gastos e agenda, com o Juvenal sozinho,
-- e passa de 1.500 para 2.500 grãos. Só troca o que ainda estava no padrão antigo; benefícios e frase do padrão
-- antigo saem do plano salvo para valerem os novos do código (perksOf/levelOf caem no plano padrão de mesmo id).
UPDATE settings
   SET value = (
         SELECT jsonb_agg(
                  CASE
                    WHEN p->>'id' = 'leve' THEN
                      (CASE WHEN (p->>'grains') = '1500' THEN p || '{"grains": 2500}'::jsonb ELSE p END)
                      - (CASE WHEN p->'perks' = '["Gastos, contas e lembretes pelo WhatsApp", "Áudio, foto e comprovante viram anotação", "Agenda e finanças no painel"]'::jsonb THEN 'perks' ELSE '' END)
                      || (CASE WHEN p->>'blurb' = 'Gastos, lembretes e perguntas do dia a dia.' THEN '{"blurb": "Seus gastos e sua agenda pelo WhatsApp."}'::jsonb ELSE '{}'::jsonb END)
                    WHEN p->>'id' = 'dia-a-dia' THEN
                      p
                      - (CASE WHEN p->'perks' = '["Mais que o dobro de grãos do Leve", "Pesquisa na internet, resumos e PDFs", "Google Agenda, e-mail e Notion conectados"]'::jsonb THEN 'perks' ELSE '' END)
                      || (CASE WHEN p->>'blurb' = 'Para quem usa todo dia: agenda, pesquisa e áudio.' THEN '{"blurb": "O time inteiro trabalhando no seu dia."}'::jsonb ELSE '{}'::jsonb END)
                    WHEN p->>'id' = 'completo' THEN
                      p
                      - (CASE WHEN p->'perks' = '["2,5 vezes os grãos do Dia a dia", "Recados: ele fala com lojas e marca horários por você", "Relatórios e o time inteiro no seu dia"]'::jsonb THEN 'perks' ELSE '' END)
                      || (CASE WHEN p->>'blurb' = 'Time inteiro trabalhando: recados, automações e muito mais.' THEN '{"blurb": "Tudo liberado, com agentes feitos para você."}'::jsonb ELSE '{}'::jsonb END)
                    ELSE p
                  END
                  ORDER BY ord)
           FROM jsonb_array_elements(value) WITH ORDINALITY AS t(p, ord)
       ),
       updated_at = now()
 WHERE key = 'billingPlans' AND jsonb_typeof(value) = 'array' AND jsonb_array_length(value) > 0;
