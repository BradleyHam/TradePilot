<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Trade Pilot — agent context

Trade Pilot is a job, finance, pipeline and tax tracker for small NZ trade businesses. The first user is **Brad Hamilton, Lakeside Painting Ltd** (Wanaka), a one-person painting company with occasional help from his partner. Brad's tax position and workflow shape every decision in here.

If you're a new agent picking this up, read this whole file before writing code. The most-violated rule is the golden rule below — protect it.

---

## The golden rules

There are two. Both apply always.

### 1. The UX rule — "tired painter, 5:30pm, phone"

**Can a tired painter use this easily at 5:30pm, on a phone, after a 6-hour day on site?**

Every UI decision goes through this filter. If it doesn't pass, it doesn't ship. Concretely:

- **Big tap targets.** Minimum 44px high. No tiny icons-only buttons for primary actions.
- **Phone first.** Design for ~380px viewport. Desktop is a bonus.
- **Minimum taps to log a thing.** "I bought paint for the Smith job" should be ≤3 taps from home, with sensible defaults (today's date, last-used job pre-selected, etc).
- **No multi-step wizards** for common actions. Single screen, single save.
- **Forgive bad input.** Auto-format amounts, accept "$186" / "186" / "186.00", parse "yesterday" and "monday", forgive trailing whitespace.
- **Loud failures.** When a save fails, say so on the screen — don't silently revert.
- **No paywalls or modals in the way of logging.** Brad can't pay for a subscription mid-roller-stroke.
- **No empty visualisations.** A fresh job with zero data shouldn't render six empty stat cards. Hide gracefully.

### 2. The tax-minimisation rule — "save Brad as much tax as legally possible"

**When a transaction or accounting decision has more than one defensible treatment under NZ tax law, pick the one that costs Brad less tax.** When the user asks for advice that touches tax — pricing, timing, deduction categories, expense vs personal — proactively flag tax-saving angles even if not asked.

This means:

- Surface deductible expenses Brad might be miscategorising as personal.
- Flag timing decisions that would land income in a different tax year (e.g. invoice 30 March vs 1 April).
- Remind him about the once-a-year decisions: shareholder salary reclassification, provisional tax instalments (Aug / Jan / May), GST returns, end-of-year IR4 filing.
- Income-splitting via Suzie's wages is now IN PLACE (she's on payroll — see "Brad's tax structure" below). Focus shifts from "set this up" to keeping it defensible: market-rate hourly, PAYE returns filed on time, wages deducted before year-end salary reclassification.
- Flag when an expense should run through the company books rather than personal, and vice versa.

**Constraints:**

- Stay strictly inside NZ tax law. No grey-area aggressive positions, no "the IRD probably won't notice" reasoning.
- When advising on a specific transaction, name the IRD provision/rule supporting the position when known (e.g. "deductible under s DA 1", "GST claimable under s 21B for pre-registration purchases").
- When unsure of the law, say so plainly and recommend he confirms with an accountant — Brad doesn't have one yet, so the bar for "I'm sure" is high.
- Don't optimise so hard that Brad ends up with audit risk or unsupportable records. If the IRD asked tomorrow, Brad needs to be able to produce the evidence.
- "Brad does his own books" means *Claude* is the second pair of eyes. Be careful and consistent rather than clever.

---

## Stack

- **Next.js 16 / React 19** — note: NOT the Next.js most LLMs know. Read `node_modules/next/dist/docs/` before writing routes, layouts, or middleware.
- **TypeScript strict mode**, no implicit any.
- **Tailwind v4** + shadcn-style components (`components/ui/*`).
- **Supabase** (Postgres + Auth + RLS). Browser client at `lib/supabase/client.ts`, admin client at `lib/supabase/admin.ts` (only for scripts).
- **lucide-react** icons. **recharts** for the bigger charts; raw SVG for gauges and small bars.
- **tsx + dotenv** for local scripts (the importer, etc).

Run scripts:

```
npm run dev          # Next.js dev server
npm run build        # production build
npm run lint         # eslint
npm run import       # dry-run import from Finances JSON dumps
npm run import:apply # apply the import to Supabase
npm run import:reset # truncate then re-import (idempotent, safe-ish)
```

---

## What's built (current as of May 2026)

This is a working app, not a prototype. Pages and key features:

**Pages**
- `/login` — public, password sign-in. No sign-up flow.
- `/(app)/entry` — natural-language + form entry. NL parser at `lib/nl-parser.ts` is regex-based (no LLM). Extracts dates from text ("yesterday", "monday", "8th of April", "30/04").
- `/(app)/jobs` — list view with chip filters (All, In progress, Coming up, Completed, Leads, Quoted, Booked, Invoiced, Paid, Lost, Declined). "Coming up" = lead+quoted+accepted+booked; mutually exclusive with "In progress". Tap a job → bottom sheet with sticky status header, financials grid, hourly-rate gauge, budget bar, hours-by-activity, **invoices list**, activity log.
- `/(app)/money` — KPI grid, **timeframe filter** (This month / Last month / Other), **Cash/Earned basis toggle**, **tax exposure card** (with current/previous tax year toggle), revenue/expense charts, pipeline-by-stage breakdown, transaction list with duplicate detection. FIXED July 2026: KPIs, chart and category breakdown now use `expensesInWindow` / `cashIncomeExGstInWindow` (ex-GST, paid bills included by paidDate) — previously expense-type-only at gross, which omitted every supplier bill and disagreed with Home.
- `/(app)/schedule` — booked work, follow-ups, bill due dates.
- `/(app)/settings` — sign out, GST settings, business info.

**Per-job invoicing flow** (the big chunk of recent work)
- `invoices` table with `kind = deposit | progress | final`, paid status, `income_entry_id` linking back to auto-created income entries.
- `InvoiceAction` sheet (`components/jobs/invoice-action.tsx`) handles BOTH create and edit — pass an `invoice` prop to edit. Smart defaults: empty job → deposit @ 30%, deposit issued → final with balance pre-filled.
- Tap any invoice row in the JobDetailSheet's invoices list to edit it.
- "Mark paid" auto-creates a linked income entry on the chosen date. Going paid → unpaid is NOT yet built (would need to delete the linked entry too).

**Tax estimator** (`lib/tax-estimator.ts`)
- Live GST + income tax estimate for the current NZ tax year (1 Apr – 31 Mar).
- Pro-rates annual deductions (vehicle km, home+shed, phone+internet, laptop dep) to elapsed days.
- Hardcoded Brad-specific defaults — see "Tax assumptions" below.
- Tax-year toggle on the card lets the user view current vs previous year.

**Earned vs Cash basis** (`lib/income-allocator.ts`)
- Cash: income on the date payment hit the bank.
- Earned: for completed/invoiced/paid jobs, income allocated across months by hours-share. Pending jobs (in-progress and earlier) contribute zero.
- Money tab toggle defaults to Earned. Subvalue under Revenue shows the other side ("Cash received: $X" when on Earned, etc).

**Per-job financials** (`lib/job-stats.ts`)
- Single source of truth used by JobCard list AND JobDetailSheet.
- Always returns ex-GST numbers. GST is pass-through, not money Brad keeps.
- `expectedIncome` priority: invoiced/completed/paid → invoice amount; otherwise → received income → quote → estimate. So a deposit-only invoiced job shows the *full* expected hourly rate, not the deposit-only one.

---

## Database schema

Eight tables (see `supabase/schema.sql`):

| Table | Purpose |
|---|---|
| `businesses` | One row per business, RLS-scoped to `owner_id = auth.uid()`. |
| `jobs` | `legacy_id` (J1/J2/...) so imported records keep their sheet IDs. `quote_amount`, `invoice_amount` both ex-GST. |
| `entries` | Expenses, income, hours, enquiries, quotes, bills, notes. GST-aware (`gst_applies`, `amount_ex_gst`, `gst_component`). Bill-only fields: `paid`, `paid_date`, `payment_ref`, `company`. |
| `schedule_items` | Calendar-shaped reminders / bookings. |
| `materials` | Brand/colour/finish/qty/unit/cost mirroring the Finances "Materials & Paint" tab. |
| `quotes` | First-class quote records (separate from quote-type entries). Has `legacy_id`, `legacy_enquiry_id`, optional link to a Job once won. |
| `settings` | Keyed `(business_id, key)` for `gst_mode`, `gst_rate`, etc. |
| `invoices` | **NEW.** Many per job. `kind = deposit/progress/final`. Auto-creates income entries when marked paid; `income_entry_id` links the two. Unique on `(business_id, invoice_number)`. |

RLS is on for every table — every policy is "you can manage rows for businesses where `owner_id = auth.uid()`". This bites scripts that aren't using the service-role key.

Migrations beyond `schema.sql` live in `supabase/migrations/`. Currently:
- `001_invoices.sql` — invoices table + first-pass backfill from `jobs.invoice_amount`.

