-- Link de convite pessoal: um código por pessoa que serve para quantos cadastros quiserem e não vence.
-- Quem entra por ele fica com users.invited_by de quem convidou; o convite continua 'pending' (nunca vira 'accepted').
ALTER TABLE invites ADD COLUMN multi boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX invites_personal_user_idx ON invites (inviter_user_id) WHERE multi AND status = 'pending' AND inviter_user_id IS NOT NULL;
CREATE UNIQUE INDEX invites_personal_account_idx ON invites (inviter_account_id) WHERE multi AND status = 'pending' AND inviter_user_id IS NULL;
