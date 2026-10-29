-- Update 4: Standard-Positionen (Leistungskatalog)
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  details text,
  unit text,
  price numeric(12,2) not null default 0,
  discount numeric(5,2) not null default 0,
  vat numeric(5,2) not null default 19,
  created_at timestamptz not null default now()
);
create index if not exists products_user_idx on public.products (user_id, name);
alter table public.products enable row level security;
drop policy if exists own_products on public.products;
create policy own_products on public.products for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
