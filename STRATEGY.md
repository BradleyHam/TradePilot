# Trade Pilot — Strategy & Roadmap

This file captures the **commercial strategy** and **roadmap** for Trade Pilot. `AGENTS.md` covers the technical context — read that for stack, schema, conventions. Read **this** file to understand *why* we're building things and *which branch* they belong in.

Last updated: May 2026.

---

## The vision

Trade Pilot is **the digital hub for a one-person trades business** — a co-pilot that handles money, time, pipeline, jobs, materials, and intelligence in one place. The dream is the same software running thousands of small NZ painting / building / sparky / plumbing businesses, replacing the fragmented mess of Xero + Tradify + Google Sheets + WhatsApp + a folder on the desktop that's been on every working tradie's laptop since 2010.

The differentiator isn't features (most are commodity). It's that the data **compounds** — every job logged makes future quoting smarter, every receipt logged tightens the margin picture, every won/lost outcome trains the pricing assistant. After a year on the app, the system knows the business better than the owner does.

**Positioning**: not accounting software, not job-management software. A *co-pilot* for sole-trader tradies. Active, not passive. Helps decide, doesn't just record.

**First customer profile**: NZ sole-trader painters with 1-2 person crews, $80k–$300k annual revenue, who currently juggle 4-6 different apps + spreadsheets. Brad Hamilton (Lakeside Painting) is customer zero.

---

## The two-branch strategy

This is the structural decision driving everything below: we run two branches with different goals.

### `main` — the product

The version we sell. Generalised, clean, polished, marketable. **Anything that ships to `main` must pass the test:** *"Could I demo this to a Christchurch painter who's never heard of Brad, without explanation?"* If yes, it belongs on main. If no, it doesn't.

This branch optimises for:
- Cleanliness and reliability — paying users punish bugs harder than free ones.
- Generalisability — no hard-coded Lakeside-specific anything.
- Onboarding — a new painter should be productive within an hour, no hand-holding.
- Pricing-tier coherence (Solo / Pro / Business — see below).

### `lakeside` — the dream version

Brad's personal maxed-out version, running Lakeside Painting's actual operations. Integrated with the Painters Wanaka website. Tied to Brad's specific suppliers, his URL structure, his branding, his workflow. This branch is **the R&D lab**. Features that prove themselves here get *ported back* into `main` (cleanly, generalised) when they're ready.

This branch optimises for:
- Brad's actual day-to-day — anything that saves him minutes wins.
- Experimentation — try the wild ideas here first, where breakage costs nothing.
- Website integration — booked-until banner, recent jobs feed, customer portal, pricing page sync.
- One-off automation specific to Brad's setup (Resene supplier quirks, Wanaka client patterns).

### The discipline

This only works if we hold the line:

1. **Before merging anything to `main`**: ask "could a stranger use this without configuration?" If no, it stays on `lakeside`.
2. **Big bets are built on `main`, gated behind tiers**. The AI quoting assistant, the customer portal, the review-request system — these are too valuable to silo on Brad's branch. Build them in `main` behind a Pro flag, use them in production via Brad's own Pro subscription.
3. **Small bets and personal one-offs stay on `lakeside`**. Lakeside-specific Resene integration, the exact `painterswanaka.co.nz` URL routes, custom analytics for Brad's accountant — these never need to be in `main`.
4. **Pull from `main` to `lakeside` weekly**. Keep `lakeside` close to `main` so the merge debt doesn't compound.
5. **Never pull `lakeside` → `main`**. Features get *re-implemented* cleanly on `main`, not merged across. Avoids polluting the product with Lakeside-isms.

### Decision rule for new features

> *"Could I demo this feature to a Christchurch painter who's never heard of me, without explanation?"*
>
> - **Yes** → `main` (and decide tier: Solo / Pro / Business)
> - **No, but the *generalised* version could be demoed** → build generalised version on `main`, behind tier flag if Pro/Business
> - **No, and there's no generalised version** → `lakeside`

