# TradePilot — product one-pager (working draft)

**Status:** draft — written 5 May 2026, before any customer interviews. Treat every claim with `[?]` next to it as something we believe but haven't verified. The point of this doc is to make those assumptions visible so you know what to validate.

---

## Buyer

The person who pays for this looks like Brad Hamilton a year ago. Specifically:

- **Trade:** painter, builder, plasterer, tiler, landscaper, electrician, plumber. Hands-on, on-site most days. NZ-based.
- **Business shape:** sole-trader Ltd company, owner-operator, $80k–$300k annual revenue. Maybe 1–2 occasional helpers (partner, mate, casual labour) but not a payroll'd team. **[?]**
- **Books today:** spreadsheets + bank app, or Xero they barely log into. Bookkeeping done after dinner or Sunday morning, hates it. No accountant, or one they only see at year-end. **[?]**
- **Phone-first:** quotes from the ute, photos site-by-site, banking on their phone, very rarely opens a laptop except to email a PDF. **[?]**
- **What they say out loud:** "I never know what I'm actually making per hour." "I forgot to invoice X for three weeks." "GST returns make me want to cry." "I just want to paint and have the money side sort itself."

**Not the buyer:** any business with a bookkeeper, any company on payroll with 3+ staff, any tradie who's already bought into Tradify/ServiceM8 and likes it. We can sell to them later but not first.

---

## One-sentence pitch

> *TradePilot is a phone-first finance tool for solo NZ tradies that tells them what they're really making per hour, handles GST and tax estimation automatically, and tracks every job from enquiry to paid — all in less time than logging a single Xero transaction.*

(Not happy with this. Workshop it.)

---

## What it does in 30 seconds (the demo)

The killer demo is roughly: open the app on a phone, show the home screen ("$X earned this week, Y hours, $Z/hr"), tap into a job, show the per-job hourly rate gauge, mark an invoice paid (one tap → income entry created automatically), flip to the Money tab, show the live tax exposure card with current vs previous year. Total demo time under 90 seconds.

The "ohhh" moment is the **tax exposure card** — pretty much no other NZ trades app surfaces "you owe roughly $X in tax based on what you've done so far this year, here's the breakdown." That's the thing that makes a painter go "I want this."

The other "ohhh" moment is **per-job hourly rate**. Most tradies have no idea whether the Smith job paid $45/h or $90/h. Showing them, retrospectively, on jobs they've already finished, is a religious experience.

---

## Why not Xero / Tradify / ServiceM8

| | Xero | Tradify / ServiceM8 | TradePilot |
|---|---|---|---|
| Built for | accountants | trades managers (3+ staff) | solo trades owner |
| Phone-first | no | partial | yes |
| NZ tax estimator built-in | no | no | **yes** |
| Per-job hourly-rate analytics | no | partial | **yes** |
| Sole-trader-Ltd shareholder-salary aware | no | no | **yes** |
| Time to log an expense | ~45 sec | ~30 sec | <10 sec |
| Price point | $35–70/mo | $40–80/mo | **target $25–35/mo** |

We're not trying to beat Xero at being Xero. We're saying: if you're a solo tradie, you don't *need* Xero, you need this.

---

## Pricing

**Target:** NZ$29/mo + GST. One tier, no annual lock-in initially, free 30-day trial with full features.

**Why $29:**
- Below the price point where buying it requires "thinking about it" for a tradie pulling $5–8k/wk gross. **[?]**
- Above the price floor where customers assume it's a hobby project and won't trust their books to it.
- Gives ~$22 ARPU after Stripe + GST. With 1,000 customers that's ~$260k ARR — meaningful business, not life-changing.
- Annual option later (~$290/yr, two months free) once we've proven retention.

Free tier? **No, deliberately.** Free users on a finance tool generate zero revenue and a lot of support burden. The trial is the free.

---

## Why now

