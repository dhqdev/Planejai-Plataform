-- Compras: a variação que a pessoa quer (tamanho, cor, voltagem, capacidade) fica no item da lista
-- e no aviso de preço, para o link e o preço vigiado serem os da variação certa.
ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS variant TEXT;
ALTER TABLE watches ADD COLUMN IF NOT EXISTS variant TEXT;
