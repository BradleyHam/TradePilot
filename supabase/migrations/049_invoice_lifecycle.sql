-- =============================================================
-- Migration 049 — Separate invoice lifecycle from work status
-- =============================================================
-- Jobs describe the work. Invoices independently move through
-- draft -> sent -> paid, or draft/sent -> void. Due/overdue is derived
-- from a sent invoice's due_date.

alter table invoices
  add column if not exists status text,
  add column if not exists due_date date,
  add column if not exists sent_at timestamptz,
  add column if not exists status_before_paid text,
  add column if not exists payment_entry_generated boolean,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text;

-- Backfilled final stubs on unfinished jobs were never necessarily sent.
-- Preserve those as drafts rather than manufacturing GST/overdue exposure.
update invoices i
set status = case
  when i.paid then 'paid'
  when i.kind = 'final'
    and coalesce(i.notes, '') ilike 'Backfilled%'
    and exists (
      select 1 from jobs j
      where j.id = i.job_id
        and j.status not in ('completed', 'invoiced', 'paid')
    ) then 'draft'
  else 'sent'
end
where status is null;

update invoices
set payment_entry_generated = false
where payment_entry_generated is null;

update invoices
set sent_at = coalesce(created_at, invoice_date::timestamptz),
    due_date = invoice_date + 14
where status = 'sent'
  and sent_at is null;

alter table invoices
  alter column status set default 'sent',
  alter column status set not null,
  alter column payment_entry_generated set default false,
  alter column payment_entry_generated set not null;

alter table invoices
  drop constraint if exists invoices_status_check,
  drop constraint if exists invoices_status_before_paid_check,
  drop constraint if exists invoices_paid_matches_status_check;

alter table invoices
  add constraint invoices_status_check
    check (status in ('draft','sent','paid','void')),
  add constraint invoices_status_before_paid_check
    check (status_before_paid in ('draft','sent')),
  add constraint invoices_paid_matches_status_check
    check ((status = 'paid' and paid) or (status <> 'paid' and not paid));

create index if not exists invoices_status_idx on invoices(status);
create index if not exists invoices_due_date_idx on invoices(due_date);

-- One transaction: invoice + income entry either both change or neither does.
create or replace function mark_invoice_paid(
  p_invoice_id uuid,
  p_paid_date date,
  p_paid_via text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_entry entries%rowtype;
  v_entry_id uuid;
  v_created_entry boolean := false;
  v_gross numeric(10,2);
  v_gst numeric(10,2);
begin
  select * into v_invoice
  from invoices
  where id = p_invoice_id
  for update;

  if not found then
    raise exception 'Invoice not found';
  end if;
  if v_invoice.status = 'void' then
    raise exception 'A void invoice cannot be marked paid';
  end if;
  if v_invoice.status = 'paid' then
    select * into v_entry from entries where id = v_invoice.income_entry_id;
    return jsonb_build_object(
      'invoice', to_jsonb(v_invoice),
      'entry', case when v_entry.id is null then null else to_jsonb(v_entry) end,
      'created_entry', false
    );
  end if;

  v_entry_id := v_invoice.income_entry_id;
  if v_entry_id is null then
    v_gst := coalesce(v_invoice.gst_component,
      case when v_invoice.gst_applies then round(v_invoice.amount_ex_gst * 0.15, 2) else 0 end);
    v_gross := coalesce(v_invoice.amount_incl_gst, v_invoice.amount_ex_gst + v_gst);

    insert into entries (
      business_id, job_id, type, amount, payment_method,
      gst_applies, amount_ex_gst, gst_component,
      description, entry_date
    ) values (
      v_invoice.business_id, v_invoice.job_id, 'income', v_gross,
      coalesce(nullif(p_paid_via, ''), 'Bank transfer'),
      v_invoice.gst_applies, v_invoice.amount_ex_gst, v_gst,
      v_invoice.invoice_number || ' payment received', p_paid_date
    )
    returning * into v_entry;
    v_entry_id := v_entry.id;
    v_created_entry := true;
  else
    select * into v_entry from entries where id = v_entry_id;
  end if;

  update invoices
  set paid = true,
      status_before_paid = case
        when v_invoice.status in ('draft','sent') then v_invoice.status
        else coalesce(v_invoice.status_before_paid, 'sent')
      end,
      status = 'paid',
      paid_date = p_paid_date,
      paid_via = coalesce(nullif(p_paid_via, ''), v_invoice.paid_via),
      income_entry_id = v_entry_id,
      payment_entry_generated = v_created_entry
  where id = p_invoice_id
  returning * into v_invoice;

  return jsonb_build_object(
    'invoice', to_jsonb(v_invoice),
    'entry', case when v_entry.id is null then null else to_jsonb(v_entry) end,
    'created_entry', v_created_entry
  );
end;
$$;

-- Undo only deletes a payment entry that TradePilot itself generated.
-- Pre-existing/imported/bank-matched entries are preserved and merely unlinked.
create or replace function unmark_invoice_paid(p_invoice_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_entry entries%rowtype;
  v_deleted_entry boolean := false;
  v_preserved_entry boolean := false;
begin
  select * into v_invoice
  from invoices
  where id = p_invoice_id
  for update;

  if not found then
    raise exception 'Invoice not found';
  end if;
  if v_invoice.status <> 'paid' then
    return jsonb_build_object('invoice', to_jsonb(v_invoice), 'deleted_entry', false, 'preserved_entry', false);
  end if;

  if v_invoice.income_entry_id is not null and v_invoice.payment_entry_generated then
    select * into v_entry from entries where id = v_invoice.income_entry_id for update;
    if found then
      update bank_transactions
      set status = 'unreconciled', entry_id = null
      where entry_id = v_entry.id
         or (v_entry.bank_transaction_id is not null and id = v_entry.bank_transaction_id);
      delete from entries where id = v_entry.id;
      v_deleted_entry := true;
    end if;
  elsif v_invoice.income_entry_id is not null then
    v_preserved_entry := true;
  end if;

  update invoices
  set paid = false,
      status = coalesce(v_invoice.status_before_paid, 'sent'),
      status_before_paid = null,
      paid_date = null,
      paid_via = null,
      income_entry_id = null,
      payment_entry_generated = false
  where id = p_invoice_id
  returning * into v_invoice;

  return jsonb_build_object(
    'invoice', to_jsonb(v_invoice),
    'deleted_entry', v_deleted_entry,
    'preserved_entry', v_preserved_entry
  );
end;
$$;

create or replace function void_invoice(p_invoice_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
begin
  select * into v_invoice
  from invoices
  where id = p_invoice_id
  for update;

  if not found then
    raise exception 'Invoice not found';
  end if;
  if v_invoice.status = 'paid' or v_invoice.income_entry_id is not null then
    raise exception 'Undo the payment before voiding this invoice';
  end if;

  update invoices
  set status = 'void',
      paid = false,
      voided_at = now(),
      void_reason = nullif(trim(p_reason), '')
  where id = p_invoice_id
  returning * into v_invoice;

  return to_jsonb(v_invoice);
end;
$$;
