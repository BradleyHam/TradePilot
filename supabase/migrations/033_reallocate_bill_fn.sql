-- =============================================================
-- Migration 033 — reallocate_bill() (atomic bill re-allocation)
-- =============================================================
-- store.reallocateBill previously ran three independent statements
-- (update primary / delete old siblings / insert new siblings) via
-- Promise.all. A partial failure — delete succeeds, insert fails —
-- left the DB missing bill rows while the UI "rolled back", i.e.
-- silent loss of real money data on next reload.
--
-- This function does all three inside one transaction: any failure
-- rolls the whole thing back, so the group is always either fully
-- re-allocated or untouched.
--
-- SECURITY INVOKER (the default): runs as the calling user, so the
-- existing owner-only RLS policies on `entries` still gate every row
-- touched. An employee calling this gets zero rows updated and an
-- exception — same as today.
--
-- Returns the newly inserted sibling rows so the client can swap its
-- optimistic temp rows for the persisted ones.

create or replace function reallocate_bill(
  p_primary_id    uuid,
  p_primary_job   uuid,     -- null = overhead
  p_primary_gross numeric,
  p_primary_ex    numeric,
  p_primary_gst   numeric,
  p_group_id      uuid,     -- null when collapsing back to a single row
  p_delete_ids    uuid[],   -- old sibling rows to remove
  p_new_rows      jsonb     -- array of sibling row objects (snake_case keys)
) returns setof entries
language plpgsql
security invoker
as $$
declare
  v_row jsonb;
begin
  -- 1. Primary becomes slice #1. RLS applies: if the caller can't see
  --    the row, FOUND is false and we abort before touching anything.
  update entries set
    job_id        = p_primary_job,
    amount        = p_primary_gross,
    amount_ex_gst = p_primary_ex,
    gst_component = p_primary_gst,
    bill_group_id = p_group_id
  where id = p_primary_id;
  if not found then
    raise exception 'reallocate_bill: primary row % not found (or not yours)', p_primary_id;
  end if;

  -- 2. Old siblings out.
  if p_delete_ids is not null and array_length(p_delete_ids, 1) > 0 then
    delete from entries where id = any(p_delete_ids);
  end if;

  -- 3. New siblings in (slices 2..N). Explicit column list — jsonb keys
  --    are the snake_case column names sent by the client.
  for v_row in select * from jsonb_array_elements(coalesce(p_new_rows, '[]'::jsonb))
  loop
    return query
    insert into entries (
      business_id, job_id, type, is_draft, paid, paid_date,
      bank_transaction_id, company, supplier, description,
      amount, amount_ex_gst, gst_component, gst_applies,
      entry_date, due_date, payment_ref, bill_pdf_url,
      parser_confidence, bill_group_id, created_at
    ) values (
      (v_row->>'business_id')::uuid,
      (v_row->>'job_id')::uuid,
      'bill',
      coalesce((v_row->>'is_draft')::boolean, false),
      coalesce((v_row->>'paid')::boolean, false),
      (v_row->>'paid_date')::date,
      (v_row->>'bank_transaction_id')::uuid,
      v_row->>'company',
      v_row->>'supplier',
      v_row->>'description',
      (v_row->>'amount')::numeric,
      (v_row->>'amount_ex_gst')::numeric,
      (v_row->>'gst_component')::numeric,
      coalesce((v_row->>'gst_applies')::boolean, true),
      (v_row->>'entry_date')::date,
      (v_row->>'due_date')::date,
      v_row->>'payment_ref',
      v_row->>'bill_pdf_url',
      v_row->>'parser_confidence',
      (v_row->>'bill_group_id')::uuid,
      coalesce((v_row->>'created_at')::timestamptz, now())
    )
    returning *;
  end loop;
end;
$$;
