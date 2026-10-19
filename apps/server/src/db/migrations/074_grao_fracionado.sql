-- Grão fracionado: o uso desconta o custo exato de IA e a fração de grão que sobra fica guardada para o próximo passo,
-- em vez de arredondar cada passo para cima (um passo de US$ 0,0003 cobrava 1 grão inteiro).
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS grain_remainder double precision NOT NULL DEFAULT 0;

-- taxa nova combinada com o dono em 19/out/2026: 1.500 grãos por US$ 1 (só troca quem ainda estava no padrão antigo)
UPDATE settings SET value = '1500'::jsonb, updated_at = now() WHERE key = 'billingGrainsPerUsd' AND value = '1000'::jsonb;
