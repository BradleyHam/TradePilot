<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Trade Pilot — agent context

Trade Pilot is a job, finance, pipeline and tax tracker for small NZ trade businesses. The first user is **Brad Hamilton, Lakeside Painting Ltd** (Wanaka), a one-person painting company with occasional help from his partner. Brad's tax position and workflow shape every decision in here.

If you're a new agent picking this up, read this whole file before writing code. The most-violated rule is the golden rule below — protect it.

---

## The golden rule

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

---

## Stack

- **Next.js 16 / React 19** — note: NOT the Next.js most LLMs know. Read `node_modules/next/dist/docs/` before writing routes, layouts, or middleware.
- **TypeScript strict mode**, no implicit any.
- **Tailwind v4** + shadcn-style components (`components/ui/*`).
- **Supabase** (Postgres + Auth + RLS). Browser client at `lib/supabase/client.ts`, admin client at `lib/supabase/admin.ts`.
- **lucide-react** icons. **recharts** for the few "real" charts; raw SVG for the gauges.
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

## What's built

This is a working app, not a prototype. As of the last conversation:

**Pages**
- `/login` — public, password sign-in. No sign-up flow.
- `/(app)/entry` — natural-language + form entry. NL parser at `lib/nl-parser.ts` is regex-based, no LLM.
- `/(app)/jobs` — list view with filters (All, Completed, Active, In progress, Leads, Quoted, Booked, Invoiced, Paid). Tap a job → bottom sheet with sticky header (status selector + name) + financials + 3 charts + activity list.
- `/(app)/money` — KPI grid, **tax exposure card** (the big one — see below), revenue/expense charts, pipeline-by-stage breakdown, transaction list with duplicate detection.
- `/(app)/schedule` — booked work, follow-ups, bill due dates.
- `/(app)/settings` — sign out, GST settings, business info.

**Data layer**
- `lib/store.tsx` is the single store. Reads everything from Supabase on mount + on auth change. Mutators (`addJob`, `updateJob`, `addEntry`, `addScheduleItem`, `updateScheduleItem`) do **optimistic updates** with Supabase write-behind and rollback on failure. **Don't bypass the store** — never call Supabase directly from components.
- `lib/supabase/mappers.ts` — bidirectional row↔domain mapping (`snake_case` ↔ `camelCase`). All column-name knowledge lives here. Don't sprinkle column names elsewhere.
- `lib/job-stats.ts` — single source of truth for per-job financials. **Always returns ex-GST numbers.** Used by both the JobCard list and the JobDetailSheet so they can't disagree.
- `lib/tax-estimator.ts` — live GST + income tax estimate for the current NZ tax year. Pro-rates annual deductions (vehicle km, home+shed, phone+internet, laptop dep) to elapsed days. Constants live here for now; once Layer 2 ships, they'll move to a `settings` table.

**Schema**
Seven tables (see `supabase/schema.sql`):
- `businesses` — one row per business, RLS-scoped to `owner_id = auth.uid()`.
- `jobs` — has `legacy_id` (J1/J2/...) so imported records keep their sheet IDs.
- `entries` — expenses, income, hours, enquiries, quotes, bills, notes. GST-aware (`gst_applies`, `amount_ex_gst`, `gst_component`). Bill-only fields: `paid`, `paid_date`, `payment_ref`, `company`.
- `schedule_items` — calendar-shaped reminders/bookings.
- `materials` — proper materials log (brand/colour/finish/qty/unit/cost) mirroring the Finances sheet's "Materials & Paint" tab.
- `quotes` — first-class quote records, separate from quote-type entries. Has `legacy_id`, `legacy_enquiry_id`, links to `jobs` once won.
- `settings` — keyed `(business_id, key)` for `gst_mode`, `gst_rate`, etc.

RLS is on for all tables — every policy is "you can manage rows for businesses where `owner_id = auth.uid()`". This bites scripts that aren't using the service-role key.

---

## Data model conventions

