-- =============================================================
-- Migration 009 — quote_attachments RLS: add WITH CHECK
-- =============================================================
-- Migration 007 created the policy with `for all using (...)` only.
-- For browser-client INSERTs, PostgREST silently rejects rows that
-- don't satisfy a WITH CHECK clause and returns an empty result with
-- no error code in some versions. That's the most plausible reason
-- our commit flow looks like it succeeds but quote_attachments stays
-- empty.
--
-- Rebuilding the policy with both `using` AND `with check` makes
-- INSERT/UPDATE explicit. Safe re-run: drop-then-create is idempotent
-- because the policy name is constant.

drop policy if exists "Users can manage own quote attachments" on quote_attachments;

create policy "Users can manage own quote attachments"
  on quote_attachments for all
  using (
    business_id in (select id from businesses where owner_id = auth.uid())
  )
  with check (
    business_id in (select id from businesses where owner_id = auth.uid())
  );