- **Generative AI for plans take-off** is going from "novelty" to "good enough" over the next 12–18 months. There's a window where being the trades app with the best AI quoting assistant becomes a real moat. We won't be first to the AI bit but we can be first in NZ trades-finance specifically.
- **Xero's product is increasingly accountant-facing** and they keep raising prices. The bottom of their market is unhappy. **[?]**
- **NZ trades sector is small enough** (~30k Ltd-co construction-trade businesses **[?]**) that a single founder building locally and showing up at industry events can plausibly capture meaningful share. Not a "we need 10 sales reps" problem.
- **Brad already built it.** Most software businesses fail at the building step. This one is past that — the product exists, works, and has been used in anger for months by its first customer. The risk has shifted from "can we build it" to "will anyone else buy it" — which is the cheaper risk to test.

---

## Market size (rough)

Doing this in pencil so you know how much to trust it.

- NZ has roughly 200k self-employed in construction/trades (StatsNZ, broad). **[?]**
- Filtering to Ltd-co + 0–2 staff + active: maybe 30k. **[?]**
- Realistically targetable in years 1–3: 10% = 3,000 businesses. **[?]**
- At $29/mo: $1m ARR if we hit that. At 30%: $3.1m ARR.
- Beyond that, AU is 5–7x the size of NZ with a similar trades structure. NZ first; AU is the optionality, not the plan.

