-- Website-Update-Angebote für Bestandskunden: eigene Kategorie und Anschreiben (Seite 1)
alter table public.quotes add column if not exists category text not null default 'standard';
alter table public.quotes add column if not exists letter jsonb;
-- Website des Kunden (für Platzhalter im Anschreiben)
alter table public.customers add column if not exists website text;
