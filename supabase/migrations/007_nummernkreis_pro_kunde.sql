-- Update 6: eigener Rechnungsnummernkreis pro Kunde (z. B. RE-10002-0031)
alter table public.customers add column if not exists invoice_counter int not null default 0;
alter table public.customers add column if not exists invoice_start int not null default 1;

create or replace function public.next_customer_invoice_number(p_user uuid, p_customer uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.customers
     set invoice_counter = greatest(invoice_counter + 1, invoice_start)
   where id = p_customer and user_id = p_user
  returning invoice_counter into n;
  if n is null then raise exception 'Kunde nicht gefunden'; end if;
  return n;
end $$;
revoke all on function public.next_customer_invoice_number(uuid, uuid) from public, anon, authenticated;
