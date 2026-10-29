-- Update 1: Kundennummern und frei wählbares Nummernformat (z. B. RE0031)
alter table public.customers add column if not exists number text;

drop function if exists public.next_invoice_number(uuid, int);
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
