-- Update 3: Kennzeichen für übernommene Rechnungen (z. B. aus Lexoffice)
alter table public.invoices add column if not exists imported boolean not null default false;