---

## Pricing model

Three tiers. Prices are working assumptions, not committed.

**Solo — $49/month NZD**
The core app — jobs, quotes, invoices, hours, materials, pipeline, bill ingestion, tax estimator, basic intelligence. Everything Brad has used to run Lakeside Painting for the past year.

**Pro — $99–$129/month NZD**
Solo, plus:
- AI quoting assistant (pricing predictions from historical data)
- Linked website integration (booked-until banner, recent jobs feed, pricing page sync)
- Customer portal (clients view + approve quotes, see project schedule, see invoices)
- Automated review-request flow (text after paid job)
- SMS reminders to clients
- Lead capture from website → app

**Business — $199–$249/month NZD** (future tier)
Pro, plus:
- Multi-user (2-3 person crews)
- Basic team scheduling
- Role-based views
- Crew member time-logging

### Pricing notes

- Charge from day one. No free tier beyond 14-day trial.
- Annual deal: $499 Solo / $999 Pro. Tradies hate monthly bills; annual converts.
- Early users get grandfathered when prices rise — good faith, and they'll feel rewarded for being early.
- Mates' rates is a trap — charge mates full price, they'll respect the product more.

---

## Three-month sequencing (May → Aug 2026)

### Month 1 — Polish + dual-track setup
Make `main` sellable. Make `lakeside` real.

**On `main`:**
- Polish home dashboard rough edges
- Quote PDF output quality (does it look professional enough to send a real client?)
- Error handling pass — every catch block should surface clearly
- Site-visit-to-schedule quick win (half-day feature)
- Onboarding flow — first-time user shouldn't see a blank app

**On `lakeside`:**
- Branch off `main` and set up
- "Booked until X" banner that syncs to painterswanaka.co.nz
- Recent jobs feed that auto-publishes when a job is marked complete + publishable

### Month 2 — AI quoting assistant (Pro tier)
The differentiated feature. Lives on `main`, gated behind Pro flag, used in production by Brad.

The killer demo: *"You've done 12 similar weatherboard jobs at this prep level. You averaged $58/m². You won 7 of the 12. The 5 you lost were priced above $62/m². Suggested range: $55-60/m²."*

This is the feature that sells the app to other painters. Build it once, build it right.

### Month 3 — First three paying users
Hand `main` to three painter mates. Free for a month, then $49/month. Watch them use it. Listen carefully. Don't add features they didn't ask for.

**On `lakeside`:** customer portal v1 (clients view + approve quotes online).

After this, planning is data-driven, not vibes-driven.

---

## Highest-leverage next steps

A running list of "if I only had a week, what would I do?" — kept ordered by leverage.

### On `main` (the product)

1. **Quote PDF output polish.** A painter will not send a quote that looks amateurish. The quote PDF is the most-shared artefact of the app. It has to look like a $5k document. Currently functional but plain. ROI: every painter who sees a clean quote PDF is closer to buying.
2. **Onboarding flow.** A new user shouldn't see a blank home screen. Walk them through: connect bank (optional), add first job, add first quote, log first hours. ROI: drops first-week churn from "I didn't get it" — the #1 reason SaaS dies.
3. **AI quoting assistant.** The differentiated feature. The demo that closes painters. See Month 2 above.
4. **Customer portal (Pro tier).** Quote + approval + schedule + invoices, shareable link. Tradies who can offer this look 10× more professional than ones who can't. This is the feature that makes a painter say "I'd pay $99/mo just for this."
5. **Review-request automation.** Auto-text the client 3 days after paid invoice asking for a Google review. Painters obsess over reviews; this is a single-purpose, high-ROI feature.

### On `lakeside` (the dream version)

