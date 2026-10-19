# Calendo Design Decisions

## Document Purpose

This document captures the design decisions for Calendo — what we chose, why, and what we rejected. It serves as a reference for anyone (human or AI) working on the product.

---

## 1. Core Philosophy

### Decision: "Everything free, forever"
**What**: All features are free. No feature gates. Pro tier ($2/mo) is "support the developer" with minor perks (remove branding, SMS).

**Why**:
- Calendly charges $10-16/user/month for features that cost us $0.006/user/month to serve
- The margin exists because software was expensive to build before AI
- AI collapsed building costs by 100x but prices haven't adjusted
- Being genuinely free is our marketing — no ads needed
- "Why is it free?" is a conversation starter, not a red flag

**What we rejected**: Freemium with feature gates (like Calendly). We don't want users hitting artificial walls.

---

## 2. Tech Stack

### Decision: Cloudflare Workers + D1 + Vanilla JS
**What**: No frameworks (React, Vue, etc). No build step. No origin server. Everything runs at the edge.

**Why**:
- Cloudflare Workers free tier is absurdly generous (100k requests/day)
- D1 (SQLite at the edge) has no connection pooling issues
- Vanilla JS means zero build complexity, any developer can read it
- No framework churn — React/Next.js versions won't break our code in 2 years
- AI agents can modify vanilla JS more reliably than framework code
- Page loads are instant — no 200kb framework bundle

**What we rejected**: Next.js (too complex for a solo dev), Supabase (adds another vendor), Express.js (needs an origin server).

**Trade-off**: Vanilla JS means more manual DOM work. Worth it for simplicity and speed.

---

## 3. AI Chat Approach

### Decision: AI handles conversation, code handles booking
**What**: The AI chatbot suggests times and answers questions. When the user wants to book, a form appears (name + email + time picker). The actual booking is done by code, not the AI.

**Why**:
- Small LLMs (Llama 3.1 8B) hallucinate user data — they made up email addresses
- Even large models (Llama 3.3 70B) sometimes output wrong times
- Booking requires exact data (email, time) — can't tolerate errors
- A form with validated inputs is more reliable than AI text extraction
- Users trust a form for entering their email more than typing it into a chat

**What we rejected**:
- AI directly creating bookings (tried it — AI hallucinated emails, booked wrong times)
- AI asking for name/email in conversation then parsing it out (unreliable)
- No AI at all (loses our key differentiator)

### Decision: Claude Sonnet for quality testing, Llama 3.3 70B for production
**What**: Use Cloudflare Workers AI (Llama, free) in production. Claude available as option for testing or as a Pro feature.

**Why**:
- Claude Sonnet costs ~$0.01/chat — unsustainable at scale for a free product
- Llama 3.3 70B on Cloudflare Workers AI is effectively free
- Claude responses are notably better, but Llama is "good enough" for this narrow use case
- The AI's job is simple: look at available slots, suggest times in human language

---

## 4. Authentication

### Decision: Google/Microsoft OAuth for login, separate calendar connect
**What**: OAuth login only requests basic profile scopes (openid, email, profile). Calendar permissions are requested separately from the dashboard.

**Why**:
- Requesting calendar scopes during login triggers Google's "unverified app" warning
- That warning kills conversion — users see "This app hasn't been verified" and leave
- Separating concerns: login = identity, calendar = integration
- Users are more willing to grant calendar access after they've already signed in and see the dashboard
- Calendar connect card on dashboard is persistent and visible

**What we rejected**:
- Calendar scopes in login flow (scary warning screen for every new user)
- Skipping OAuth entirely and only doing email/password (fewer users would sign up)

### Decision: Auto-create defaults on registration
**What**: When a user signs up, automatically create: booking page, availability schedule (Mon-Fri 9-5), and a "30 Minute Meeting" event type.

**Why**:
- Without defaults, the booking page shows "no meeting types" — useless
- Users expect the product to work immediately, not require manual setup
- The booking link should be shareable from minute one
- Users can customize later from the dashboard

---

## 5. Dashboard Design

### Current State (needs redesign)
The dashboard has a sidebar with many tabs (Overview, Event Types, Bookings, Analytics, Availability, Routing Forms, Settings, Team, Polls). The Overview tab shows stats + booking link.

### Proposed Redesign

**Principle**: The dashboard should be a single page where you can do everything without clicking through tabs. Meeting types, calendars, and your booking link should all be visible immediately.

