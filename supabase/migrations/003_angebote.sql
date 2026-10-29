-- Update 2: Angebote
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  number text,
  status text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'declined')),
  customer_id uuid references public.customers(id) on delete set null,
  customer jsonb,
  issue_date date,
  valid_until date,
  service_text text,
  items jsonb not null default '[]'::jsonb,
  net numeric(12,2) not null default 0,
  vat numeric(12,2) not null default 0,
  gross numeric(12,2) not null default 0,
  intro text,
  notes text,
  invoice_id uuid references public.invoices(id) on delete set null,
  sent_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, number)
);
create index if not exists quotes_user_idx on public.quotes (user_id, created_at desc);

alter table public.quotes enable row level security;
drop policy if exists own_quotes on public.quotes;
create policy own_quotes on public.quotes for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

alter table public.mail_log add column if not exists quote_id uuid references public.quotes(id) on delete set null;
