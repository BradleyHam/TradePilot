# Trade Pilot

A job, finance, pipeline and tax tracker for small NZ trade businesses. Built phone-first for a tired tradie at 5:30pm.

Currently set up for one user — Brad Hamilton, [Lakeside Painting](https://lakesidepainting.co.nz). Generalising it for other tradies is on the roadmap; for now it's tightly coupled to NZ tax rules and a single business.

## What it does

- **Log expenses, income, hours, bills, enquiries, quotes** in plain English or via quick form. Phone-friendly.
- **Track jobs end-to-end** — lead → quoted → accepted → in-progress → invoiced → paid.
- **Per-job financial picture** with hourly-rate gauge, budget bar, and time-by-activity charts. All ex-GST so the numbers are real.
- **Live tax estimate** — GST owed and income tax exposure for the current NZ tax year (1 Apr → 31 Mar), with auto-applied deductions (vehicle, home office, phone, internet, depreciation).
- **Transaction history** with duplicate detection so you can spot mistakes before the accountant does.
- **Real data** imported from a duplicate of the user's Google Sheets "Finances" workbook.

## Stack

- [Next.js 16](https://nextjs.org) / React 19 / App Router
- TypeScript, strict mode
- [Tailwind v4](https://tailwindcss.com) + shadcn-style components
- [Supabase](https://supabase.com) (Postgres + Auth + Row-Level Security)
- [recharts](https://recharts.org) for charts, [lucide-react](https://lucide.dev) for icons

## Getting started

You need a Supabase project and a working Mac dev environment (or Linux/WSL).

### 1. Install

```bash
npm install
```

### 2. Configure environment

Copy `.env.local.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ…   # from Supabase → Settings → API Keys
SUPABASE_SERVICE_ROLE_KEY=sb_secret_…  # only needed if running the importer
```

### 3. Set up the database

In the Supabase SQL editor, run in this order:

1. `supabase/schema.sql` — creates the seven tables, RLS policies, indexes, triggers.
2. Create your auth user: Supabase dashboard → Authentication → Users → Add user → email + password (tick auto-confirm).
3. `supabase/seed.sql` — creates a `businesses` row owned by your user and seeds GST settings. Edit the email in the seed if you used a different one.

### 4. (Optional) Import existing data

Trade Pilot ships with an importer that reads JSON dumps from a Google Sheets "Finances" workbook (the format the original user, Lakeside Painting, used).

If you have similar sheets data:

```bash
# 1. Share your Google Sheets workbook with the service account
#    listed in scripts/service-worker.json (client_email field).

# 2. Run the Python exporter to dump every worksheet to JSON:
python3 scripts/export_sandbox_to_json.py

# 3. Run a dry-run import to see what would happen:
npm run import

# 4. Apply for real:
npm run import:reset   # truncate jobs/entries/materials/quotes first
# or
npm run import:apply   # layer onto existing data
```

If you don't have legacy data, skip this — Trade Pilot works fine empty.

### 5. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with the credentials you created in step 3.

## Project structure

```
app/
  (app)/                  Authenticated app pages — auth gate in layout.tsx
    entry/                Quick log via NL or form
    jobs/                 Job list + detail sheet
    money/                KPIs, charts, tax exposure card, transaction list
    schedule/             Bookings, follow-ups, bill due dates
    settings/             GST, sign out
  login/                  Public sign-in page
components/
  jobs/                   Job-list card, detail sheet, charts, status badge
  money/                  KPI tiles, charts, tax exposure card, transaction list
  entry/                  NL parser preview, entry form
  shared/                 Page header, empty state
  ui/                     shadcn primitives (button, card, sheet, select, etc)
lib/
  store.tsx               Single React store. Reads Supabase, optimistic mutators.
  job-stats.ts            Single source of truth for per-job financials. Always ex-GST.
  tax-estimator.ts        NZ tax year math + GST + deduction defaults.
  nl-parser.ts            Regex NL parser (no LLM).
  supabase/
    client.ts             Browser-side Supabase client (anon key, RLS-aware).
    admin.ts              Service-role client for scripts. Never imported by components.
    mappers.ts            snake_case ↔ camelCase translation. Single point of truth.
  types.ts                All shared TS types.
  mock-data.ts            Form constants only (categories, activities, statuses).
  utils.ts                cn() helper.
scripts/
  import-finances.ts      Sheets-JSON → Supabase importer.
  export_sandbox_to_json.py   Google Sheets → JSON dumper.
  sheets_manager_sandbox.py   Helper script for the sandbox spreadsheet.
supabase/
  schema.sql              Tables, RLS, indexes, triggers.
  seed.sql                Single-business + GST settings bootstrap.
data/
  import/                 JSON dumps from the exporter (gitignored).
```

## Website enquiry webhook

`POST /api/webhooks/website-enquiry` accepts inbound contact-form submissions from painterswanaka.co.nz and creates a `lead`-status job.

Requires two extra env vars:

```
WEBSITE_WEBHOOK_SECRET=<openssl rand -hex 32>
TRADEPILOT_BUSINESS_ID=<uuid of the business in Supabase>
```

Body:

```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "021 555 1234",
  "message": "Looking for a quote on exterior repaint",
  "pageUrl": "/contact",
  "source": "website"
}
```

Headers: `x-webhook-secret: <WEBSITE_WEBHOOK_SECRET>`, `Content-Type: application/json`.

Either `email` or `phone` is required (not both). Same email + same message within 5 minutes is deduped to defend against double-submits.

## Available scripts

```bash
npm run dev            # Next.js dev server
npm run build          # production build
npm run lint           # eslint
npm run import         # dry-run import — prints what would happen
npm run import:apply   # apply the import to Supabase
npm run import:reset   # truncate jobs/entries/materials/quotes then import
```

## Design rules

The full design philosophy lives in [AGENTS.md](./AGENTS.md). The single most important rule:

> **Can a tired painter use this easily at 5:30pm, on a phone, after a 6-hour day on site?**

If a UI change doesn't pass that filter, it doesn't ship.

## License

Private project. Not yet open source. Don't redistribute.