This isn't a venture-scale opportunity at NZ-only and probably not at NZ+AU either. It IS a very good lifestyle/bootstrapped business — $1–3m ARR, 60%+ margins, run from a laptop in Wānaka, fund whatever you want to do next. **Decide now whether that's the goal.** If it is, the strategy is "ship, charge money, survive 5 years, compound." If you want venture-scale, the product needs to be different (probably AI-native quoting tool that's not country-specific).

---

## Competitive moat (in order of strength)

1. **NZ-tax fluency.** Tax estimator with shareholder-salary reclassification, GST payments-basis, IR4 awareness, provisional tax thresholds. Hard for an Australian/American app to replicate without rebuilding their tax engine. This is the actual moat.
2. **Phone-first UX bar.** Once we set the bar at "log an expense in <10 seconds on a phone," any competitor targeting the same buyer has to match that or lose. It's a real engineering and design constraint that takes time to copy.
3. **Per-job analytics depth.** Hourly-rate gauge, hours-by-activity, expected-income logic — most apps don't go this deep because their buyer isn't analytical enough to care. Ours is, retrospectively, when shown the data.
4. **AI quoting (future).** Once the dataset exists across many beta users, an AI quoting assistant trained/calibrated on real NZ trades pricing is hard to replicate without the data. **This is months away, not now.**
5. **Brand and community (future).** "The Wānaka painter who built the tool" is a real story. Trades communities trust other tradies more than they trust software companies. Brad as the face of this is an asset, not a liability.

What's NOT a moat: the code. The features. The visual design. All copyable in months by anyone who decides to.

---

## What we'd need to ship before charging strangers

In rough effort order. None of these are speculative — they're all known gaps from `AGENTS.md`.

1. **Multi-tenant onboarding.** Right now the app assumes one user with one business. Need a real signup flow, business creation, tax-setup questionnaire that captures GST status, tax structure, bank format. ~2 weeks.
2. **Settings UI for tax estimator deductions.** Currently hardcoded for Brad's vehicle/home/laptop. Has to come out of code. ~3–5 days.
3. **Stripe billing.** Subscription, trial, dunning. ~1 week.
4. **Sole trader & partnership support, not just Ltd.** Today the tax model is Ltd-only. Sole traders are probably half the market. ~1 week.
5. **Bank import beyond BNZ.** ANZ, ASB, Kiwibank, Westpac formats. ~1 week.
6. **Real onboarding tour / empty-state polish.** First 10 minutes of a new account currently look bleak. ~3–5 days.
7. **Privacy policy, terms, GST receipts, basic legal.** ~2 days plus legal review.
8. **Marketing site** (probably tradepilot.co.nz). ~1 week.

Realistic minimum from "decision" to "first paid stranger": **8–10 weeks of focused work**, assuming Brad keeps painting part-time and ships 20 hrs/week of code. Could be faster with help.

---

## Risks (the honest ones)

- **Solo founder, no co-founder.** Burnout risk is real. Especially while still painting to pay bills.
- **Sales motion unproven.** We've never sold this to anyone. The buyer is a phone-using painter who doesn't read SaaS blogs and won't find us via SEO. Acquisition is going to be word-of-mouth + trade-association partnerships + maybe paid Facebook ads to NZ tradie audiences. None of that is fast.
- **Support burden.** A finance tool that gets someone's GST wrong is a refund + apology + lost trust. Brad's bar is already high here ("Claude is the second pair of eyes") but at 100 customers the support load is non-trivial.
- **Tax law changes.** IRD updates rates, brackets, thresholds. The estimator has to keep up. Annual maintenance burden, not huge but not zero.
- **Concentration risk on a single buyer profile.** If we're wrong about who the buyer is — if solo NZ tradies *don't* actually want this enough to pay $29/mo — the whole thing collapses. **This is what customer interviews are for.** Reduce this risk before reducing any other risk.
- **AI quoting tool may not work for years.** If we lean on "AI take-offs from architect drawings" as a wedge, we're betting on technology that may not be reliable enough to commercialise until 2027–2028. Bet small on this; let it be a feature, not the whole product.

---

## What we're NOT going to do (yet)

Saying no to these is as important as saying yes to the above.

- **Not building for >3-person teams.** Multi-user, role-based permissions, time clock for staff. Different product, different buyer, more competition.
- **Not building accountant tooling.** No "give your accountant access," no IR4 generation, no end-of-year financial statements export to Xero. Later, maybe. Not first.
- **Not building inventory.** Some trades need it; ours mostly don't. Out of scope.
- **Not building scheduling for clients.** No "client portal," no online booking, no quote acceptance via web link. Adjacent product, distract from the core.
- **Not building generic CRM.** Lead pipeline yes (already in roadmap), full CRM no.
- **Not Australia in year one.** Different tax system, different bank formats, different onboarding. Worth doing in year 2.

---

## The 90-day plan

**Weeks 1–2: discovery.** Five painter/tradie interviews. No code. Output: a written list of "things we believed in this doc that turned out to be wrong" and a sharper one-sentence pitch.

**Weeks 3–6: multi-tenant + onboarding.** The real product-readiness work. Settings UI for tax deductions, signup flow, sole-trader support, second bank format.

**Weeks 7–9: billing + landing page + 5 beta customers** at full price (Brad-network, Wānaka and surrounding). $29/mo. Real money, even if symbolically.

**Weeks 10–12: iterate from beta feedback** + first 20 customers via warm intros, no paid acquisition yet.

**Day 90 success metric:** 20 paying customers, <10% monthly churn, qualitative "this is the only finance tool I've kept paying for" feedback. If we hit that, we have a business and the next 90 days is about scaling acquisition. If we don't, we figure out what was wrong before spending money on growth.

---

## Open questions (ranked by how much they affect the plan)

1. **Is $29/mo the right price?** Need painter feedback. Could be $19. Could be $49.
2. **Is the buyer *really* solo trades, or is it specifically painters?** "All trades" is the dream but launching narrow (NZ painters first) might be smarter.
3. **Lifestyle business or venture-scale ambition?** Affects everything: hiring, fundraising, product scope, geography. Decide before week 4.
4. **Brad's time commitment.** Going full-time on TradePilot vs keeping Lakeside Painting running. Financial runway question. Probably needs 6 months runway saved before going full-time.
5. **Co-founder?** Solo is harder. A technical co-founder isn't needed (Brad can ship). A go-to-market or design co-founder might be the best hire we never made.
6. **Brand / name.** "TradePilot" is fine, working URL is unclear, may need to revisit.

---

## How to use this doc

Print it. Mark up the **[?]** items with what your gut says vs what you actually know. Cross out claims you don't believe. Add the ones you do. Bring it to the painter interviews and let them push back on it.

Re-write it after the interviews. The version of this doc you wrote *before* talking to anyone is wrong; the version *after* talking to ten people is the one that drives the product.
