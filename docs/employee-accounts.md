# Employee accounts

How Trade Pilot lets Brad (owner) give staff their own logins to record hours,
while keeping every dollar figure invisible to them. Built July 2026.

## Why this exists

Suzie (and future hires) need to log the hours they work against jobs — both so
Brad isn't re-keying their time and so there's a timesheet trail behind her PAYE
wages. But an employee must never see quotes, invoices, income, tax, or job
pricing. So the app went from single-user (only Brad) to role-aware multi-user
with a hard money wall.

## The one principle

**Employees are money-blind because the *database* refuses to serve them money —
not because a button is hidden.** The UI gating is just polish on top of
row-level security (RLS). Even if an employee typed `/money` into the URL or hit
the API directly, they get nothing back.

## Roles

Stored in `business_members` (one row per person per business):

- `owner` — Brad. Full app. Can add/remove employees. Backfilled from
  `businesses.owner_id`.
- `employee` — e.g. Suzie. Can log her own hours to any active job, see her
  schedule, and see job details *minus money*. Nothing financial.

The signed-in user's role is resolved in the store on load (`role` + `membership`
in `lib/store.tsx`). If no membership row is found it defaults to `owner`, so the
original single-user setup is unchanged.

## How money-blindness is enforced (the important part)

Every original table policy is `business_id in (select id from businesses where
owner_id = auth.uid())` — i.e. "only the owner". An employee has a different
`auth.uid()` and isn't the `owner_id`, so **those policies already deny employees
everything**. We never touched them. Migration 026 only *adds* four narrow
employee grants:

1. **Read their own business row** — so the app can load (`businesses` select
   policy for members).
2. **Read jobs via `jobs_public`** — a view that omits the money columns
   (`estimated_value`, `quote_amount`, `invoice_amount`). Base `jobs` stays
   owner-only, so a direct `select * from jobs` returns an employee nothing. The
   view is SECURITY DEFINER with its own membership `WHERE` clause as the guard.
   ⚠️ Job `notes` **are** included (scope lives there) — don't put pricing in job
   notes.
3. **Touch only their own `hours` entries** — insert/read/edit/delete where
   `type = 'hours'` AND `logged_by_user_id = auth.uid()`. They can't read an
   expense/income/bill, can't see anyone else's hours, and can't attribute an
   entry to someone else.
4. **Read the business's `job_booking` schedule rows** — read-only, so Suzie sees
   where she's booked. Money-bearing `bill_due`/`invoice_due` rows are excluded.

Helper function `public.current_user_business_ids()` (SECURITY DEFINER) returns
the caller's own business ids and is used inside the employee policies without
tripping recursion.

## What an employee sees (UI)

- Nav is reduced to **Log hours** + **Schedule** (`bottom-nav` / `desktop-sidebar`
  branch on `role`). No money pages, no Settings.
- `RoleGuard` (`components/nav/role-guard.tsx`) keeps an employee's browser inside
  `/my/*`, redirecting any other route to `/my/hours`.
- `/my/hours` — pick the day, pick any active job, tap an hours chip (2/4/6/8) or
  type exact, optionally pick an activity + note, one big Save. Shows the job's
  notes as money-free scope and a running "today's hours" list. Reuses the normal
  hours pipeline, so logging still auto-advances the job to `in-progress` and
  clears the schedule's "overdue" for that day.
- `/my/schedule` — upcoming job bookings with address + times.

Every logged hour is stamped with `logged_by_user_id` (their uid) and
`workerKind` from their membership (Suzie = `helper`) — that's the payroll
timesheet evidence.

## Adding / removing employees (in-app)

Owner-only **Settings → Team** (`app/(app)/settings/team`). Backed by server route
`app/api/employees/route.ts`:

- **POST** — verifies the caller is the owner (`businesses.owner_id`), then uses
  the service-role admin client to create the login (`auth.admin.createUser`,
  email pre-confirmed) and insert the `employee` membership. Always
  role=`employee` — it cannot create an owner. Returns the credentials to hand
  over.
- **DELETE** — removes the membership row only (revokes access instantly). It
  deliberately does **not** delete the auth user, because
  `entries.logged_by_user_id` references `auth.users(id)` and deleting a user who
  logged hours would trip that FK. Without a membership they can sign in but see
  nothing.

The service-role key (`SUPABASE_SERVICE_ROLE_KEY`) is only ever used server-side.

### To onboard Suzie

Settings → Team → Add employee → name + email, role **Helper**, Create login →
hand her the email + generated password. She logs in at the same web address and
lands on her Log Hours screen.

## Files & database objects

Code:
- `lib/types.ts` — `MemberRole`, `BusinessMember`, `Entry.loggedByUserId`
- `lib/supabase/mappers.ts` — `rowToBusinessMember`, `logged_by_user_id` mapping
- `lib/store.tsx` — `role`/`membership` state, role-aware jobs load
  (`jobs_public` for employees), `logMyHours()` mutator
- `components/nav/{bottom-nav,desktop-sidebar,role-guard}.tsx`
- `app/(app)/my/hours/page.tsx`, `app/(app)/my/schedule/page.tsx`
- `app/(app)/settings/team/page.tsx`, `app/api/employees/route.ts`

Database (migrations):
- `025_business_members.sql` — `business_members` table + RLS + owner backfill
- `026_employee_access.sql` — `entries.logged_by_user_id`,
  `current_user_business_ids()`, businesses member-read policy, `jobs_public`
  view, employee entries + schedule policies

## Testing without a second person

Flip yourself to employee in the SQL editor, reload, look around, flip back:

```sql
update business_members set role = 'employee' where display_name = 'Brad';
-- reload, browse /my/hours and /my/schedule (you'll be money-blind — that's the proof)
update business_members set role = 'owner' where display_name = 'Brad';
```

## Known gaps / future

- No employee self-service password change yet (Brad sets a temp one).
- Employees see *all* active jobs (no per-job assignment) — by design for v1.
- No richer money-free job-detail sheet (scope shows as job notes for now).
- Removing an employee leaves an inert auth login; add `ON DELETE SET NULL` to
  `entries.logged_by_user_id` if you ever want true user deletion.
- Surfacing Suzie's labour cost in the Money tab (owner view) is not built yet.
