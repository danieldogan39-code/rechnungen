-- Update 5: Abrechnungsart (einmalig/Abo) für Standard-Positionen, Herkunft von Abos aus Angeboten
alter table public.products add column if not exists billing text not null default 'once';
alter table public.products drop constraint if exists products_billing_check;
alter table public.products add constraint products_billing_check check (billing in ('once', 'monthly', 'quarterly', 'yearly'));
alter table public.recurring add column if not exists quote_id uuid references public.quotes(id) on delete set null;