- **`snake_case` in Supabase, `camelCase` in TypeScript.** Translation lives in `lib/supabase/mappers.ts`. Don't sprinkle column names elsewhere.
- **All money is gross in `amount`** with `gst_applies`, `amount_ex_gst`, `gst_component` tracked separately. Don't add a fourth way to represent money.
- **All financial *math* is ex-GST.** GST is pass-through to the IRD; it's not money Brad keeps. Mixing gross income with ex-GST expenses produces wildly wrong "profit" and "$ per hour" numbers — see `lib/job-stats.ts` for the canonical pattern (`entryExGst()` helper).
- **Jobs from the legacy Finances sheet keep their `J1`/`J2`/... ids** in `jobs.legacy_id`. UUIDs are the primary key.
- **"OH" job ids in the importer map to `null` job_id**, not a sentinel row.
- **NZ tax year = 1 April → 31 March.** `lib/tax-estimator.ts` has helpers (`taxYearOf`, `daysIntoTaxYear`).

---

## Auth

- Single-user sandbox right now. No sign-up flow on purpose.
- The auth gate lives in `app/(app)/layout.tsx`. Anything under `(app)/` requires sign-in. `app/login/page.tsx` is the only public page.
- Adding new pages: put them under `app/(app)/<name>/page.tsx` so they inherit the gate.
- Adding a new user: do it in the Supabase dashboard. Then update `supabase/seed.sql` to point at the new email and re-run.

---

## Gotchas we've already hit (don't repeat them)

### Stale-prop trap
A common pattern: a list page passes a `Job` (or `Entry`, `ScheduleItem`) into a detail sheet via prop. **That prop is a snapshot at click-time.** Mutating the store doesn't change it. Fix: in the detail component, look up the live record from `useStore()` by id rather than reading the prop directly. See `JobDetailSheet`'s `liveJob` for the pattern.

### Sticky positioning inside Sheet
shadcn `SheetContent` is a flex-col with `overflow-y-auto`. `position: sticky` on a child behaves unpredictably. Solution: structure the sheet as `overflow-hidden` outer + non-shrinking header + `flex-1 overflow-y-auto` body. See `JobDetailSheet`.

### Cascade deletes nuke imported data
`businesses.owner_id` references `auth.users(id) ON DELETE CASCADE`, and `jobs/entries/materials/quotes` cascade off `businesses(id)`. So if you delete-and-recreate the auth user (e.g. when setting a password), every imported row gets nuked. The importer is idempotent (`npm run import:reset`) so re-running fixes it, but be aware. Long-term fix: change FK to `ON DELETE SET NULL`.

### Cross-platform `node_modules`
If you ever run `npm install` inside the agent's Linux workspace, you'll get the wrong-platform esbuild binary and the Mac dev server will refuse to start. Symptom: `You installed esbuild for another platform`. Fix: `rm -rf node_modules package-lock.json && npm install` on the Mac.

### Bills double-counted
If you log a bill AND a separate expense entry when paying it, expenses double-count. The convention is: **bills become expenses by being marked `paid = true`**, not by adding a second entry. `lib/job-stats.ts` already deduplicates correctly (counts bills + expenses but not both for the same logical thing).

### Two-digit years in imported dates
The importer (`scripts/import-finances.ts`) handles `02/11/26` style dates. Year < 70 → 20YY, else 19YY. The regex picks 4-digit years before 2-digit ones (`(\d{4}|\d{2})(?!\d)`), otherwise `2026` parses as `20`. Don't break this.

### Quote amounts: GST treatment is inconsistent in legacy data
Most jobs imported from the Finances sheet store `quote_amount` ex-GST. Some are incl-GST. There's no per-job way to tell from the data alone. `lib/job-stats.ts` treats them as ex-GST (consistent with the rest of the math), so jobs with incl-GST quotes will show inflated expected profit. Fix is a manual audit using the SQL query in the conversation history (compare `quote_amount` vs the linked `quotes` row's `total_amount_incl_gst`). Tracked but not yet done.

---

## Project status snapshot

### Done
1. **Phase 1** — Sandbox sheets manager + JSON exporter (`scripts/export_sandbox_to_json.py`, `scripts/sheets_manager_sandbox.py`).
2. **Phase 2** — Schema patched for GST + materials + quotes + settings; importer wired up; real Lakeside data loaded into Supabase.
3. **Phase 3** — Store wired to Supabase with optimistic mutators; auth (password + gate); store loads everything for the signed-in user's business.
4. **Per-job visualisations** — Hourly rate gauge, Job Budget bar, Hours-by-Activity bars. All hide on no-data jobs.
5. **Transaction history** — On Money tab, last 30 days, grouped by date, type filters, duplicate-detection heuristic.
6. **Bills count toward job expenses; expected profit** uses quote/invoice amount when no income received yet.
7. **Tax exposure card** (Layer 1 of the tax tracker) — live GST + income tax estimate for the current NZ tax year on the Money tab.

