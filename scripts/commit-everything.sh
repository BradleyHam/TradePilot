#!/usr/bin/env bash
# One-shot script to commit all the uncommitted Trade Pilot work in a few
# logical commits. Run from the TradePilot/ directory:
#
#   cd ~/Desktop/lakeside-painting/TradePilot
#   bash scripts/commit-everything.sh
#
# Safe to re-run — it will just say "nothing to commit" the second time.

set -euo pipefail

# Make sure we're in the project root (the dir with package.json + .git/)
if [[ ! -f package.json ]] || [[ ! -d .git ]]; then
  echo "❌ Run this from the TradePilot project root."
  exit 1
fi

# Ensure git user is set so commits don't fail
if ! git config user.email > /dev/null 2>&1; then
  echo "Setting up git user for this repo…"
  git config user.name  "Brad Hamilton"
  git config user.email "bradleyjamesham@gmail.com"
fi

# 1. Documentation (CLAUDE.md, AGENTS.md, README, .gitignore, .env.local.example)
git add CLAUDE.md AGENTS.md README.md .gitignore .env.local.example 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "docs: project context (AGENTS.md, README, env example)

- Replace Next.js boilerplate README with a real one
- Expand AGENTS.md into full project context: golden rule,
  stack, schema, gotchas, status snapshot, mutator contract
- Add .env.local.example so a fresh dev knows what to set up
- Gitignore service-account credentials and imported data dumps"
fi

# 2. Supabase schema + seed
git add supabase/ 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "feat(db): Supabase schema and seed

- Seven tables: businesses, jobs, entries, schedule_items,
  materials, quotes, settings
- RLS policies scoped to auth.uid() = owner_id
- GST columns on entries, bills, quotes
- Seed creates one business + GST settings for the auth user"
fi

# 3. Core lib (store, types, mappers, job-stats, tax-estimator, nl-parser, utils, mock-data)
git add lib/ 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "feat(lib): store, types, mappers, job stats, tax estimator

- Single React store (lib/store.tsx) with optimistic mutators,
  Supabase write-behind, rollback on failure
- Bidirectional snake_case ↔ camelCase mappers
- lib/job-stats.ts as single source of truth for per-job
  financials, always ex-GST
- lib/tax-estimator.ts for live NZ GST + income tax estimate
- Regex-based natural-language parser (no LLM)"
fi

# 4. Components
git add components/ components.json 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "feat(ui): all app components

- Job list card, job detail sheet (sticky header, status
  selector, financials, charts, activity)
- Per-job charts: hourly rate gauge, budget bar, hours by
  activity (raw SVG, no chart lib)
- Money tab: KPI tiles, tax exposure card, revenue/expense
  charts, transaction list with duplicate detection
- Entry: NL parser preview + quick form
- shadcn-style ui primitives"
fi

# 5. Pages
git add app/ 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "feat(app): pages, auth gate, layout

- /(app)/ route group requires sign-in; layout.tsx is the gate
- /login public, password sign-in via Supabase Auth
- Pages: entry, jobs, money, schedule, settings"
fi

# 6. Scripts
git add scripts/ 2>/dev/null || true
if ! git diff --cached --quiet; then
  git commit -m "feat(scripts): finance importer + sheets helpers

- scripts/import-finances.ts loads JSON dumps into Supabase.
  Idempotent via legacy_id upsert + --reset flag.
  Handles M/D/YYYY, D/M/YYYY, ISO, 2-digit years, money
  with \$ and commas, status mapping
- scripts/export_sandbox_to_json.py dumps every worksheet
  from a Google Sheets workbook to JSON
- scripts/sheets_manager_sandbox.py CLI for the sandbox sheet"
fi

# 7. Anything left (package.json/lock changes, etc)
git add -A
if ! git diff --cached --quiet; then
  git commit -m "chore: package + lockfile updates

Tooling deps for the importer (tsx, dotenv) and other
incremental package.json updates."
fi

echo ""
echo "✓ All committed. Recent history:"
git log --oneline -10
