-- Contatos importados do .vcf antes do conserto do leitor: quem não tinha FN ficou com o campo N cru
-- ("Souza;Ana Paula;;;"). Remonta como "Ana Paula Souza". Os que vieram só ";;;;" não têm o que recuperar
-- aqui: importar o mesmo arquivo de novo atualiza o nome pelo número, sem duplicar.
UPDATE phonebook SET name = n, name_key = translate(lower(n), 'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')
FROM (
  SELECT id AS pid, btrim(regexp_replace(concat_ws(' ',
    nullif(btrim(split_part(name, ';', 4)), ''),
    nullif(btrim(split_part(name, ';', 2)), ''),
    nullif(btrim(split_part(name, ';', 3)), ''),
    nullif(btrim(split_part(name, ';', 1)), ''),
    nullif(btrim(split_part(name, ';', 5)), '')), '\s+', ' ', 'g')) AS n
  FROM phonebook
  WHERE name ~ '^[^;]*;[^;]*;[^;]*;[^;]*;[^;]*$' AND name ~ '[[:alnum:]]'
) AS fix
WHERE phonebook.id = fix.pid AND fix.n <> '';
