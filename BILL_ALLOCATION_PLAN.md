# Bill allocation — implementation plan

**Goal (Brad's words):** "I pay 3–4 supplier invoices in one bank payment. I want the AI to read the bills and allocate the right proportion of each cost to the job it was used on — as painless as possible."

**Chosen shape (from the kickoff Q&A):**
- **Bills-first.** Bills get read + allocated as they arrive; the bank payment just ticks them off. (Brad: gives the quicker picture of financial health.)
- **Whole bill → one job, split only when needed.** Most bills belong to one job; a single shop covering two jobs can be split by line item.
- This doc is for review **before any code.**

---

## 1. The mental model

Two different things, currently tangled together:

- A **bill** = what was bought (supplier, GST, line items). This is the unit we *allocate to jobs*.
- A **bank payment** = cash leaving the account. This is the unit we *reconcile*, and it's what fixes GST timing (payments basis).

One payment can cover several bills; one bill can touch several jobs. So the design treats the **bill** as the source of truth for allocation, and the **payment** as the thing that groups a few bills and marks them paid.

---

## 2. What already exists (most of the machinery is built)

| Piece | File | Status |
|---|---|---|
| LLM bill parser (supplier, total, GST, **lineItems**, **jobHint**) | `lib/bill-parser.ts` (`emit_bill` tool) | ✅ works |
| Browser PDF upload → parse → draft bill | `components/entry/bill-pdf-upload.tsx` | ✅ works (PDF only) |
| Email → CloudMailin → draft bill | `app/api/webhooks/inbound-bill/route.ts` | ✅ works |
| "Bills to confirm" with **per-line job picker** | `app/(app)/home/page.tsx` (`DraftBillRow`) | ✅ works — but only writes `materials` rows |
| Manual split of one bank txn across jobs | `components/reconcile/reconcile-row.tsx` (`SplitForm`) | ✅ works (no bill reading) |
| Bulk-insert N entries from one bank txn | `lib/store.tsx` (`reconcileAsSplitEntries`) | ✅ reusable |
| Smart job ranking from text | `lib/job-match.ts` (`rankJobs`) | ✅ reusable |
| Per-job profit math | `lib/job-stats.ts` (`jobStats`) | ✅ counts `expense`+`bill` (non-draft) per `jobId` |

The two halves — "AI reads a bill" and "split across jobs" — were just never joined. We mostly **wire existing parts together**, not build from scratch.

---

## 3. Two real gaps to close

### Gap A — splitting a bill across jobs doesn't move the *cost*
`DraftBillRow` already lets you assign each line item to a different job, but it only creates **`materials`** rows. And `job-stats.ts` deliberately **excludes** `source='bill'` materials from job cost (comment: "already captured via the linked bill entry"). Meanwhile the whole bill's dollar amount sits on its single `jobId`. Net effect today: assign a line to Job B and **Job B's profit doesn't change** — the cost stays on Job A. That's exactly the thing Brad wants fixed.

### Gap B — confirmed bills never get marked *paid*
There's `markInvoicePaid` (money **in**) but **no equivalent for bills** (money **out**). `reconcileToEntry` links a bank txn to an entry but does **not** set `paid=true`. Yet:
- `lib/tax-estimator.ts` counts a bill only when `type==='bill' && e.paid`.
- `lib/income-allocator.ts` counts a bill only when `e.paid && e.paidDate` in range.

So a confirmed-but-unpaid bill shows in **per-job profit** (good — that's the quick picture Brad wants) but never in **GST / income-tax / Money expense totals**. The reconcile step is where `paid=true` + `paidDate` should be set, and right now nothing does it.

---

## 4. Recommended data model: sibling bill entries linked by `bill_group_id`

A bill that spans jobs becomes **one `type:'bill'` entry per job**, each with its own `jobId`, `amount`, `amountExGst`, `gstComponent`, summing to the invoice total. Siblings share a new nullable column:

```
entries.bill_group_id  uuid  null   -- links the split parts of one invoice
```

- A normal single-job bill → `bill_group_id = null` (unchanged behaviour).
- A split bill → all parts share one `bill_group_id`, the same `payment_ref` (invoice number) and `bill_pdf_url`.

**Why sibling entries (not a new `bill_allocations` table):** `job-stats`, `tax-estimator`, `income-allocator` and the Money tab already sum `bill` entries by `jobId` and filter on `paid` / `isDraft`. Sibling entries make per-job cost **just work** with zero changes to that math — smallest blast radius, least double-count risk. An allocation child-table would mean touching every one of those readers.

**Materials stay for the detail log.** We still create `source='bill'` `materials` rows from line items (useful for the quoting engine), and `job-stats` keeps ignoring them for cost — so no double counting. The cost split lives in the sibling **entries**; the materials rows are descriptive only.

---

## 5. End-to-end flow

```
1. Bill arrives
   • email auto-draft (existing), or
   • photo/PDF upload (existing PDF; photo = Phase 2)
   → draft bill entry: isDraft=true, paid=false

2. Confirm on Home (DraftBillRow)
   • pick one job (default), OR assign lines to different jobs
   • NEW: a per-job subtotal preview ("Smith $200 · Jones $150 · OH $125 = $475")
   → on confirm:
       - all lines follow one job  → 1 bill entry (today's behaviour)
       - lines split across jobs    → N sibling bill entries (shared bill_group_id)
     isDraft=false, paid=false
   → counts in per-job profit immediately  ✅ quick financial-health picture
   → NOT yet in GST/tax (correct — unpaid, payments basis)

3. Bank payment lands → Reconcile screen
   • the payment row suggests unpaid confirmed bills that sum to it
     (e.g. 3 Trademax bills = $475.51), matched by supplier + amount + date
   • Brad ticks the bills this payment covers; running total vs payment
     amount shown (reuse SplitForm's balance UX)
   → markBillsPaid(bankTxnId, billEntryIds, paidDate):
       paid=true, paidDate=payment date, bankTransactionId=set,
       operating on bill_group_id so split siblings flip together
   → now hits GST / income tax on the correct payment date  ✅
```

The only manual moments: confirm the allocation once per bill, and tick which bills a payment covers. Both are single-screen, single-save (UX rule).

---

## 6. Parser changes (additive, low risk)

`lib/bill-parser.ts` already emits `lineItems` + a bill-level `jobHint`. Minimal enhancement for better auto-splitting:

- Add an **optional per-line `jobHint`** to the `emit_bill` line-item schema (e.g. a line that says "DELIVER TO 10 McCloud Ave"). The confirm UI pre-fills each line's job via `rankJobs(lineHint)`; Brad adjusts. Keep it best-effort — wrong data is worse than missing (already the parser's stated rule).
- No change to the GST/money invariants in `normaliseParsedBill` — splitting keeps GST proportional per sibling.

---

## 7. Double-counting safeguards (explicit, since you asked)

1. **Drafts never count.** `isDraft` filter is already enforced in `job-stats`, `money`, `tax-estimator`, `job-detail-sheet`. Preserve it everywhere new.
2. **Bill-sourced materials never count as cost.** `job-stats` already excludes `source='bill'`. The cost split lives in sibling **entries**, materials remain descriptive → no overlap.
3. **Split replaces, never augments.** Confirming a split must not leave the full amount on the home job *and* add siblings. Plan: reuse the existing draft entry as sibling #1 (reduce its `amount`/`amountExGst`/`gstComponent` to its job's share, set `bill_group_id`), insert the remaining siblings, all summing to the invoice total. A reconciliation assert (`Σ siblings == totalInclGst ± $0.02`) blocks confirm if it doesn't add up (same tolerance the SplitForm uses).
4. **Reconcile matches the group.** `markBillsPaid` flips every sibling of a `bill_group_id` together, so a split bill is never half-paid and the payment total reconciles against the full invoice.
5. **Duplicate detector must exempt siblings.** The Money tab's duplicate detection keys on supplier/date/amount — sibling bill entries (same supplier, date, ref) will look like duplicates. Exempt rows that share a `bill_group_id`.
6. **Bills become expenses only when `paid=true`** (AGENTS.md). `markBillsPaid` is the *only* new path that sets it; confirm never does.

---

## 8. Tax correctness (golden rule #2)

This design keeps the two views correctly separated:

- **Per-job profit** (job-stats) counts a bill as soon as it's confirmed (paid or not) — so Brad's "is this job making money" picture updates the moment he allocates. That's an attribution view, not a tax claim.
- **GST + income tax** (tax-estimator, income-allocator) count a bill only once `paid=true` with a `paidDate` — matching Brad's **payments-basis** GST registration. Setting `paidDate` to the **bank payment date** (not the invoice date) is the correct claim date and lands the GST in the right two-monthly return.

One UX note so this isn't confusing: a confirmed-but-unpaid bill won't appear in the Money tab's expense/GST totals yet. The existing "upcoming bills" surface (`money/page.tsx`, `bill && !isDraft && dueDate>=now`) already shows these as *owed*; we should label confirmed-unpaid bills as "committed / not yet paid" so the gap reads as intentional.

---

## 9. Migration (021) — illustrative

```sql
-- 021_bill_groups.sql
alter table entries
  add column if not exists bill_group_id uuid;

create index if not exists entries_bill_group_idx
  on entries (business_id, bill_group_id)
  where bill_group_id is not null;
```

(Per AGENTS.md, when we actually run this I'll paste the SQL into chat for copy-paste rather than relying on file permissions. `mappers.ts` gains `bill_group_id ↔ billGroupId`; `types.ts` `Entry` gains `billGroupId?: string`.)

---

## 10. Phasing

**Phase 1 — the core ask, mostly wiring (low risk).**
1. `021` migration + `billGroupId` on `Entry` + mapper.
2. Confirm-time cost split: `DraftBillRow` produces per-job subtotals and creates sibling bill entries (reuses the per-line picker + `reconcileAsSplitEntries`-style insert).
3. Reconcile "match payment → bills" + `markBillsPaid` (closes Gap B; closes Gap A via siblings).
4. Duplicate-detector exemption for `bill_group_id`.

Delivers exactly what Brad described, almost entirely from existing parts.

**Phase 2 — phone-painter polish (bigger lifts).**
5. **Photo capture + Claude vision parsing.** Today upload is PDF-only and image-only scans are rejected (no OCR). Sending the photo straight to a Claude vision model with the same `emit_bill` tool removes the PDF requirement — the single biggest "5:30pm on a phone" win. Needs a new route + model call.
6. Per-line `jobHint` from the parser (section 6).
7. Auto-suggest the bill↔payment match with confidence, so common cases are one tap.

---

## 11. Open decisions for Brad

1. **`bill_group_id` sibling entries** (recommended) vs a `bill_allocations` child table. Recommend siblings — smaller blast radius.
2. **Photo + Claude vision** (recommended, Phase 2) vs stay PDF/email-only for now.
3. At reconcile, when a set of bills sums exactly to a payment, **auto-mark paid** vs **always require a tap**. Recommend always a tap — it's money movement and the payments-basis claim date hangs off it.
4. Scope for the first build: **all of Phase 1**, or just the reconcile "pay multiple bills at once" piece first?
```