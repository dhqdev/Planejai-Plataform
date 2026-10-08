-- Recado que quem convidou quer entregar assim que a pessoa aceitar (convida o Jonathan e chama ele pro cinema)
ALTER TABLE invites ADD COLUMN after_accept text;