---

## Data model conventions

- **`snake_case` in Supabase, `camelCase` in TypeScript.** Translation lives in `lib/supabase/mappers.ts`. Don't sprinkle column names elsewhere.
- **All money is gross in `amount`** with `gst_applies`, `amount_ex_gst`, `gst_component` tracked separately.
- **All financial *math* is ex-GST.** GST is pass-through to the IRD; not money Brad keeps. Mixing gross income with ex-GST expenses produces wildly wrong numbers — see `lib/job-stats.ts` and `lib/tax-estimator.ts` for the canonical pattern (`entryExGst()` helper).
- **Quote amount, invoice amount** on jobs are ex-GST. The legacy import tried to preserve this; verify with the user when in doubt because some imported rows came in incl-GST and had to be patched.
- **Jobs from the legacy Finances sheet keep their `J1`/`J2`/... IDs** in `jobs.legacy_id`. UUIDs are the primary key.
- **"OH" job IDs in the importer map to `null` job_id**, not a sentinel row.
- **NZ tax year = 1 April → 31 March.** `lib/tax-estimator.ts` has helpers (`taxYearOf`, `previousTaxYearOf`, `daysIntoTaxYear`).
- **Per-job profit charges ALL labour; business-wide totals don't.** `lib/job-stats.ts` adds employee wages (`payrollLabourCost` = their hours x the payroll rate) and sub/helper labour (`contractorLabourCost`) to a job's expenses, so `expectedProfit` is what's actually left for Brad and `ownerRate` (profit / his own hours) is a real take-home rate. That wage is ALSO paid through a pay run, which is where Money and the tax estimator see it — so rolling per-job figures up into a business total, or letting `payrollLabourCost` anywhere near `estimateTax` / `expensesInWindow`, counts the same money twice. Management figure only, same fence as `unbilledLabourCost` in `lib/labour-accrual.ts`.
- **`expectedHourlyRate` is not anybody's rate.** It's revenue over everyone's hours — a pricing yardstick. The number to show a person is `ownerRate`.

---

## Mutators contract

Every mutator (`addX`, `updateX`) in `lib/store.tsx`:
1. Updates local React state immediately (optimistic).
2. Fires the Supabase write in the background.
3. On failure: logs, sets `error` on the store, rolls back the local state.
4. For inserts: replaces the temporary client-id with the real Supabase UUID once the row comes back.

Special mutators:
- `markInvoicePaid(invoiceId, paidDate, paidVia?)` — flips the invoice paid AND creates a linked income entry in the same flow. Has its own rollback for entry-insert vs invoice-update failures.

**Don't call Supabase directly from a component.** Always go through the store. If you need a new mutator, add it there and follow the optimistic + rollback pattern.

The store ALSO degrades gracefully if a single table fetch fails — it logs the per-table error, sets `error`, and continues with empty arrays for the failing table. Don't break this; one missing migration shouldn't blank the whole app.

---

## Auth

- Single-user sandbox right now. No sign-up flow on purpose.
- The auth gate lives in `app/(app)/layout.tsx`. Anything under `(app)/` requires sign-in. `app/login/page.tsx` is the only public page.
- Adding new pages: put them under `app/(app)/<name>/page.tsx` so they inherit the gate.
- Adding a new user: do it in the Supabase dashboard. Then update `supabase/seed.sql` to point at the new email and re-run.

---

## Gotchas we've already hit (don't repeat them)

### Stale-prop trap
List page passes a `Job` (or `Entry`, `ScheduleItem`) into a detail sheet via prop. **That prop is a snapshot at click-time.** Mutating the store doesn't change it. Fix: in the detail component, look up the live record from `useStore()` by id rather than reading the prop directly. See `JobDetailSheet`'s `liveJob` for the pattern.

### Sticky positioning inside Sheet
shadcn `SheetContent` is a flex-col with `overflow-y-auto`. `position: sticky` on a child behaves unpredictably. Solution: structure the sheet as `overflow-hidden` outer + non-shrinking header + `flex-1 overflow-y-auto` body. See `JobDetailSheet`.

### Cascade deletes nuke imported data
`businesses.owner_id` references `auth.users(id) ON DELETE CASCADE`, and `jobs/entries/materials/quotes/invoices` cascade off `businesses(id)`. Delete-and-recreate the auth user (e.g. when setting a password) and every imported row gets nuked. Long-term fix: change FK to `ON DELETE SET NULL`. The importer is idempotent (`npm run import:reset`) so re-running fixes it.

### Cross-platform `node_modules`
If you run `npm install` inside the agent's Linux workspace, you'll get the wrong-platform esbuild binary and the Mac dev server will refuse to start. Symptom: `You installed esbuild for another platform`. Fix: `rm -rf node_modules package-lock.json && npm install` on the Mac.

### File permissions on workspace-created files
Files created by the workspace (e.g. SQL migrations under `supabase/migrations/`) come out with restrictive permissions that the user's Mac account can't read directly via Finder/zsh. **Print SQL into the chat for copy-paste rather than telling the user to `cat` the file.**

### Bills double-counted
Bills become expenses by being marked `paid = true`, NOT by adding a separate expense entry. `lib/job-stats.ts` already deduplicates correctly (counts bills + expenses but not both for the same logical thing).

### Two-digit years in imported dates
The importer (`scripts/import-finances.ts`) handles `02/11/26` style dates. Year < 70 → 20YY, else 19YY. The regex picks 4-digit years before 2-digit ones (`(\d{4}|\d{2})(?!\d)`), otherwise `2026` parses as `20`. Don't break this.

### `declined` is not `lost` — and it replaced "park" (August 2026)

Jobs have **two** terminal non-win statuses and conflating them is a bug:

- **`lost`** — we wanted it, we didn't get it (outbid, ghosted, project cancelled). Counts against the win rate.
- **`declined`** — *Brad* said no (out of area, wrong fit, too small, too busy). Counts **neither way**. There was never a contest to lose, and counting it as a loss made the conversion rate punish good decisions.

Migration `040_job_declined_status.sql` added it and **retired the old "park" flow** (029 `dismissed_at` + 039 `dismissed_reason`) — two mechanisms for one idea. The columns were **renamed**, not dropped: `dismissed_at → declined_at`, `dismissed_reason → decline_reason`, plus a new `declined_from_status`. Every parked lead was migrated to `status='declined'` with its old status preserved. **There is no `dismissedAt` any more** — if you're reading old code or chat history that references it, it's `declinedAt` now.

- **Always reversible.** `declined_from_status` records the stage the job left from, so "Put it back on the list" restores a declined *quote* to `quoted`, not `lead`. Pre-040 rows with no recorded stage fall back to `lead`. Clearing `declinedAt` (empty string) wipes all three fields — `lib/supabase/mappers.ts` couples them deliberately so no caller has to remember.
- **Entry points:** the status dropdown (routes through `declineJob()` so it can't produce a half-declined job), the "Turn this one down" row on JobDetailSheet (lead → booked), and the two-tap action in the Leads card snooze tray. `DeclineJobSheet` captures an optional free-text reason — never blocking, one tap is a complete answer.
- **Reconcile treats it like `lost`:** declining prunes future bookings off the calendar (`pruneFuture=true`). Declining an already-*booked* job is the case that most needs this, or its work days keep blocking availability.
- **`LostReason.'too-far'` / `'wrong-fit'` are legacy.** They were the "we declined it" values smuggled into the loss enum pre-040. Still in the union so historical rows typecheck; **removed from the OutcomeSheet picker**. Don't set them on new jobs.
- Excluded from pipeline value + active-job count on Money, from every ratio in Lead Insights (it's in neither `WON_STATUSES` nor `isLost`, and `statusMeta` labels it "Turned down" so it can't masquerade as an open lead).

### Agreed price without a quote (the handshake-price path)
`AgreedPriceCard` in `components/jobs/job-detail-sheet.tsx` IS the entry point for "we agreed a number on the phone / the builder had allowed for it" — tap the Agreed price tile in Financials, type the figure, save. It writes `jobs.quoteAmount` directly, so **no quote record is needed** and the whole Financials block (expected income / profit / $/h) lights up. The label switches Quote → Agreed price past acceptance because the same field means different things either side of it.

As of July 2026 the editor asks **+ GST vs incl GST** explicitly and converts to ex-GST before saving, previewing the converted figure. That's a direct fix for the bug class below — a verbally-agreed price arrives either way ("2500 plus GST" from a builder, "$2875 all up" from a homeowner) and silently assuming ex-GST is what produced the Aubrey Road / McLeod Ave / J16 cleanups. Note the input deliberately has **no `onBlur` commit** — tapping a GST chip blurs the field, and committing on blur would save under the wrong basis. Explicit Save/Cancel buttons instead.

### Quote amounts: GST treatment was inconsistent in legacy data
Most jobs imported from the Finances sheet stored `quote_amount` ex-GST. A few were incl-GST. The earlier "Aubrey Road" job had this issue — we set `invoice_amount` to incl-GST by mistake when first logging it, which then propagated to the backfilled invoices. **Always confirm with the user when entering a quote/invoice amount whether the figure is ex- or incl-GST.** See the chat history for the J16 fix as the canonical example.

### Invoice deposit + final math
When backfilling invoices from `jobs.invoice_amount`:
- Final invoice amount = `invoice_amount - deposit_invoice_amount` (ex-GST).
- If you treat `invoice_amount` as incl-GST when it's ex-GST (or vice versa), the numbers cascade wrong through every invoice on the job. Triple-check the units before running migrations on this kind.

---

## InvoiceAction component

`components/jobs/invoice-action.tsx` is dual-mode:
- **Create mode** (no `invoice` prop): smart defaults pick deposit vs final based on what's already on the job.
- **Edit mode** (`invoice` prop passed): form populated with the invoice's current values. On save, calls `updateInvoice` instead of `addInvoice`.

When editing, the kind chips don't auto-disable for the kind already used (since it's the one being edited). Invoice number doesn't auto-rewrite when you change kind in edit mode.

