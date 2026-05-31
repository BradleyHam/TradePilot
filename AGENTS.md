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
- Suggest legitimate income-shifting where his partner does paid work (see "Brad's tax structure" below — biggest free win available right now).
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
- `/(app)/jobs` — list view with chip filters (All, In progress, Coming up, Completed, Leads, Quoted, Booked, Invoiced, Paid). "Coming up" = lead+quoted+accepted+booked; mutually exclusive with "In progress". Tap a job → bottom sheet with sticky status header, financials grid, hourly-rate gauge, budget bar, hours-by-activity, **invoices list**, activity log.
- `/(app)/money` — KPI grid, **timeframe filter** (This month / Last month / Other), **Cash/Earned basis toggle**, **tax exposure card** (with current/previous tax year toggle), revenue/expense charts, pipeline-by-stage breakdown, transaction list with duplicate detection.
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
- `INBOUND_BILL_WEBHOOK_SECRET` — shared secret. CloudMailin must send it as `x-webhook-secret` header OR embed it in the URL as basic-auth (`https://anything:<secret>@host/...`). Free-tier CloudMailin can't set custom headers, so the basic-auth form is what's currently wired up.
- `TRADEPILOT_BUSINESS_ID` — which business the drafts land against.
- `SUPABASE_SERVICE_ROLE_KEY` — used for the insert (bypasses RLS, since there's no auth.uid() on an inbound webhook).
- `ANTHROPIC_API_KEY` — used by `parseBillText` to extract supplier/amount/GST.

**CloudMailin → webhook URL.** Format is `https://anything:<INBOUND_BILL_WEBHOOK_SECRET>@<your-vercel-domain>/api/webhooks/inbound-bill`. The username before the colon is ignored by the route — only the password (the secret) is matched.

**Idempotency.** Dedup is on `(business_id, source_message_id)` where `source_message_id = headers['Message-ID']`. A second delivery of the same email returns 200 + `{dedup: true}` without inserting.

**Link-following fallback (added May 2026).** Some suppliers — Dulux as of late May 2026 — have switched from PDF-attached invoice emails to "click here to securely download" link-style emails. When the route sees no PDF attachment, it scans the email body for URLs against a host allowlist in `lib/bill-link-follower.ts` (`ALLOWED_HOSTS`), fetches the first match server-side with a 15s timeout, verifies `content-type: application/pdf`, and feeds the bytes into the existing parser pipeline. Adding a new supplier = one line in `ALLOWED_HOSTS`. Only HTTPS, only allowlisted hosts — we never follow arbitrary email-body URLs.

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

**Gotcha — Gmail forwarding verification.** When adding a Gmail forwarding address, Gmail sends a verification code to the destination. CloudMailin doesn't display incoming mail by default; we had to temporarily add `console.log('CLOUDMAILIN_RAW_PAYLOAD:', …)` in the route (commits `c6ffe92` → `80905c1`) to grab the code from Vercel logs. If a new forwarding address is ever added, expect to do the same dance again.

**Gotcha — bills count as expenses only when `paid = true`.** A draft confirmed via Home creates `isDraft = false`, but the bill still doesn't hit money math until it's marked paid (matches Brad's payments-basis GST registration). If a confirmed bill is missing from Money, check `paid`.

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

**Payroll (EMP) account — registered, never used.** Lakeside Painting Ltd is registered as an employer (`136-377-892-EMP004`), but no-one has ever been paid PAYE wages. Monthly nil returns must be filed for every period the EMP is open, or IRD assesses **$250 per period default penalty**. **Keep the EMP open** — it's the channel for putting Brad's partner on payroll later. File nil EI returns for outstanding periods (currently April + May 2026 visible).

**Year-end mechanism.** Brad takes money out by ad-hoc bank transfers from the business account to personal savings (drawings, posted to shareholder current account). At year-end, **most drawings are reclassified as shareholder salary** — the standard one-person-Ltd move. Net effect: company shows ~$0 profit, Brad pays tax at personal rates instead of the 28% company rate. The tax estimator already assumes this approach.

Reconciling bank transfers to savings/tax-savings: **always "Ignore (it's a transfer)"**. They're shareholder current account movements, not P&L events.

**No accountant.** Brad does his own books. **This raises the bar for Claude — be careful, consistent, conservative. If unsure, say so.** The cost of a small mistake is real money out of his pocket with no second pair of eyes to catch it.

**Partner.** Brad's girlfriend (pregnant, due late 2026). Helps **informally** — masking, sanding, prep, light admin. Currently **not on payroll, not invoicing as a contractor, not paid for her time**. The internal $25–30/hr rate currently mentioned is a costing assumption only, not an actual money movement.

**This is the single biggest tax-saving move Brad isn't yet taking.** Putting her on payroll (or contracting with IR330C) at a market rate for the hours she actually works would shift income from his marginal rate to her lower brackets, saving an estimated **$2,000–3,000/year**. Setup needed: payroll registration OR contractor agreement, timesheets, market-rate hourly. *Claude should bring this up periodically until it's set up.*

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
4. **Push notifications** — "Tomorrow: McLeod 8am, Dulux bill due." Requires VAPID + service worker + scheduled job. Heaviest lift.
5. **Lead tracking** (after the above): pull from painterswanaka.co.nz contact form, paste-an-email parser, "haven't replied" notifications. Reuses #4's notification infra.
6. **Settings UI for tax estimator deductions** + onboarding questionnaire — required before commercialising.

---

## When in doubt

- 5:30pm tired painter on a phone. Always.
- ex-GST for math. Always.
- Through the store, not directly to Supabase. Always.
- If you change something the user can see, screenshot or describe it after typechecking. Don't claim done without proof.
- This is Brad's actual business. Bugs cost real money. Don't ship sloppy.
- When SQL is needed, print it into the chat. Don't tell the user to `cat` files — workspace permissions don't carry to the Mac.
