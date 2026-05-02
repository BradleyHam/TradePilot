# Prompt for next chat — build the "this week" home screen

Paste this into a fresh chat. Everything Brad and any agent needs is in
`AGENTS.md`; this prompt only adds task-specific direction.

---

## Prompt to paste

> Hi Claude. I'm continuing work on TradePilot — my job/finance/tax tracker
> for Lakeside Painting Ltd. Read `AGENTS.md` first for full context (golden
> rule, stack, schema, gotchas, current status, queued features). The
> previous chat got long so we're starting fresh.
>
> **Today's job: build the "this week" home screen** (queued feature #1 in
> AGENTS.md → "Project status" → "Next features").
>
> ### What I want
>
> A new home tab at `/` that I open at 7am on a job site to answer one
> question: *"What am I doing today, and how am I tracking?"* Right now I
> have to bounce between Schedule, Jobs, and Money to piece that together.
>
> ### Tiles, in priority order
>
> 1. **Today** — schedule items for today, with a one-tap "done" toggle.
>    Plus any *overdue* schedule items from earlier in the week (red).
>    Empty state: "Nothing scheduled today" + small "Add" button.
>
> 2. **This week so far** — three numbers:
>    - Hours logged this week (Mon–today). Target: ~30h (5 days × 6h).
>      Show as a small bar or progress ring.
>    - Income received this week (ex-GST).
>    - Profit this week (income − expenses, ex-GST).
>
> 3. **Money flags** — surfaces stuff that needs action:
>    - Overdue invoices (count + total $, ex-GST). Tap → jump to Money tab
>      filtered to overdue.
>    - Bills due in next 7 days (count + total $).
>
> 4. **Coming up** — next 7 days of schedule items, grouped by day, compact
>    rows. Tap → Schedule tab.
>
> 5. **Quick add** — three buttons that drop me into the entry form
>    pre-typed for the most common log actions:
>    - Log hours
>    - Log expense
>    - Log income
>
> ### Constraints (read AGENTS.md golden rule first)
>
> - Phone-first. ~380px viewport. Big tap targets.
> - On desktop: cap content to `max-w-2xl` centred (matches the polish I
>   just did on JobDetailSheet — see commit history / current code).
> - Pure reads. No new schema, no new mutators. Pull everything from the
>   store: `useStore()` gives you `jobs`, `entries`, `scheduleItems`,
>   `invoices`, `bankTransactions`.
> - Hide gracefully when there's no data (don't render empty stat blocks).
> - Use existing helpers: `lib/job-stats.ts`, `lib/income-allocator.ts`
>   (`earnedIncomeInWindow` / `cashIncomeInWindow`), `lib/tax-estimator.ts`.
>   Use `date-fns` for week boundaries (`startOfWeek` with `weekStartsOn: 1`
>   for NZ Mon-start).
> - All money math is **ex-GST**. Read `entries.amount_ex_gst` not
>   `entries.amount` for expense/income totals.
>
> ### Routing & nav
>
> - Currently `app/page.tsx` redirects `/` → `/entry`.
> - Make a new route at `app/(app)/home/page.tsx`. Update the redirect in
>   `app/page.tsx` to point at `/home`.
> - Update `components/nav/bottom-nav.tsx`. We currently have 4 nav items;
>   I think the cleanest is **5 items** with Home leftmost, since the bar
>   already comfortably fits on a phone (check the spacing). Home icon:
>   `Home` from lucide-react. Order: Home, Entry, Jobs, Money, Schedule.
> - Update `components/nav/desktop-sidebar.tsx` similarly.
>
> ### Quality bar
>
> - TypeScript strict — no implicit any, no `as any` shortcuts.
> - Run `npx tsc --noEmit` before claiming done.
> - Don't break existing pages. The `/` redirect change should be the only
>   non-additive thing.
> - Use the existing component primitives in `components/ui/*` and
>   `components/shared/*` rather than inventing new ones.
>
> ### Open questions to ask me before starting
>
> - Should the bottom nav grow to 5 items, or should Home replace one
>   (probably Entry, since I can quick-add from Home)?
> - What time window do "overdue invoices" use — anything past the invoice
>   due date that's still unpaid? Or a stricter rule?
> - For the hours-this-week bar, should the target adjust based on which
>   day it currently is (e.g. 6h on Tue = on-track, 6h on Fri = behind)?
>
> Once you've read AGENTS.md and the answers above, propose the file list
> you'll touch and a sketch of the component tree before writing code.

---

## Notes for me (Brad)

- Bring up the screenshot of the Powder Room Wallpaper desktop bug if
  Claude needs a layout reference.
- The two pending things from this chat that *aren't* the home screen:
  - Task #28: log April invoices via the new UI (do anytime, not blocked).
  - Task #38: try the BNZ CSV import. Worth doing before the home screen
    if you want to surface "unreconciled bank txns" as a flag tile.