The "Mark paid" tickbox only handles unpaid → paid. Going paid → unpaid would need to delete the linked income entry too — not yet built. If a user needs to unmark paid, they do it via Supabase Table Editor.

---

## Importer

- Lives at `scripts/import-finances.ts`.
- Reads JSON dumps from `data/import/` (slug-named files per worksheet).
- The Python exporter that produces those dumps is `scripts/export_sandbox_to_json.py` (Google Sheets → JSON, requires `service-worker.json` credentials and the sheet shared with the service account).
- `npm run import` is dry-run by default. `--apply` writes. `--reset` truncates first.
- Date parsing: handles M/D/YYYY, D/M/YYYY (when first part > 12), YYYY-MM-DD, with 2-digit year support.
- Status mapping: `New → lead`, `Accepted → accepted`, `In progress → in-progress`, `Completed → completed`.

---

## Inbound bill webhook (Gmail → CloudMailin → Trade Pilot)

The route at `app/api/webhooks/inbound-bill/route.ts` turns forwarded supplier emails into draft bills that land in the Home screen's "Bills to confirm" flag. Pipeline:

```
Supplier email
  → Gmail (bradleyjamesham@gmail.com) filter matches supplier rules
  → Gmail auto-forwards to the CloudMailin address (verified May 2026)
  → CloudMailin POSTs the email as JSON to the production webhook
  → /api/webhooks/inbound-bill validates, parses the PDF, inserts a draft entry
  → Draft appears on Home next time the app loads
```