### In flight / next up
1. **Layer 2 — Deduction tracker UI.** Settings UI to make the four hardcoded deductions in `lib/tax-estimator.ts` user-editable. Plus an asset register for proper depreciation tracking (van, laptop, sprayers >$1k).
2. **Layer 3 — GST return view.** Picks the right window based on filing frequency, lists transactions, exports the GST101 figures.
3. **Layer 4 — Provisional tax calculator.** Three-instalments-a-year math.
4. **Layer 5 — Drawings tracker / shareholder current account.** Brad's a one-person Ltd; this is the year-end reclassification lever.

### Backlog / known issues
- **Quote-amount GST audit** (see "Gotchas" above). Worth one quiet evening.
- **Money page still uses its own filter logic** for monthly P&L (doesn't include bills as expenses). Per-job math is correct via `lib/job-stats.ts` but the Money tab's monthly stats undercount expenses. Refactor to share `tax-estimator.ts`'s logic.
- **Schedule page is empty** — we never imported schedule items because the Finances sheet doesn't have an equivalent tab. Adding through the UI persists fine; just no historical data.
- **No delete mutator** for jobs/entries/schedule items in the UI. Use Supabase Table editor for now.
- **Ltd company nuance**: the income-tax part of `tax-estimator.ts` assumes drawings are reclassified as shareholder salary at year-end (the standard accountant move for a one-person Ltd). If Brad's situation changes, the math changes.
- **Empty `app/settings/` directory** sitting on disk; the page moved to `app/(app)/settings/`. Cosmetic. `rmdir` on a Mac fixes it.

---

## Mutators contract

Every mutator (`addX`, `updateX`) in `lib/store.tsx`:
1. Updates local React state immediately.
2. Fires the Supabase write in the background.
3. On failure: logs, sets `error` on the store, rolls back the local state.
4. For inserts: replaces the temporary client-id with the real Supabase UUID once the row comes back.

**Don't call Supabase directly from a component.** Always go through the store. If you need a new mutator, add it there.

---

## Importer

- Lives at `scripts/import-finances.ts`.
- Reads JSON dumps from `data/import/` (slug-named files per worksheet).
- The Python exporter that produces those dumps is `scripts/export_sandbox_to_json.py` (Google Sheets → JSON, requires `service-worker.json` credentials and the sheet shared with the service account email).
- `npm run import` is dry-run by default. `--apply` writes. `--reset` truncates first.
- Date parsing: handles M/D/YYYY, D/M/YYYY (when first part > 12), YYYY-MM-DD, with 2-digit year support.
- Status mapping: `New → lead`, `Accepted → accepted`, `In progress → in-progress`, `Completed → completed`.
- Money amounts: parses `$1,004.35`, takes absolute value (negatives in the sheet just mean "expense" which is encoded by row type).

---

## Tax assumptions baked into `lib/tax-estimator.ts`

Brad-specific defaults, hardcoded for now (move to settings table in Layer 2):

```
vehicleKmAnnual:           $5,350   (~6,000 biz km × $1.17/km, capped at actual cost incl dep)
homeAndShedAnnual:         $1,820   (7% of $26k household — 5m² office partial use + 7m² shed 100% biz)
phoneInternetUpliftAnnual: $1,253   ($180/mo × ~58% effective uplift over what's already in $26k bundle)
laptopDepreciationAnnual:  $1,600   ($4k FV × 50% IRD rate × 80% biz)
```

NZ personal tax bands 2025/26 are encoded in `PERSONAL_TAX_BANDS`. Bills count as expenses only when `paid = true` (matches NZ payments-basis GST registration).

---

## When in doubt

- 5:30pm tired painter on a phone. Always.
- ex-GST for math. Always.
- Through the store, not directly to Supabase. Always.
- If you change something the user can see, screenshot or describe it after typechecking. Don't claim done without proof.
- This is Brad's actual business. Bugs cost real money. Don't ship sloppy.
