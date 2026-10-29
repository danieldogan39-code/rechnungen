-- Rechnungs-App: Datenbank-Schema
-- Einmal komplett im Supabase SQL Editor ausführen.

-- Firmendaten, Texte, Versand- und Erinnerungs-Einstellungen
create table if not exists public.settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  company jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  number text,
  contact text,
  email text,
  street text,
  zip text,
  city text,
  country text default 'Deutschland',
  vat_id text,
  created_at timestamptz not null default now()
);

-- Wiederkehrende Rechnungen (Abos)
create table if not exists public.recurring (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  title text,
  items jsonb not null default '[]'::jsonb,
  interval text not null default 'monthly' check (interval in ('monthly', 'quarterly', 'yearly')),
  next_date date not null,
  auto_send boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  number text,
  kind text not null default 'invoice' check (kind in ('invoice', 'storno')),
  status text not null default 'draft' check (status in ('draft', 'open', 'paid', 'cancelled')),
  customer_id uuid references public.customers(id) on delete set null,
  customer jsonb,                -- Kundendaten zum Zeitpunkt der Ausstellung
  issue_date date,
  service_text text,             -- Leistungsdatum oder -zeitraum
  due_date date,
  items jsonb not null default '[]'::jsonb,
  net numeric(12,2) not null default 0,
  vat numeric(12,2) not null default 0,
  gross numeric(12,2) not null default 0,
  intro text,
  notes text,
  ref_invoice_id uuid references public.invoices(id),  -- Storno/Korrektur: Bezug auf Original
  recurring_id uuid references public.recurring(id) on delete set null,
  sent_at timestamptz,
  paid_at timestamptz,
  reminders_sent int not null default 0,
  last_reminder_at date,
  created_at timestamptz not null default now(),
  unique (user_id, number)
);
create index if not exists invoices_user_idx on public.invoices (user_id, created_at desc);
create index if not exists invoices_open_idx on public.invoices (status, due_date) where kind = 'invoice';

create table if not exists public.mail_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  type text not null,
  recipient text,
  subject text,
  status text not null,
  error text,
  sent_at timestamptz not null default now()
);

-- Fortlaufende Rechnungsnummern je Jahr (lückenlos, auch bei gleichzeitigen Aufrufen)
create table if not exists public.counters (
  user_id uuid not null references auth.users(id) on delete cascade,
  year int not null,
  last int not null default 0,
  primary key (user_id, year)
);

create or replace function public.next_invoice_number(p_user uuid, p_year int, p_min int default 1)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.counters (user_id, year, last) values (p_user, p_year, greatest(p_min, 1))
  on conflict (user_id, year) do update set last = greatest(public.counters.last + 1, p_min)
  returning last into n;
  return n;
end $$;
revoke all on function public.next_invoice_number(uuid, int, int) from public, anon, authenticated;

-- Ausgestellte Rechnungen sind unveränderlich (GoBD). Erlaubt bleiben nur Status, Versand- und Zahlungsfelder.
create or replace function public.protect_issued_invoice()
returns trigger language plpgsql as $$
begin
  -- Abschließen und Stornieren nur über den Server (fortlaufende Nummer, Storno-Beleg)
  if current_user = 'authenticated' then
    if old.status = 'draft' and new.status <> 'draft' then
      raise exception 'Rechnungen werden über die App-Funktion „Abschließen“ ausgestellt.';
    end if;
    if new.status = 'cancelled' and old.status <> 'cancelled' then
      raise exception 'Stornieren bitte über die App-Funktion „Stornieren“.';
    end if;
    if old.status = 'cancelled' and new.status <> 'cancelled' then
      raise exception 'Stornierte Rechnungen können nicht wieder geöffnet werden.';
    end if;
  end if;
  if old.status <> 'draft' then
    if new.status = 'draft'
       or new.number is distinct from old.number
       or new.kind is distinct from old.kind
       or new.items is distinct from old.items
       or new.customer is distinct from old.customer
       or new.issue_date is distinct from old.issue_date
       or new.due_date is distinct from old.due_date
       or new.service_text is distinct from old.service_text
       or new.net is distinct from old.net
       or new.vat is distinct from old.vat
       or new.gross is distinct from old.gross
       or new.intro is distinct from old.intro
       or new.notes is distinct from old.notes
       or new.ref_invoice_id is distinct from old.ref_invoice_id then
      raise exception 'Ausgestellte Rechnungen können nicht geändert werden. Bitte die Korrektur-Funktion nutzen.';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists invoices_protect on public.invoices;
create trigger invoices_protect before update on public.invoices
  for each row execute function public.protect_issued_invoice();

-- Zugriffsschutz: jeder sieht nur seine eigenen Daten
alter table public.settings enable row level security;
alter table public.customers enable row level security;
alter table public.recurring enable row level security;
alter table public.invoices enable row level security;
alter table public.mail_log enable row level security;
alter table public.counters enable row level security;

drop policy if exists own_settings on public.settings;
create policy own_settings on public.settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists own_customers on public.customers;
create policy own_customers on public.customers for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists own_recurring on public.recurring;
create policy own_recurring on public.recurring for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists inv_select on public.invoices;
create policy inv_select on public.invoices for select to authenticated using (user_id = auth.uid());
drop policy if exists inv_insert on public.invoices;
create policy inv_insert on public.invoices for insert to authenticated
  with check (user_id = auth.uid() and status = 'draft' and number is null);
drop policy if exists inv_update on public.invoices;
create policy inv_update on public.invoices for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Löschen nur für Entwürfe
drop policy if exists inv_delete on public.invoices;
create policy inv_delete on public.invoices for delete to authenticated
  using (user_id = auth.uid() and status = 'draft');

drop policy if exists own_mail_log on public.mail_log;
create policy own_mail_log on public.mail_log for select to authenticated using (user_id = auth.uid());
-- counters: keine Policy = nur der Server (Edge Function) darf zugreifen