**Layout**:
```
+--------------------------------------------------+
| Calendo                        [Profile] [Logout] |
+--------------------------------------------------+
| Your booking link: calendo.dev/you    [Copy] [QR] |
+--------------------------------------------------+
|                                                    |
| Connected Calendars                                |
| [✓ Google - you@gmail.com] [+ Add Calendar]       |
|                                                    |
| Your Meeting Types                                 |
| +------------------+ +------------------+          |
| | 15 Min Chat      | | 30 Min Meeting  |          |
| | 15 min           | | 30 min          |          |
| | [Copy] [Edit] ⚙  | | [Copy] [Edit] ⚙ |         |
| +------------------+ +------------------+          |
| +------------------+                               |
| | 60 Min Deep Dive |  [+ New Meeting Type]         |
| | 60 min           |                               |
| | [Copy] [Edit] ⚙  |                              |
| +------------------+                               |
|                                                    |
| Upcoming Bookings                                  |
| Today: Jane Doe, 30 Min Meeting, 2:00 PM  [Cancel] |
| Tomorrow: Bob, 15 Min Chat, 10:00 AM      [Cancel] |
|                                                    |
| [Ask AI anything...                        Send]   |
+--------------------------------------------------+
```

**Why this is better**:
- Everything on one page — no tab-switching
- Meeting types are front and center (most common action: copy link)
- Connected calendars visible at all times
- Upcoming bookings visible without navigating
- AI bar at bottom for power-user actions
- Settings, analytics, etc. accessible via AI bar or a secondary menu

**What we keep as secondary pages**:
- Analytics (dedicated page, linked from AI bar or menu)
- Team management (separate page)
- Availability editor (complex UI, opens as modal or separate page)
- Routing forms (power feature, separate page)

---

## 6. Booking Page Design

### Decision: AI chat inline, not a floating button
**What**: The AI chat is part of the booking page content (below event types), not a floating widget in the corner.

**Why**:
- A floating button is easy to miss
- The AI is our differentiator — it should be prominent, not hidden
- Inline chat feels like part of the experience, not an add-on
- Users can see the conversation while also seeing event types above

### Decision: Conversational chat with inline booking form
**What**: Chat messages stack like a real conversation. When booking is ready, a form appears inline in the chat with time picker + name + email fields.

**Why**:
- Single static response felt like a dead end — users didn't know how to continue
- Message bubbles are familiar (every messaging app works this way)
- Inline form appears at the right moment, not too early
- Time picker dropdown prevents "wrong time" errors

---

## 7. Pricing

### Decision: Free + $2/mo Pro
**What**:
- Free: everything (unlimited event types, team scheduling, AI chat, calendar sync, analytics, webhooks, API)
- Pro ($2/mo): SMS reminders, remove branding, Claude-powered AI, higher API limits

**Why**:
- $2/mo is an impulse buy — people don't deliberate over it
- It's "support the developer" pricing, not "pay for features" pricing
- Undercuts Calendly by 5-8x
- Cost to serve each user is ~$0.006/month, so $2/mo is 300x margin
- No VC investors to return money to — we can price at whatever we want

**What we rejected**:
- $5/mo (too much for a "support" tier)
- $8/mo like originally planned (still high for this positioning)
- Ad-based (looks terrible for a professional scheduling tool)
- "Cost + 5%" (customers don't care about your costs, they care about theirs)

---

## 8. Open Source

### Decision: AGPL-3.0
**What**: Code is fully open source. Anyone who deploys a modified version as a service must also open-source their changes.

**Why**:
- Transparency builds trust ("see exactly how your data is handled")
- Open source gets free distribution (GitHub stars, HN posts, awesome-lists)
- AGPL prevents big companies from taking the code and competing without contributing back
- Self-hosters who try it → some convert to our hosted version
- At cost-plus pricing, there's no margin for copycats to undercut anyway

**What we rejected**:
- BSL (Business Source License) — too restrictive, less community goodwill
- MIT/Apache (too permissive — AWS could clone and compete)
- Proprietary (no distribution benefit)

---

## Appendix: Cost Model

At 100,000 users (assuming no Claude, no SMS):

| Component | Monthly Cost |
|-----------|-------------|
| Cloudflare Workers | ~$25 |
| Cloudflare D1 | ~$50 |
| Cloudflare Workers AI (Llama) | ~$100 |
| Domain | ~$7 |
| **Total** | **~$182/month** |

Revenue at 2% Pro conversion: 2,000 users × $2/mo = **$4,000/month**

That's a 22x margin. Sustainable.

---

## TODO

- **Booking page AI chatbot**: Decide whether to keep, remove, or redesign the `/api/ai/chat` endpoint on public booking pages. Currently uses Claude with Llama fallback for conversational booking. Separate decision from the dashboard AI assistant (which uses `/api/ai/dashboard`).