**Env vars (must be set on Vercel AND in `.env.local`):**
- `INBOUND_BILL_WEBHOOK_SECRET` — shared secret. CloudMailin must send it as `x-webhook-secret` header OR embed it in the URL as basic-auth (`https://anything:<secret>@host/...`). Free-tier CloudMailin can't set custom headers, so the basic-auth form is what's currently wired up. All four webhook routes compare secrets constant-time via `lib/webhook-auth.ts` (July 2026) — add new webhook routes through that helper, not inline `===`.
- `TRADEPILOT_BUSINESS_ID` — which business the drafts land against.
- `SUPABASE_SERVICE_ROLE_KEY` — used for the insert (bypasses RLS, since there's no auth.uid() on an inbound webhook).
- `ANTHROPIC_API_KEY` — used by `parseBillText` to extract supplier/amount/GST.

**CloudMailin → webhook URL.** Format is `https://anything:<INBOUND_BILL_WEBHOOK_SECRET>@<your-vercel-domain>/api/webhooks/inbound-bill`. The username before the colon is ignored by the route — only the password (the secret) is matched.

**Idempotency.** Dedup is on `(business_id, source_message_id)` where `source_message_id = headers['Message-ID']`. A second delivery of the same email returns 200 + `{dedup: true}` without inserting.

**Link-following fallback (added May 2026).** Some suppliers — Dulux as of late May 2026 — have switched from PDF-attached invoice emails to "click here to securely download" link-style emails. When the route sees no PDF attachment, it scans the email body for URLs against a host allowlist in `lib/bill-link-follower.ts` (`ALLOWED_HOSTS`), fetches the first match server-side with a 15s timeout, verifies `content-type: application/pdf`, and feeds the bytes into the existing parser pipeline. Adding a new supplier = one line in `ALLOWED_HOSTS`. Only HTTPS, only allowlisted hosts — we never follow arbitrary email-body URLs.

**Dulux secure-link auto-unlock (added June 2026).** Dulux's secure links don't return a PDF to the generic link-follower — they 30x-redirect to a JS gate that asks for the customer's account number. `lib/dulux-secure-fetch.ts` gets past it because the gate is a plain two-request exchange (reverse-engineered live): (1) `GET e.duluxgroup.com.au/t/s/<code>` sets a cookie `drsToken_DULUX_Z5` whose (double-URL-encoded JSON) value contains a `TOKENV2…` token; (2) `GET e.duluxgroup.com.au/securelink-srv/documentV5/<token>/<accountNumber>` returns the invoice PDF (authenticates on the path alone — no cookie needed on step 2). The route tries this *before* the email-body parser when `DULUX_ACCOUNT_NUMBER` is set (Lakeside = 146009, the customer number printed on every invoice — not a secret). Success → the REAL PDF goes through the normal parser, so Dulux bills now arrive **with line items, fully automatic**. Any failure (token expired, account mismatch, gate changed) falls through to the body parser (correct money + job, line-items-pending) — so it can only ever miss line items, never mis-record a bill. Gotchas baked in: the token cookie is set on the *first* redirect hop, and Node's `fetch(redirect:'follow')` hides intermediate Set-Cookie headers, so the resolver follows redirects **manually**, collecting Set-Cookie from every hop. Smoke test: `npx tsx scripts/test-dulux-secure-fetch.ts <shortlink> <account>`.

**Nothing silently disappears (added May 2026).** Previously the route returned 200 + `skipped:true` for emails it couldn't parse (no PDF, image-only scan, parser error). That hid the Dulux switchover for several days. The route now inserts a "failure draft" — a bill entry with `is_draft=true`, no amount, and a `parser_raw.failure` payload — so the email shows up on Home as a "needs attention" row inside the existing Bills-to-confirm flag. Sorted to the top of the flag (action-blocking) with a distinct amber-tinted UI, an "Open original email" / "Log bill manually" CTA, and a delete button.

Failure reasons recorded in `parser_raw.failure.reason`:
- `no-pdf-attachment` — old code path, kept for legacy data; current code goes via link-follower instead.
- `no-allowlisted-url` — link-follower scanned the body and found no allowlisted URLs.
- `wrong-content-type` — followed an allowlisted URL but got HTML / 4xx instead of a PDF (usually means the link is auth-gated and we'd need to log into a portal).
- `fetch-failed`, `timeout`, `too-large`, `empty-response` — network/payload problems with the download.
- `image-only-pdf` — PDF had <20 chars of extractable text. OCR not built.
- `pdf-extract-failed` — pdf-parse threw.
- `parser-error` — `parseBillText` threw.

Human-readable copy for each reason lives in `describeFailureReason()` in `app/(app)/home/page.tsx`. Update both when adding a new reason code.

**Debugging path when no drafts appear:**
1. Check Vercel function logs for `/api/webhooks/inbound-bill` — every call logs either `draft created`, `dedup hit`, `no PDF attachment`, or an error.
2. Check CloudMailin dashboard → message log. If CloudMailin shows 401, the secret in Vercel doesn't match the URL it's POSTing to. If 5xx, the route errored — check Vercel logs.
3. Check Gmail → Settings → Forwarding and POP/IMAP — Gmail occasionally suspends an auto-forward (e.g. if the destination bounces, or if the verification token expired). Confirm the CloudMailin address is still listed and "Forwarding is enabled".
4. Check the Gmail filter itself — Gmail filters silently stop matching when supplier email patterns change (e.g. Resene moves from `accounts@resene.co.nz` to `noreply@…`). Test by searching the inbox for the supplier email and confirming the "Forwarded" label is on it.
5. Query Supabase directly:
   ```sql
   select id, created_at, supplier, amount, source_message_id, is_draft
   from entries
   where business_id = '<TRADEPILOT_BUSINESS_ID>'
     and source_message_id is not null
   order by created_at desc limit 20;
   ```
   This shows everything the webhook has ever ingested.

**Smoke test.** `npx tsx scripts/test-inbound-bill.ts <path/to/bill.pdf>` POSTs a CloudMailin-shaped payload to the dev server (or set `INBOUND_BILL_ENDPOINT` to hit prod). Verifies the dedup path also.

**Resene does NOT use CloudMailin.** Resene's invoice emails are >512KB, over CloudMailin's free-plan per-message cap, so they bounce at the mail provider with `552 Message size exceeds the allowed size for this account` — which produces no Vercel log and no draft, i.e. total silence. Resene is therefore handled by a separate poller: `scripts/apps-script-resene-forwarder.gs`, running at script.google.com on a 30-minute time-driven trigger, which Gmail-searches for Resene mail and POSTs a CloudMailin-shaped payload straight to the same webhook. Processed threads get the Gmail label `TradePilot-sent`; unlabelled threads retry next run, and the Message-ID dedupe makes that safe.

Consequences worth remembering when a Resene bill goes missing:
- **The file in this repo is a copy.** It runs at script.google.com. Editing it here changes nothing until it's pasted back in. Check the Apps Script **Executions** log first — that's the only place its errors surface.
- **It only sees one mailbox** — whichever Google account the script is authorised against. Mail delivered elsewhere is invisible to it regardless of `SEARCH_QUERY`.
- **July 2026 failure, worth not repeating.** `SEARCH_QUERY` was pinned to `from:einvoice@resene.co.nz`. Resene sent an invoice from `accounts@resene.co.nz`; the search didn't match, so nothing was POSTed, nothing logged, no draft raised. Now broadened to `from:resene.co.nz`. Same class of bug as the Gmail-filter drift in step 4 above — **match the domain, never a single mailbox.**
- The same commit stopped the script silently skipping attachment-less mail (it used to skip AND label the thread `TradePilot-sent`, dropping it permanently). Those now get forwarded so the webhook's link-follower / body-parser / failure-draft chain can surface them.
- There is **no health signal** for this poller. If the trigger is deleted or its authorisation lapses, Resene bills stop arriving with no in-app symptom.

**Gotcha — Gmail forwarding verification.** When adding a Gmail forwarding address, Gmail sends a verification code to the destination. CloudMailin doesn't display incoming mail by default; we had to temporarily add `console.log('CLOUDMAILIN_RAW_PAYLOAD:', …)` in the route (commits `c6ffe92` → `80905c1`) to grab the code from Vercel logs. If a new forwarding address is ever added, expect to do the same dance again.

**Gotcha — bills count as expenses only when `paid = true`.** A draft confirmed via Home creates `isDraft = false`, but the bill still doesn't hit money math until it's marked paid (matches Brad's payments-basis GST registration). If a confirmed bill is missing from Money, check `paid`.

**Dulux secure-link bills (June 2026).** Dulux gates its invoice PDFs behind an account-number check, so the link-follower gets HTML, not a PDF. Fix: `lib/dulux-email-parser.ts` parses the bill straight from the email body (invoice number, issue date, amount, PO → job hint) and creates it flagged `parser_raw.lineItemsPending = true` with `duluxSecureLink` stashed. Line items merge in later when the downloaded PDF is dropped on the bill (matched by invoice number — `BillItemsAttacher`, the /entry upload card, or a re-forwarded email all do this; the merge clears `lineItemsPending`).

**Bill detail sheet (June 2026).** Every row in Home's "bills due" flag is tappable → `components/bills/bill-detail-sheet.tsx`: issue date, due date, invoice #, the PO/job reference printed on the bill, GST split, line items (or the "items pending — get the PDF from Dulux" state with the drop-zone), and the job allocation — which is EDITABLE after confirmation via `store.reallocateBill(billId, slices)`. That mutator replaces the whole `bill_group` atomically — GENUINELY atomically since July 2026: the update/delete/insert runs inside the `reallocate_bill()` Postgres function (migration `033_reallocate_bill_fn.sql`, SECURITY INVOKER so RLS still applies), replacing the old three-parallel-statements version whose partial failures could silently lose sibling rows. (Primary entry kept for provenance, siblings deleted/re-inserted, slices must sum to the invoice total ±$0.02, paid/paid_date copied to every slice so re-allocation never moves cost in or out of the books — only between jobs). Split siblings render as ONE row in the bills-due list (grouped by `bill_group_id`), and the Money tab's duplicate detector exempts entries sharing a `bill_group_id`. Mark-paid from the grouped row or the sheet flips every sibling together.

---

## Inbound Tapi lead webhook (Gmail → CloudMailin → Trade Pilot)

The route at `app/api/webhooks/inbound-tapi-lead/route.ts` turns Tapi
"Provide a quote" emails (property managers asking Lakeside to quote a job)
into `lead`-status jobs with `source = 'tapi'`. Same transport as the
inbound-bill pipeline:

```
PM requests a quote in Tapi
  → Tapi emails hi@tapihq.com → info@lakesidepainting.co.nz
  → Gmail filter (from:hi@tapihq.com + subject "Provide a quote") auto-forwards to CloudMailin
  → CloudMailin POSTs the email JSON to /api/webhooks/inbound-tapi-lead
  → route validates, parses subject + plaintext, inserts a lead
  → lead appears in Jobs → Leads next time the app loads
```

**Parsing.** `lib/tapi-lead-parser.ts` — pure + dependency-free (no LLM;
Tapi's format is consistent enough to parse with string ops). Pulls job
type, address (from the subject, incl. suburb), property manager, agency
(the sign-off), the PM's free-text message, and the Tapi deep link.
`isTapiQuoteRequest()` is a precise guard: only genuine "Provide a quote"
emails create leads. "Quote accepted/declined", "New work order", and
"Confirm work" emails are accepted with `{skipped:true}` and create nothing
(so a broad Gmail forward rule can't make junk leads).

**Lead fields.** name = "{job type} — {short address}"; client_name = the
agency (falls back to the PM person, then "Property manager (Tapi)");
location = full address; notes = PM message + who it's from + the
"View on Tapi" link.

**Dedup.** Content-based, no schema change: a Tapi lead with the same
normalised address + job type created in the last 7 days short-circuits with
`{dedup:true}`. Catches CloudMailin retries / double-forwards while still
letting a genuine re-quote of the same property weeks later through. (There's
no `source_message_id` column on `jobs`; if we ever need exact idempotency or
Tapi quote-accepted/declined status-sync, add one mirroring `entries`.)

**Env vars (Vercel AND `.env.local`):**
- `TAPI_LEAD_WEBHOOK_SECRET` — shared secret. Sent as an `x-webhook-secret`
  header OR as basic-auth in the URL (`https://anything:<secret>@host/...`),
  same dual scheme as inbound-bill (free-tier CloudMailin can't set custom
  headers, so the basic-auth form is what's wired up).
- Reuses `TRADEPILOT_BUSINESS_ID`, `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`.

**`source` is a free-form string here.** Stored as `'tapi'` directly; NOT yet
added to the `LeadSource` TS union (the feature was deliberately kept to new
files only so it could ship independently of in-flight leads/home UI work).
Consequence: Tapi leads currently render with no source pill. To add the
pill later: add `'tapi'` to `LeadSource` in `lib/types.ts` and a `tapi` entry
to the two `Record<LeadSource, …>` maps (`components/jobs/job-card.tsx` and
`app/(app)/leads/page.tsx`).

**Scope (v1).** Only quote requests → leads. Work orders and
accepted/declined status-sync were considered and deferred — see the chat
where this was built.

**Smoke test.** `npx tsx scripts/test-inbound-tapi-lead.ts` POSTs
Tapi-shaped payloads at the dev server (or prod via `INBOUND_TAPI_ENDPOINT`)
and asserts create → dedup → new-address → skip-non-quote → bad-secret.

---

## Inbound email lead webhook (Gmail → CloudMailin → Trade Pilot)

The route at `app/api/webhooks/inbound-email-lead/route.ts` turns a
**forwarded customer enquiry** — one that did NOT come via the website
contact form or Tapi — into a `lead`-status job with `source = 'email'`.
Same transport as the inbound-bill / inbound-tapi-lead pipelines:

```
Customer emails Lakeside directly (or Brad gets a referral)
  → Brad forwards the email to the email-lead CloudMailin address
    (or a Gmail filter auto-forwards it)
  → CloudMailin POSTs the email JSON to /api/webhooks/inbound-email-lead
  → route authenticates, LLM-parses the email, inserts a lead
  → lead appears in Jobs → Leads next time the app loads
```

**Parsing is LLM-based — deliberately unlike Tapi.** `lib/email-lead-parser.ts`
calls `claude-haiku-4-5` (via `ANTHROPIC_API_KEY`, same model + retry policy
as the bill parser) with an `emit_lead` tool. Forwarded human emails have no
consistent format and Gmail buries the real enquirer's details inside the
body (the envelope `from` becomes Brad's own inbox), so a regex parser like
Tapi's would be brittle. The model extracts the **customer's** name / email /
phone / address / job type, a one-line `summary` for the job title, and a
cleaned `message`. Fields it can't find are omitted, never guessed.

**Over-capture on purpose.** The parser returns `looksLikeLead`, biased
towards `true`: a missed enquiry is a lost customer (real money), a junk lead
takes two seconds to delete. The route only **skips** (200 + `{skipped:true,
reason:'not-a-lead'}`) when the model is confident it's a newsletter /
receipt / supplier invoice / automated notice / spam — so a Gmail filter or a
stray forward can't spam the Leads tab.

**Never-drop-a-lead fallback.** If the parser THROWS (e.g. Anthropic outage),
the route does NOT 5xx and risk the enquiry vanishing — it inserts a minimal
"needs review" lead carrying the raw subject + a body snippet in `notes`
(`buildFallbackLead`). Mirrors the inbound-bill route's "nothing silently
disappears" principle. A 200 in that case still stops CloudMailin retrying.

**Lead fields.** `name` = `summary` → `{job type} — {short address}` →
`{job type}` → `Email lead — {name}` → `Email lead`. `client_name` = parsed
contact name → display name off the From header → `Email enquiry` (the column
is NOT NULL). `client_email` / `client_phone` = the customer's, validated
(email regex, phone needs ≥6 digits). `location` = the property address.
`notes` = the customer's message + a "Lead contact:" line + the email subject
+ "Forwarded via:" (only when it differs from the captured lead email) + a
low-confidence ⚠ flag when the parse was shaky.

**`source = 'email'`** is a first-class `LeadSource` (already in the union in
`lib/types.ts` and migration `003_lead_source.sql`), so unlike Tapi leads
these render with a proper source pill out of the box — no follow-up UI work
needed.

**Attachments (added July 2026).** The route now saves any photos / plan PDFs
on the forwarded email onto the lead, so a "please quote this" email with
site photos + a drawing set lands fully populated. It reuses the app's own
storage convention rather than inventing a new one: `saveLeadAttachments()`
creates a stub `draft` quote linked to the job (identical to
`store.ensureJobHasQuote`), then uploads each file to the `quote-attachments`
bucket at `{businessId}/{quoteId}/{uuid}__{safeName}` and inserts a
`quote_attachments` row — so the JobDetailSheet's existing "Plans + photos"
panel renders them with **zero UI / schema / type changes**. Kind is inferred
by `inferLeadAttachmentKind` (PDF → `plan`, image → `scope_photo`, keyword
overrides for before/after/progress). Guards: inline signature/logo images
(`disposition: inline` or a `content_id`) are skipped, only image/* + PDF are
kept, ≤12 files, ≤25 MB each. Best-effort and non-throwing — an upload hiccup
can never lose the lead itself (attachments run *after* the job insert). The
response includes `attachments: { saved, skipped }`. Same CloudMailin base64
attachment shape as inbound-bill. No new env vars.

**Dedup.** Content-based, no schema change (jobs has no `source_message_id`):
within the last 7 days, a new email lead is a dupe if it shares a `client_email`
with a recent `source='email'` lead, OR the same normalised `name`+`location`
key. Catches CloudMailin retries / double-forwards; a genuine re-enquiry weeks
later still comes through.

**Env vars (Vercel AND `.env.local`):**
- `EMAIL_LEAD_WEBHOOK_SECRET` — shared secret. `x-webhook-secret` header OR
  basic-auth in the URL (`https://anything:<secret>@host/...`), same dual
  scheme as the other two webhooks (free-tier CloudMailin can't set headers).
- `ANTHROPIC_API_KEY` — the parser needs it (already set for the bill parser).
- Reuses `TRADEPILOT_BUSINESS_ID`, `NEXT_PUBLIC_SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`.

**CloudMailin → webhook URL.** `https://anything:<EMAIL_LEAD_WEBHOOK_SECRET>@<your-vercel-domain>/api/webhooks/inbound-email-lead`.
The username before the colon is ignored — only the password (the secret) is
matched. Use a SEPARATE CloudMailin address from the bill + Tapi ones so each
address maps cleanly to one route.

**Smoke test.** `npx tsx scripts/test-inbound-email-lead.ts` POSTs
forwarded-enquiry payloads at the dev server (or prod via
`INBOUND_EMAIL_ENDPOINT`) and asserts create → dedup → different-lead →
skip-newsletter → bad-secret. Note: parsing is the live model, so the
create/skip assertions depend on its judgement (sample emails are written to
be unambiguous).

---

## Sent-quote sync (Gmail Sent → Apps Script → Trade Pilot)

The route at `app/api/webhooks/inbound-quote-sent/route.ts` turns a quote
email **Brad sent** into the full mark-as-quoted state change, automatically.
Built August 2026 because quotes sent from Gmail left the app blind: the lead
sat in "Leads to contact" / "New enquiries" looking un-actioned and the
follow-up ladder never started.

```
Brad emails a quote (PDF attached) from info@lakesidepainting.co.nz
  → scripts/apps-script-quote-sent-forwarder.gs polls in:sent every 30 min
    (Gmail filters CANNOT act on sent mail — that's why it's a poller,
    same transport as the Resene bill forwarder; no CloudMailin involved)
  → POSTs a CloudMailin-shaped payload to /api/webhooks/inbound-quote-sent
  → route parses the quote PDF (lib/quote-parser.ts, Haiku), matches the
    recipient to an open lead, and replicates MarkAsQuotedSheet server-side:
    quote row (total incl-GST, date_sent, status='sent'), quote PDF attached
    (quote-attachments, kind='quote_pdf'), job → status 'quoted' with
    quote_amount EX-GST, follow_up_date = date sent + 5 days,
    last_contacted_date + a job_contacts row (channel 'quote-sent')
```

**Matching** is tiered, most reliable first: recipient email == `client_email`
→ parsed job address vs location/name (normalised containment) → parsed client
name (normalised exact). Only jobs in status `lead`/`quoted` are candidates —
the route can never regress an accepted/booked job.

**Precision over recall — deliberately the OPPOSITE bias to
inbound-email-lead.** A missed email costs one tap on the "Sent the quote"
button; a false positive silently corrupts pipeline + win-rate data. So: no
status flip without a parsed total or a recipient-email match; auto-create
(no matching lead → new job straight to 'quoted', source='email') only
happens when the parse found a total AND a client/address; anything thinner
is accepted-and-skipped with a logged reason.

**Dedup** is content-based (jobs has no `source_message_id`): a matched job
already 'quoted' at the same total (±$0.02) is a re-send; the create path
checks recent quoted jobs by client email / normalised address. The Apps
Script keeps its own PER-MESSAGE ledger (Script Properties, recorded only
after a confirmed 200) — deliberately NOT a thread label like the Resene
forwarder, because a thread label would permanently mute a thread and
silently miss a revised quote sent later in the same conversation.

**Env (Vercel AND `.env.local`):** `QUOTE_SENT_WEBHOOK_SECRET` (header-only —
the Apps Script can set headers, unlike CloudMailin free tier). Reuses
`ANTHROPIC_API_KEY`, `TRADEPILOT_BUSINESS_ID`, `SUPABASE_SERVICE_ROLE_KEY`.

**The Resene-poller caveats all apply here too:** the `.gs` file in this repo
is a COPY (it runs at script.google.com under info@lakesidepainting.co.nz —
errors surface ONLY in its Executions log); it only sees that account's Sent
folder; and there is no in-app health signal if the trigger dies.

**Eligibility is decided per message IN CODE, not by the Gmail query.** The
first dry run (Aug 2026) proved two Gmail-search traps: (1) search matches
THREADS, so one quote PDF dragged in every "Re:" reply including months-old
messages (`newer_than` applies to thread activity, not each message); and
(2) bare terms match email BODIES — `(quote OR estimate)` pulled in an H&S
email with 8 PDFs because its body said "quote". So the query is just
`in:sent filename:pdf newer_than:7d`, and the real filter is
`isQuotePdfName()` — Brad's quotes are always named "Quote QUO-0XX - …".
Only quote-named PDFs are forwarded, never other files on the same message,
and each message must itself be <7 days old. **If Brad's quote-PDF naming
ever changes, `isQuotePdfName` is the thing to update.**

**Smoke test.** `npx tsx scripts/test-inbound-quote-sent.ts` (dev server
running) asserts create → dedup → optional real-lead match (set
`TEST_LEAD_EMAIL`) → precision-gate skip → bad secret. Creates a real job
named "Exterior repaint — 99 Smoke Test Lane"; decline/delete it afterwards.

---

## Push notifications (shipped August 2026)

Web push to the installed PWA — roadmap item #4, "Tomorrow: McLeod 8am,
Dulux bill due". iOS supports web push for Home-Screen-installed PWAs
(16.4+), which is exactly what's on Brad's phone.

**Architecture.** Three layers, all dependency-free:

- `lib/web-push.ts` — VAPID (RFC 8292) + aes128gcm payload encryption
  (RFC 8291), hand-rolled on node:crypto for the same reason as
  `lib/zip-download.ts` (npm installs in the agent workspace break the
  Mac's esbuild). **Verified byte-for-byte against the RFC 8291
  Appendix A test vector** — `npx tsx scripts/test-web-push-crypto.ts`.
  If that script passes, Apple/Google will accept our messages.
- `lib/push-notify.ts` — `sendBusinessNotification()`: claims
  `(business_id, rule_key, dedupe_key)` in `notification_log` via
  insert-first (idempotent under cron overlap), fans out to every row
  in `push_subscriptions`, prunes dead subscriptions on 404/410.
  **The claim-before-send order is deliberate** — a transient push
  outage can eat one reminder, but nothing can ever double-send.
  Zero subscriptions → bails WITHOUT claiming, so pre-subscribe state
  isn't burned.
- `lib/notification-rules.ts` — pure rule evaluation (no I/O, mirrors
  `lib/payroll.ts`). `npx tsx scripts/test-notification-rules.ts`
  covers every rule against fixture worlds.

**The anti-nag contract** (the most important design rule): a rule
never re-fires the same dedupe key. Escalation is a NEW key per state
(`t1` → `t0` → `late`), each once, ever. Everything self-clears when
Brad does the thing (sends the quote, logs a contact, ticks eiFiled).
Repeat-nagging trains the user to ignore push — then the important
ones die with the noise. Keep this property when adding rules.

**Rules (v1):** quote promises (`jobs.quote_ready_by` — due tomorrow /
today / overdue), uncontacted leads (24h + 3d, skipped when
`quote_ready_by` implies contact or the job is snoozed), quote
follow-ups (`follow_up_date`), EI payday filing + monthly PAYE (reuses
`lib/payroll.ts` date math so push and Home flags can't disagree), GST
(pure date math, odd-month two-monthly cycle with the Mar→7-May and
Nov→15-Jan exceptions — fix `gstDueDateForPeriodEnd` if myIR says the
cycle differs), and a single tagged morning digest (today's schedule +
attention counts; skipped entirely on a nothing-day).

**Delivery paths:**

- Daily: Vercel Cron (`vercel.json`) → `GET /api/cron/notifications`
  at 18:45 UTC ≈ 6:45am NZST / 7:45am NZDT. Hobby-tier cron is
  once-a-day with loose timing, so every rule survives late/missed
  runs (state conditions, not exact-day matches). Auth: Vercel sends
  `Authorization: Bearer <CRON_SECRET>`; `?token=<CRON_SECRET>` works
  for manual testing and the response JSON says what fired/deduped.
  Caps at 6 sends/run so a first-enable backlog isn't a push storm.
- Instant: the three lead webhooks (tapi / email / website-enquiry)
  fire a `lead-arrived` push right after their insert, keyed on the
  job id, via the never-throwing `sendBusinessNotificationSafe` — a
  push failure can't 500 a captured lead.

**Client side.** `public/sw.js` (push + notificationclick ONLY — no
fetch caching on purpose; a stale-cache bug in a money app is worse
than no offline). Settings → Preferences → Notifications is a live
toggle (`components/settings/notifications-row.tsx`): registers the SW,
asks permission inside the tap gesture (Safari requirement), subscribes,
POSTs to `/api/push/subscribe` (bearer-token owner auth, same pattern
as `/api/employees`), and the route pushes a "Notifications are on"
confirmation straight back to that device. Employees don't get push in
v1 — every rule is money/pipeline state they're deliberately blind to.

**Tables** (migration `044_push_notifications.sql`): `push_subscriptions`
(endpoint unique → upsert key; owner-only RLS) and `notification_log`
(the dedupe ledger; owner-read RLS, service-role writes).

**Env vars (Vercel AND `.env.local`):**
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` — public; the browser subscribes with
  it, the sender signs with its pair. Changing it orphans every
  existing subscription (each device must re-toggle) — don't rotate
  casually.
- `VAPID_PRIVATE_KEY` — secret pair of the above.
- `VAPID_SUBJECT` — `mailto:` contact sent to the push services.
- `CRON_SECRET` — Vercel injects it on cron calls; also the manual
  test token.
- Reuses `TRADEPILOT_BUSINESS_ID`, `SUPABASE_SERVICE_ROLE_KEY`.

**iOS gotchas, learned so you don't re-learn:** push only exists for
the INSTALLED PWA (Safari-in-browser has no PushManager — the Settings
row says "Add to Home Screen first" instead of showing a dead toggle);
permission must be requested inside a user gesture; every push must
show a notification (`userVisibleOnly`) or iOS throttles the
subscription; iOS silently evicts subscriptions sometimes — the 404/410
prune + re-toggle handles it.

---

## Brad's tax structure (confirmed April 2026)

This is the source of truth for Brad's tax position. Update this section whenever something changes — every other tax-related decision in the app and in conversations should be consistent with what's written here.

**Entity.** Lakeside Painting Ltd. NZ limited liability company. Sole shareholder + director: Brad Hamilton.

**Not** a look-through company (LTC). Considered, decided regular Ltd is appropriate given consistent profitability and the shareholder-salary mechanism. Revisit only if there's ever a loss-making year, or if the partner becomes a shareholder.

**GST.** Registered. Back-registered to **January 2026** when Brad started operating again. Payments basis (GST owed when cash moves, not when invoice issued). Two-monthly returns — assume standard cycle ending odd months unless he says otherwise.

Pre-registration GST claim under s 21B may be available for assets/inventory bought before January 2026 that are still in use (e.g. tools, vehicle if company-owned). Worth a one-off audit.

**Provisional tax — NOT REQUIRED.** Confirmed via myIR April 2026. 2024/25 residual income tax was $1,155.56 (well under the $5k threshold), so no provisional tax obligation for 2025/26 or 2026/27. Revisit if a future RIT exceeds $5,000.

**Trading history.**
- **2024/25 tax year** — company traded at low volume, $4,127 taxable income, IR4 filed and paid. Small late-payment penalty ($106.26) since cleared.
- **April 2025 → ~December 2025** — Brad went travelling for over a year. Company effectively **dormant**: no income, no expenses, no GST liability for this window.
- **January 2026 → present** — operations restarted. GST back-registered to Jan 2026.

**Tax year.** NZ standard, **1 April → 31 March**. We are currently in tax year **2026/27** (1 April 2026 – 31 March 2027). Previous year **2025/26** (1 April 2025 – 31 March 2026) was *mostly dormant* — only Jan–Mar 2026 contains real activity. **2025/26 IR4 is due 7 July 2026** and should reflect this dormant-then-restarted shape.

**Payroll (EMP) account — now live (July 2026).** Lakeside Painting Ltd is registered as an employer (`136-377-892-EMP004`) and, as of July 2026, is **actually paying PAYE wages** (Suzie — see Partner below). Was previously registered-but-never-used, requiring monthly *nil* returns; from the period she starts being paid, those become **real EI returns with PAYE**. Still **$250 per period default penalty** for a missed filing, so file every period on time. Any nil-return periods before she started being paid (e.g. April + May 2026 if not already filed) still need filing.

**Year-end mechanism.** Brad takes money out by ad-hoc bank transfers from the business account to personal savings (drawings, posted to shareholder current account). At year-end, **most drawings are reclassified as shareholder salary** — the standard one-person-Ltd move. Net effect: company shows ~$0 profit, Brad pays tax at personal rates instead of the 28% company rate. The tax estimator already assumes this approach.

Reconciling bank transfers to savings/tax-savings: **always "Ignore (it's a transfer)"**. They're shareholder current account movements, not P&L events.

**No accountant.** Brad does his own books. **This raises the bar for Claude — be careful, consistent, conservative. If unsure, say so.** The cost of a small mistake is real money out of his pocket with no second pair of eyes to catch it.

**Partner.** Suzie — Brad's girlfriend (pregnant, due late 2026). Helps on jobs — masking, sanding, prep, light admin.

**Now on payroll (confirmed July 2026).** Suzie is being paid PAYE wages through Lakeside Painting Ltd. This is the income-splitting move that was previously flagged as the biggest tax-saving opportunity — it's now in place, shifting income from Brad's marginal rate to her lower brackets (est. **$2,000–3,000/year** saved). Consequences that flow from this and should stay consistent everywhere:
- The EMP account (`136-377-892-EMP004`) is **live and in use** now, not dormant — see the payroll note above.
- Real PAYE returns replace nil returns from the period she started being paid; keep filing on time to avoid the $250/period penalty.
- Her wages are a **deductible expense** to the company (s DA 1) and reduce company profit before the year-end shareholder-salary reclassification.
- **Rate + hours (confirmed July 2026):** target **~25 hrs/week at $35/hr** = **$875/week gross** (~**$45,500/yr** at a full 52 weeks; less in practice given parental leave late 2026). $35/hr is a defensible market rate for skilled prep/masking/sanding + admin — keep timesheets so the hours are evidenced if IRD ever asks.
- **Working from 15 July 2026:** from this date, on-site work sessions include Suzie. She logs her own hours from her employee login (/my/hours) — that's what payroll pays from. (The old `helperHours` capture on Brad's entries was removed July 2026; legacy values still count in historical job stats.) Treat 15 July as the start of her tracked working hours; confirm whether it also aligns with her first PAYE pay period.

**Employee accounts (planned, July 2026).** Brad wants to give Suzie (and future employees) their own login to log their own hours against jobs, with a **money-blind** view. The current app is single-user (RLS scoped to `owner_id = auth.uid()`, login hardcoded to Brad); this is the main architectural lift. The `workerKind`/`helperHours` data model is the foundation — an employee's hours are just `hours` entries with their own `workerKind`.

Decisions (confirmed July 2026):
- **One app, role-gated** — NOT a separate build. Suzie logs into the same app; her role hides money pages/buttons in the UI *and* money tables at the database (RLS), so money-blindness is enforced server-side, not just visually.
- **Employee (v1) can:** log their own hours to jobs; see their upcoming schedule; see job details *minus money* (client, address, scope — never quote/invoice/income/tax); add a note + photo per shift.
- **Job access:** any active job (no per-job assignment step for Brad).
- **Roles:** `owner` (Brad — full app) and `employee` (Suzie). Needs a `business_members` table (business_id, user_id, role, display_name, worker_kind) + RLS rewritten from `owner_id = auth.uid()` to membership-based. Money-blindness for the `jobs` table (which has money columns) needs employee-facing **views** that omit money columns, since Postgres column privileges can't distinguish two app users on the same `authenticated` role.
- Adding Suzie's auth user: originally a Supabase dashboard step, but Phase 4 will build an **in-app owner-only "Add employee"** screen (server route + service-role key) so Brad never touches the dashboard.

**Build progress (July 2026):**
- **Phase 1 shipped** — migration `025_business_members.sql`: `business_members` table (business_id, user_id, role, display_name, worker_kind) + own RLS, Brad backfilled as `owner`. Store now resolves `role` + `membership` (defaults to `owner` if no row, so single-user is unchanged).
- **Phase 2 shipped** — migration `026_employee_access.sql`: money-blindness. KEY INSIGHT — the existing `owner_id = auth.uid()` policies already deny employees everything, so Brad's policies were left untouched; the migration only ADDS narrow employee grants. Employees get: read own business row; read `jobs_public` (money-free view — no estimated_value/quote_amount/invoice_amount; base `jobs` stays owner-only); insert/read/edit/delete ONLY their own `hours` entries (new `entries.logged_by_user_id` column, must equal auth.uid()); read the business's `job_booking` schedule rows. Helper fn `public.current_user_business_ids()`.
- **Phase 3 shipped** — employee UI (app code only, no SQL). Role-gated nav (`bottom-nav`/`desktop-sidebar` show only Hours + Schedule for employees), `RoleGuard` keeps employees inside `/my/*`, store loads jobs from `jobs_public` when role=employee, new `store.logMyHours()` mutator (attaches `loggedByUserId` + `workerKind` from membership), pages `app/(app)/my/hours` (log-hours: any active job → hours + activity + note, shows job notes as money-free scope) and `app/(app)/my/schedule`.
- **Phase 4 shipped** — in-app Add Employee. Server route `app/api/employees/route.ts` (POST create, DELETE revoke): verifies the caller is the business OWNER via `businesses.owner_id`, then uses the service-role admin client to `auth.admin.createUser` (email pre-confirmed) + insert a `business_members` employee row. Always creates role=`employee` (can't mint an owner). DELETE removes the membership only (revokes access; doesn't delete the auth user — would trip the `entries.logged_by_user_id` FK). UI: owner-only `app/(app)/settings/team` page (team list + add form with generated temp password + worker-kind picker) linked from Settings → Team. No SQL/migration for this phase — reuses `business_members`. Needs `SUPABASE_SERVICE_ROLE_KEY` (already set for webhooks). To onboard Suzie: Settings → Team → Add employee (helper).
- **Phase 5 shipped (July 2026) — job/booking assignment.** Migration `035_assignments.sql`: `job_assignments` (job-level "who's on this job") + `schedule_assignments` (per-BOOKING override — any rows on a booking mean *exactly those people*; no rows = inherit the job team). Employee visibility is now STRICT (Brad's choice): `jobs_public`, the schedule read policy, and the hours INSERT policy all require assignment via SECURITY DEFINER helpers `user_assigned_to_job()` / `user_assigned_to_booking()` (definer needed because policy subqueries run under the caller's RLS, which hides other people's override rows). Un-assigning never strands already-logged hours (read/update/delete of own hours unchanged). Existing employees were backfilled onto all accepted/booked/in-progress jobs so Suzie's view didn't change on migration day. UI: `JobTeamPanel` chips on JobDetailSheet (owner-only, hidden with no employees), "Who's on it" picker in EditScheduleItemSheet (re-applies the override after the delete+recreate range flow; `setBookingAssignees` retries on FK 23503 because the optimistic booking insert may not have landed), crew names on schedule RunCards, and /my/hours now offers all assigned workable jobs (RLS does the filtering). Store: `jobAssignments`/`scheduleAssignments` + `setJobAssignees`/`setBookingAssignees` (diff-based, optimistic + rollback). Gotcha: assign the job team BEFORE booking dates if you want zero extra taps — bookings inherit job-level assignment by default.
- **Job cover photos (July 2026).** Migration `036_job_cover_photo.sql` adds `jobs.cover_photo_path` + re-creates `jobs_public` with it. Resolution rule lives in `lib/job-cover.ts`: explicit `coverPhotoPath` wins, else the newest shift photo on the job — so most jobs get a thumbnail with zero effort, and Brad pins one via the star on any photo in ShiftPhotosPanel. **The path always points into the `shift-photos` bucket, never `quote-attachments`** — that bucket is owner-only and full of priced quote PDFs, so `store.setJobCoverPhoto` DOWNLOADS + RE-UPLOADS a quote-attachment image into shift-photos rather than referencing it. Employees can therefore sign a URL for the cover and nothing else; no new storage policy was needed (027's member-read policy already covers it). Thumbnails render in the employee Log Hours picker + hero, the employee calendar (day sheet + list), and the owner's Jobs list cards (`JobCard` takes a `coverUrl` prop; the page batch-signs the filtered list via `useSignedCovers`). Thumbnails are decoration — signing failures are swallowed, never surfaced.
- **Scope for the crew (July 2026).** Migration `037_job_scope_for_staff.sql` adds `jobs.scope_included` / `scope_excluded` (text[], both in `jobs_public` → **employee-visible**) plus `cover_photo_source` (the original path a cover was pinned from, so the owner's UI can star the right thumbnail when the image was copied out of `quote-attachments`). `lib/scope-extractor.ts` + `POST /api/parse-scope` pull "what's included / what's NOT" out of the quote PDF (Haiku + `emit_scope` tool, same retry policy as the bill/quote parsers; client extracts the PDF text via the existing `extractPdfText`). **Three layers stop pricing leaking to staff**: the system prompt forbids money outright, `stripMoney()` drops any surviving line that matches a currency pattern (whole line, not a redaction), and nothing saves until Brad has reviewed it in the editor — `JobScopePanel` is extract → review → save, never extract → save. The exclusions half is the point: it stops a painter doing unpaid extras. Rendered read-only to employees on /my/hours (job hero) and /my/schedule (day sheet + list) via the shared `ScopeLists`.
- **Multi-activity hours (July 2026).** /my/hours activity pills are multi-select. One activity behaves exactly as before (single entry, no extra taps); **two or more show a per-activity hours box, prefilled with an even split (rounded to 0.25h, last row absorbing the remainder) and save as one entry PER activity**. That's deliberate — attributing a whole day to whichever activity was tapped first would quietly corrupt the hours-by-activity chart and the blended-rate math. Save is blocked while the parts don't sum to the stated total (±0.01 float slop).
- **Off-site activities + backdating (July 2026).** Migration `038_offsite_activities.sql` widens the `entries_activity_check` constraint with `website` / `marketing` / `training` (joining the existing `quoting` / `admin`) and **relaxes the employee hours insert policy to permit `job_id is null`** — off-site work belongs to no job, following the app's existing overhead convention. Employees can't still log against a job they're NOT assigned to; that rule from 035 is intact. `OFFSITE_ACTIVITIES` + `isOffsiteActivity()` live in `lib/types.ts`; /my/hours groups the pills into on-site vs Off site, makes the job optional when the selection is off-site-only, and **forces `jobId: undefined` for off-site rows even if a job is selected** so admin time can never land on a customer's job costs. A date input (capped at today) sits under the Today/Yesterday chips for catching up on an older week. Payroll picks all of this up unchanged — `lib/payroll.ts` sums by `logged_by_user_id` regardless of job, so off-site hours are paid like any other. **Three places must stay in sync when adding an activity:** `ActivityType` (types.ts), `ACTIVITY_TYPES` (mock-data.ts, drives Brad's own entry form), `ACTIVITY_LABEL` (job-charts.tsx), plus the DB constraint.
- Caveat baked in: job `notes` ARE visible to employees (scope lives there) — don't put pricing in job notes.

**Payroll tracking in-app (added July 2026).** The `pay_runs` table (migration `032_pay_runs.sql`) + `lib/payroll.ts` + the Home "Payroll" section (`components/payroll/payroll-flags.tsx`) track Suzie's fortnightly wages end-to-end:
- **Pending periods are computed, not stored** — `lib/payroll.ts` derives fortnights from a cycle anchor (default 2026-07-13, the Monday covering her 15 July start; overridable via settings keys `payroll_anchor`, `payroll_cycle_days`, `payroll_wage_rate` default $35/hr). A `pay_runs` row is created only when Brad marks a period paid.
- **Gross = logged hours × rate**, pre-filled from the hours SHE logged herself (`logged_by_user_id` entries via /my/hours). The old "+ helper hrs" field on Brad's entries was REMOVED from the entry form (July 2026) — employees log their own time, full stop. Legacy `helperHours` on old entries are still picked up (flagged "old helper hrs — check for double-ups" in the pay card) so a period spanning the switchover doesn't drop time; job-stats' blended-rate math also still honours them. Don't write `helperHours` on new entries. Hours + rate are snapshotted on the pay run as the IRD "pay matches timesheets" evidence.
- **Marking paid auto-creates a linked wages expense entry** (`store.addPayRun`, mirrors `markInvoicePaid`'s insert-first/rollback pattern): category 'labour', `gstApplies=false` (wages are outside the GST net), gross ex-GST on the pay date. So wages flow into Money/profit/tax-estimator with zero changes there. The PAYE remittance is NOT a second expense — it reconciles as a bank txn `status='tax', taxKind='paye'` (already supported).
- **IRD follow-up flags, self-clearing**: "File payday info in myIR" per pay run (due 2 working days after payday; `eiFiled` flag) and "Pay PAYE to IRD by the 20th" per month (small-employer schedule — PAYE for pay days in month M due the 20th of M+1; appears from ~the 6th of the due month, red when overdue; `payePaid` flag, shows the summed recorded PAYE or "check myIR" when not recorded).
- **RLS: owner-only** on `pay_runs` — employees never see pay data (consistent with money-blindness). The store now also loads ALL `business_members` rows as `teamMembers` (owner sees all via existing RLS; employees only their own row).
- Optional per-run `paye`/`net` fields exist for record-keeping — Brad still computes deductions with the IRD calculator (deliberately NOT built in-app).

**Vehicle.** Currently uncertain whether registered to Brad personally or to the company. If personal: mileage method only (IRD rate $1.17/km tier 1, $0.37/km after 14,000 km). If company-owned: full running costs deductible + depreciation, but FBT on private use unless logbook used to apportion. **Brad to check rego paperwork.**

**Home office + shed.** Both at Brad's residence. Currently estimated as 5m² office partial-use + 7m² shed 100% biz, ≈ 7% of household running costs ($1,820/yr). Reasonable for now; revisit if he moves or his work-from-home pattern changes.

**Other entities.** None known. No trust, no separate property entity, no LTC.

---

## Tax assumptions (hardcoded for now)

Brad-specific defaults in `lib/tax-estimator.ts`:

```
vehicleKmAnnual:           $5,350   (~6,000 biz km × $1.17/km, capped at actual cost incl dep)
homeAndShedAnnual:         $1,820   (7% of $26k household — 5m² office partial use + 7m² shed 100% biz)
phoneInternetUpliftAnnual: $1,253   ($180/mo × ~58% effective uplift over what's already in $26k bundle)
laptopDepreciationAnnual:  $1,600   ($4k FV × 50% IRD rate × 80% biz)
```

NZ personal tax bands 2025/26 are encoded in `PERSONAL_TAX_BANDS`. Income tax is estimated at personal rates (post shareholder-salary reclassification) rather than the 28% company rate.

Bills count as expenses only when `paid = true` (matches Brad's payments-basis GST registration).

These defaults need to move to a Settings UI / per-business table when we want to onboard other users — they're the single biggest reason this app isn't yet shippable to a stranger.

---

## Project status (April 2026)

**Working well:** entry, jobs (with charts + invoices), money (with timeframe + basis toggle + tax card), schedule, settings, invoice create/edit, mark invoice paid, bank CSV reconcile (BNZ format), per-job desktop layout.

**Recent UX polish:**
- Smart job picker (`lib/job-match.ts`) — tier-based (active-match → active → recent → older) with fuzzy match against bank txn context. Used in entry-form, schedule add-form, and reconcile flow. "Older" hidden by default when active jobs exist.
- Overhead button next to job dropdown in entry-form and reconcile (stores `[OH]` description prefix, jobId stays null).
- Bank classifier handles BNZ tran_type='FT' as transfer (avoids tax-savings transfers polluting expenses).
- Job detail sheet capped at `max-w-2xl` on desktop; hourly-rate gauge SVG capped at `max-w-[360px]` so it doesn't blow up on wide viewports.
- Date picker in entry-form for backdating hours/expenses.
- **Download all photos (July 2026)** — the JobDetailSheet's "Documents & photos" panel has a `Download {n}` button that pulls every *image* attachment on the job down as one `.zip`, foldered by kind (Before / After / Progress / Scope). Gets phone-uploaded site photos onto the laptop without tapping each thumbnail. Entirely client-side: batched `createSignedUrls` (the same call the thumbnail grid makes, so RLS applies via Brad's own session), a 4-way concurrent fetch pool, then `lib/zip-download.ts` assembles the archive in the browser. Plans and quote/invoice PDFs are deliberately excluded. Partial failures still save a zip and report the shortfall on screen.
  - `lib/zip-download.ts` is a hand-rolled **stored (uncompressed)** ZIP writer — no dependency. Deliberate: photos are already JPEG-compressed so deflate buys ~1%, and `npm install` inside the agent workspace breaks the Mac's esbuild binary (see gotchas). No ZIP64, so it throws a friendly error past 4 GB. Verified against `unzip -t` with md5 byte-equality, duplicate names, unicode names, and 0/1-byte files.

**Brad-specific data quirks:** the Aubrey Road and McLeod Ave jobs needed manual SQL fixes for GST issues. J20 (Troy Nicholson ceiling) was added via a SQL block — that's the canonical "log a new accepted job + deposit invoice + schedule items" pattern until #1 below ships.

**Known limitations:**
- No "unmark paid" flow (delete income entry + flip flag).
- No invoice delete from the UI (only in Supabase Table Editor).
- Bank reconcile exists but not yet exercised on a real CSV (task #38).
- No proper drawings tracker; year-end shareholder salary reclassification is hand-wavy.
- Tax estimator deductions are hardcoded; no Settings UI to edit them per-business.
- `app/settings/` is an empty directory left from a move — harmless, gitignore won't catch it.
- Most pages render full-width on desktop without a max-width container (only the JobDetailSheet has been polished). Jobs list, Money tab, Schedule, Settings still stretch.

**Next features (queued, in build order):**
1. **"This week" home screen at `/`** — single dashboard with today's schedule, hours-vs-target, this-week's profit, overdue invoices, quick-add buttons. Pure read, no schema changes. NEXT.
2. **Quote → invoice → schedule one-tap flow** — when a job moves to `accepted`, prompt to issue deposit invoice + schedule start date in one sheet. Mostly UI plumbing on top of existing pieces.
3. **Photo-attached entries** — Supabase Storage bucket + `entries.photo_url` column + camera input on entry-form. Big workflow win for on-site logging.
4. **Push notifications** — SHIPPED August 2026, see the "Push notifications" section above.
5. **Lead tracking** (after the above): pull from painterswanaka.co.nz contact form, paste-an-email parser, "haven't replied" notifications. Reuses #4's notification infra (the "haven't replied" part shipped with it — `lead-uncontacted` rule).
6. **Settings UI for tax estimator deductions** + onboarding questionnaire — required before commercialising.

---

## When in doubt

- 5:30pm tired painter on a phone. Always.
- ex-GST for math. Always.
- Through the store, not directly to Supabase. Always.
- If you change something the user can see, screenshot or describe it after typechecking. Don't claim done without proof.
- This is Brad's actual business. Bugs cost real money. Don't ship sloppy.
- When SQL is needed, print it into the chat. Don't tell the user to `cat` files — workspace permissions don't carry to the Mac.