1. **Booked-until banner.** Pulls from the schedule, displays on painterswanaka.co.nz homepage as "Booked until July 2026." Pressure on enquirers to book early. ROI: marketing automation Brad currently does manually (and forgets).
2. **Recent jobs feed → website.** Tick "publishable" on a completed job in the app, it appears on the site within minutes. Brad's site currently shows 6 portfolio projects; this turns it into a living showcase. ROI: SEO + social proof, zero ongoing work.
3. **Pricing page sync.** Site says "average exterior repaint in Wanaka: $X,XXX" based on actual app data, refreshed weekly. Makes the site feel current and grounded. ROI: differentiation vs every other painter site that lies/guesses about pricing.
4. **Lead capture form on site → app.** Enquiry on painterswanaka.co.nz creates a lead in the app, pre-populated. ROI: removes a manual copy-paste step.
5. **Customer portal pilot.** Build a rough version for Brad's own clients before generalising to `main`. Test with 5 real clients, learn what they actually need.

---

## What we're explicitly NOT building (yet)

Saying no to things is as important as saying yes. These have come up and been deferred:

- **Generic CRM features** (contacts, follow-up tasks, email templates). The pipeline + job history *is* the CRM. Adding more is a black hole.
- **Marketing automation** (email campaigns, social schedulers, lead magnets). Painters don't want marketing software; they want jobs. The review-request system is the one exception.
- **Team/crew features**. Until 50+ Solo users, multi-user complexity isn't worth the build cost. Business tier is a year+ away.
- **Mobile native app**. The PWA is fine. Native is a 3-month detour we can't afford right now.
- **Open API / integrations marketplace**. Zero customers have asked. Build when one does.
- **Multi-trade verticals** (sparkies, plumbers, builders). Pick painters, win painters, then expand. Premature horizontal expansion kills focus.

---

## Selling — the human side

Brad is the founder + customer zero + first salesperson. He's not a natural salesperson but he's:
- A working painter (huge credibility advantage vs Tradify reps)
- Embedded in the NZ trades community
- Authentic, not slick — which works *for* trades, not against

The selling playbook for the first 20 users:

1. **Start with painter mates.** 5 wins under his belt before tackling harder conversations.
2. **The 10-second pitch:** *"I built an app for my painting business — quoting, jobs, hours, money, all in one place. Want me to show you?"*
3. **Let the product talk.** Show real data on a real phone. Yesterday's hours. This week's earnings. The quote about to be sent.
4. **Confident pricing.** Say "$49/month" flat. No apologising, no caveats.
5. **The reframe:** he's not asking for $49. He's offering 3-4 hours/week of admin saved + better pricing + business clarity. At painter hourly rates, that's $200+ of value. He's *under*charging.
6. **One short video.** Phone camera, on a job site, in work clothes, showing the daily flow. Post to NZ trades Facebook groups + TikTok + Instagram. Authenticity beats production value 10:1 in this market.

---

## Open questions / things to revisit

- **When does Brad reduce painting hours to work on this?** Probably at $5k MRR (100 users-ish). Doing both at zero revenue is the right move; doing both at $5k MRR is leaving money on the table.
- **Who is customer two?** Brad's mate Tim? Someone from the NZ Master Painters network? First-customer-after-Brad shapes the next year of product decisions.
- **Plug into Xero?** Eventually probably yes — most tradies still need Xero for statutory accounting. But integration is months of work and zero customers have asked yet. Defer.
- **What's the right pricing test?** When Brad goes to charge first user, does he start at $49 or $79? Cheaper = more conversions but harder to raise later. Erring toward $49 for the first 5 then raising.
- **What does the `lakeside` → `main` port look like in practice?** First time we do it (probably the booked-until-banner generalised) will set the template. Take notes.

---

## How to use this file

**For Brad**: living document. Edit as direction changes. Don't let it go stale.

**For future Claude conversations**: read this file early in any session that touches strategy, roadmap, prioritisation, or the question "should this go in `main` or `lakeside`?" When uncertain about a feature's home, apply the decision rule above.

**For an outside reader (later co-founder, investor, advisor)**: this is the strategic context. `AGENTS.md` is the technical context. Together they're the operating manual.
