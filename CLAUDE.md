# Calendo - Project Context

## Project Overview

Calendo is an open-source scheduling platform — a Calendly competitor where AI is the key differentiator. Instead of the standard grid-of-time-slots experience, Calendo offers conversational booking via an AI chatbot, natural language scheduling, and smart time suggestions.

This is a **public SaaS product** — anyone can sign up and use it. It is NOT a private/family-only tool.

- **License**: AGPL-3.0 (open source, but prevents proprietary cloning — anyone who modifies and deploys must also open-source their changes)
- **Creator**: Ravi (solo indie developer)
- **Messaging**: Be transparent that this is built by one developer. "Indie-built" is a feature, not a weakness. No fake "we" or pretending to be a big team.

## Repository Info
- **GitHub**: https://github.com/ravikant0909/calendo
- **Owner**: ravikant0909 (personal GitHub account)
- **Created**: 2026-03-07

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Cloudflare Workers | Edge-first, globally distributed, generous free tier, zero cold starts |
| Database | Cloudflare D1 (SQLite) | Serverless SQL, zero config, lives at the edge with Workers |
| Frontend | Vanilla HTML/CSS/JS | No build step, no framework churn, fast loads, full control |
| Deployment | Wrangler CLI | Direct deploy to Cloudflare, simple CI/CD |
| Testing | Vitest + better-sqlite3 | Fast unit tests, D1 mocking via better-sqlite3 |
| AI | Cloudflare Workers AI / external LLM APIs | Conversational booking, smart scheduling |
| Auth | Email/password + OAuth (Google, Microsoft) | Public registration — anyone can create an account |
| Email | Resend | Transactional emails (confirmations, reminders) |

### Why No Frameworks
Same philosophy as the family project: vanilla HTML/CSS/JS keeps things simple, eliminates build tooling, avoids framework lock-in, and makes the codebase accessible to any developer (or AI agent). Every page is a self-contained HTML file. No webpack, no bundler, no transpiler.

## Architecture

### Edge-First Design
Everything runs on Cloudflare's edge network. No origin server. Each request is handled by the Worker closest to the user.

```
User Request
    |
    v
Cloudflare Worker (edge)
    |
    ├── Static assets (HTML/CSS/JS) served directly
    ├── API routes (/api/*) handled by Worker
    ├── D1 database queries (SQLite at the edge)
    └── AI inference (Workers AI or external API calls)
```

### Core Entities
- **User**: Someone who creates a Calendo account to manage their scheduling
- **Event Type**: A bookable meeting template (e.g., "30-min intro call", "1-hour consultation")
- **Booking**: A confirmed scheduled meeting between a user and an invitee
- **Availability**: A user's available time windows (weekly recurring + overrides)
- **Invitee**: The person booking a meeting (does NOT need a Calendo account)
- **Booking Page**: Public page where invitees book meetings (includes AI chatbot)

## Directory Structure

```
calendo/
├── CLAUDE.md              # This file — project context for AI agents
├── LICENSE                # AGPL-3.0
├── README.md              # Public-facing project readme
├── wrangler.toml          # Cloudflare Workers configuration
├── package.json           # Dependencies (vitest, better-sqlite3, etc.)
├── vitest.config.js       # Test configuration
│
├── src/
│   ├── index.js           # Worker entry point — request router
│   ├── router.js          # URL routing logic
│   │
│   ├── api/               # API route handlers
│   │   ├── auth.js        # Login, register, OAuth, sessions
│   │   ├── event-types.js # CRUD for event types
│   │   ├── bookings.js    # Booking creation, cancellation, rescheduling
│   │   ├── availability.js# Availability rules
│   │   ├── users.js       # User profile management
│   │   └── webhooks.js    # Webhook management and delivery
│   │
│   ├── ai/                # AI features
│   │   ├── chatbot.js     # Conversational booking chatbot
│   │   ├── suggestions.js # Smart time suggestions
│   │   └── nlp.js         # Natural language time parsing
│   │
│   ├── lib/               # Shared utilities
│   │   ├── db.js          # D1 query helpers
│   │   ├── auth.js        # Auth middleware, session management
│   │   ├── email.js       # Email sending
│   │   ├── calendar.js    # Calendar/timezone utilities
│   │   └── validation.js  # Input validation
│   │
│   └── pages/             # HTML pages served by the Worker
│       ├── landing/       # Marketing/landing page
│       ├── app/           # Dashboard (authenticated users)
│       ├── booking/       # Public booking pages (with AI chatbot)
│       └── auth/          # Login, register, OAuth callback pages
│
├── migrations/            # D1 database migrations (sequential SQL files)
│   ├── 0001_initial.sql
│   └── ...
│
├── tests/                 # Test files (mirror src/ structure)
│   ├── api/
│   ├── ai/
│   ├── lib/
│   └── helpers/           # Test utilities, D1 mock setup
│       └── db.js          # better-sqlite3 D1 mock
│
└── docs/                  # Additional documentation
```

## Development Environment

### Node.js Setup (via nvm)
- **Node version**: v24.12.0 (LTS)
- **Node path**: `~/.nvm/versions/node/v24.12.0/bin`

### Wrangler CLI
- **Auth**: Cloudflare API token stored in `~/.cloudflare_token`

### Common Commands
```bash
# Load environment
source ~/.cloudflare_token
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"

# Local development
wrangler dev

# Run tests
npx vitest run

# Run specific test file
npx vitest run tests/api/bookings.test.js

# Validate schema against a fresh local D1
npm run test:schema

# Run local HTTP smoke against wrangler dev + D1
npm run test:smoke

# Run browser E2E against a local worker
npm run test:e2e:install
npm run test:e2e

# Run the non-browser CI test stack locally
npm run test:ci

# Execute D1 SQL (remote)
wrangler d1 execute calendo --remote --command="SELECT * FROM users;"

# Apply migrations (remote)
wrangler d1 migrations apply calendo --remote

# Deploy to production
wrangler deploy
```

## Git Workflow

### Worktrees (MANDATORY)
**Always use a separate git worktree for each Claude Code session.** Never work directly on `main`. This prevents conflicts when multiple sessions run in parallel.

### Branch Naming
- `feat/<description>` — new features
- `fix/<description>` — bug fixes
- `refactor/<description>` — code restructuring
- `test/<description>` — test additions/changes
- `docs/<description>` — documentation updates

### Commit Conventions
- Write clear, concise commit messages describing what changed and why
- One logical change per commit
- Always commit before deploying

### Deployment Rules
1. **Never deploy with uncommitted changes.** Commit and push first, then deploy.
2. **Never deploy directly from main.** Work in a worktree branch, merge to main, then deploy from main.
3. **Run tests before deploying.** All tests must pass.

## Development Principles

1. **Always write extensive tests** for every feature. Tests are a hard requirement, not optional. Every PR must include comprehensive unit tests and edge case coverage.
2. **Never deploy without committing first.** All code changes MUST be committed and pushed to git BEFORE running `wrangler deploy`.
3. **AI agent feature parity.** Every feature built in the dashboard UI must also be callable via the Calendo AI assistant. When adding a new action to the UI, add a corresponding AI tool so users can do the same thing via chat.
4. **No frameworks.** Vanilla HTML/CSS/JS only. No React, Vue, Svelte, etc. No build step.
4. **Edge-first.** Everything runs on Cloudflare Workers. No origin server, no Node.js server, no Express.
5. **Keep it simple.** This is an indie project. Avoid over-engineering. Ship features, not abstractions.
6. **Light/white theme** as default for all UI.
7. **Every bug fix must add a regression test.** Escaped production bugs should become permanent automated coverage.

## Testing Strategy

### Stack
- **Vitest** as the test runner
- **better-sqlite3** to mock Cloudflare D1 in tests (D1 is SQLite under the hood, so better-sqlite3 gives us a real SQLite engine locally)
- **Wrangler local D1 + `wrangler dev`** for schema validation and HTTP smoke tests
- **Playwright** for browser E2E coverage of critical user journeys

### Conventions
- Test files live in `tests/` and mirror the `src/` directory structure
- Test file naming: `<module>.test.js`
- Each test file should set up its own D1 mock database using the helper in `tests/helpers/db.js`
- Run migrations on the test DB before each test suite
- Test both happy paths and error cases
- Test auth middleware separately — most API tests should mock auth
- High-risk changes (booking, payments, OAuth, timezone, recurrence, team scheduling) should add integration or E2E coverage, not just unit coverage
- Keep smoke and E2E flows deterministic: use real local D1 state, unique test data, and fixed timezone assumptions where possible

### What to Test
- All API endpoints: valid inputs, invalid inputs, auth required, permissions
- AI features: prompt construction, response parsing, edge cases
- Database operations: CRUD, constraints, migrations
- Utility functions: timezone handling, date parsing, validation
- Booking logic: conflict detection, availability checks, timezone conversion
- Launch-critical flows: sign up, event type creation, public booking, paid booking hold behavior, cancellation, rescheduling

### Launch Quality Gates
- `npm run test:worker` — worker unit and route coverage
- `npm run test:client` — client DOM coverage
- `npm run test:schema` — fresh `schema.sql` apply against local D1
- `npm run test:smoke` — local HTTP smoke against a real worker + D1 instance
- `npm run test:e2e` — browser E2E for critical user paths
- `CI` must pass before merging to `main`
- `Deploy` runs only from a commit that already passed `CI` on `main`

### Running Tests
```bash
# All tests
npx vitest run

# Watch mode during development
npx vitest

# Specific file
npx vitest run tests/api/bookings.test.js

# Schema validation
npm run test:schema

# Local smoke
npm run test:smoke

# Browser E2E
npm run test:e2e:install
npm run test:e2e

# Non-browser CI stack
npm run test:ci

# With coverage
npx vitest run --coverage
```

### CI / Release Process
- GitHub Actions workflow: `.github/workflows/ci.yml`
- Deploy workflow chained off successful CI: `.github/workflows/deploy.yml`
- Browser E2E spec: `tests/e2e/launch-booking-flow.spec.js`
- HTTP smoke script: `scripts/smoke-local.mjs`
- Schema reset/apply script: `scripts/prepare-local-db.mjs`
- Local test env overrides for smoke/E2E: `scripts/local-test.env`
- Launch-quality policy doc: `docs/launch-quality.md`

## Database Conventions

### D1 (SQLite)
- **Database name**: `calendo`
- All table and column names use `snake_case`
- Every table has `id` (INTEGER PRIMARY KEY AUTOINCREMENT), `created_at`, and `updated_at` columns
- Use `updated_at` triggers or application-level updates
- Foreign keys are enforced (`PRAGMA foreign_keys = ON`)
- Soft deletes where appropriate (`deleted_at` column)

### Migrations
- Sequential numbered SQL files in `migrations/`: `0001_initial.sql`, `0002_add_webhooks.sql`, etc.
- Each migration is idempotent where possible (use `IF NOT EXISTS`)
- Never modify a migration that has been applied to production — create a new one
- Test migrations against better-sqlite3 before applying to remote D1

### Key Tables (MVP)
- `users` — registered Calendo users
- `sessions` — auth sessions
- `event_types` — bookable meeting templates
- `availability_rules` — weekly recurring availability
- `availability_overrides` — date-specific overrides (blocks or opens)
- `bookings` — confirmed meetings
- `booking_invitees` — invitee details per booking

## API Design

### REST Conventions
- All API routes under `/api/`
- Standard HTTP methods: GET (read), POST (create), PUT (update), DELETE (remove)
- JSON request and response bodies
- Consistent error format: `{ "error": { "code": "ERROR_CODE", "message": "Human-readable message" } }`
- HTTP status codes: 200 (OK), 201 (Created), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 409 (Conflict), 500 (Internal Server Error)
- Pagination via `?page=1&limit=20` with response metadata: `{ "data": [...], "pagination": { "page": 1, "limit": 20, "total": 42 } }`

### Auth
- Session-based auth with secure HTTP-only cookies
- Public endpoints (booking pages, availability lookup) require no auth
- Authenticated endpoints require a valid session cookie
- OAuth endpoints handle Google and Microsoft login flows

### Webhooks
- Users can register webhook URLs for events: `booking.created`, `booking.cancelled`, `booking.rescheduled`
- Webhook payloads are JSON with a signature header for verification
- Retry failed deliveries with exponential backoff (3 attempts)

### Key Endpoints (MVP)
```
POST   /api/auth/register       # Create account
POST   /api/auth/login          # Email/password login
POST   /api/auth/logout         # End session
GET    /api/auth/oauth/:provider # OAuth redirect

GET    /api/event-types         # List user's event types
POST   /api/event-types         # Create event type
PUT    /api/event-types/:id     # Update event type
DELETE /api/event-types/:id     # Delete event type

GET    /api/availability        # Get availability rules
PUT    /api/availability        # Update availability rules

GET    /api/bookings            # List user's bookings
POST   /api/bookings            # Create booking (used by booking page)
PUT    /api/bookings/:id/cancel # Cancel booking
PUT    /api/bookings/:id/reschedule # Reschedule booking

GET    /api/users/me            # Get current user profile
PUT    /api/users/me            # Update profile

# Public (no auth)
GET    /api/public/:username/:event-slug/slots  # Available time slots
POST   /api/public/:username/:event-slug/book   # Book a slot
POST   /api/public/ai/chat     # AI chatbot for booking page
```

## Feature Roadmap

### Phase 1: MVP (Core Scheduling)
Get the basics working — a user can create an account, set up event types, define availability, and share a booking link. Invitees can see available slots and book.

- [ ] User registration and login (email/password)
- [ ] Event type CRUD (name, duration, description, slug)
- [ ] Availability management (weekly recurring schedule)
- [ ] Public booking page (shows calendar, available slots)
- [ ] Booking creation with email confirmation
- [ ] User dashboard (upcoming bookings, event types)
- [ ] Timezone handling (invitee picks their timezone)
- [ ] Landing page (marketing, sign up CTA)

### Phase 2: AI + Polish
The differentiator. Add AI-powered features and polish the product for real users.

- [ ] AI chatbot on booking pages (conversational booking instead of clicking a grid)
- [ ] Natural language scheduling ("Book me 30 mins with Ravi next Tuesday afternoon")
- [ ] Smart time suggestions (AI recommends optimal times based on patterns)
- [ ] Google Calendar integration (two-way sync, conflict detection)
- [ ] Microsoft Calendar integration
- [ ] OAuth login (Google, Microsoft)
- [ ] Custom booking questions (ask invitees for context before the meeting)
- [ ] Email reminders (24h and 1h before meeting)
- [ ] Availability overrides (block specific dates, open extra slots)
- [ ] Booking cancellation and rescheduling
- [ ] Webhooks for integrations

### Phase 3: Growth
Features for power users, teams, and monetization.

- [ ] Team scheduling (round-robin, collective availability)
- [ ] Paid bookings (Stripe integration)
- [ ] Custom branding (colors, logo on booking page)
- [ ] Recurring meetings
- [ ] Buffer time between meetings
- [ ] Minimum scheduling notice
- [ ] Analytics dashboard (booking trends, popular times)
- [ ] Embeddable widget (iframe for external sites)
- [ ] API keys for programmatic access
- [ ] Rate limiting and abuse prevention

## AI Features Strategy

AI is the core differentiator. Calendo's AI should make scheduling feel like texting a helpful assistant, not navigating a form.

### Conversational Booking Chatbot
- Lives on the public booking page as an alternative to the traditional calendar grid
- Invitee can type naturally: "I need 30 minutes sometime Thursday or Friday afternoon"
- Chatbot checks availability, suggests times, handles the booking
- Falls back gracefully to the grid UI if the invitee prefers
- Must be fast — responses under 2 seconds

### Natural Language Time Parsing
- Parse inputs like "next Tuesday at 2pm", "sometime this week", "mornings are best for me"
- Handle timezone-aware parsing
- Handle ambiguity gracefully ("Tuesday" — this Tuesday or next?)

### Smart Suggestions
- When showing available slots, rank them by likely preference
- Consider: time of day patterns, day of week patterns, buffer from now
- Future: learn from booking history

### Implementation Notes
- Use Cloudflare Workers AI where possible (runs at the edge, no external API call latency)
- Fall back to external LLM APIs (Claude, OpenAI) for complex conversational tasks
- Keep AI interactions stateless per request where possible (pass conversation history in the request)
- Always have a non-AI fallback — the product must work without AI too

## Open Source & Licensing

### AGPL-3.0
The AGPL-3.0 license is intentional:
- Anyone can view, use, and modify the code
- If someone deploys a modified version as a service, they MUST open-source their changes
- This prevents large companies from taking the code, making it proprietary, and competing without contributing back
- Individual self-hosters benefit from full source access

### Community Approach
- Public GitHub repo with clear contributing guidelines
- Issues and PRs welcome
- Be transparent: this is one developer's project, not a VC-funded startup
- Documentation is a feature — keep CLAUDE.md and README.md current

## Code Style and Conventions

### JavaScript
- ES modules (`import`/`export`), not CommonJS
- `const` by default, `let` when reassignment is needed, never `var`
- Async/await over raw Promises
- Early returns over deep nesting
- Descriptive variable names — no single-letter variables except loop counters
- No semicolons (rely on ASI) or always use semicolons — pick one and be consistent (TBD on project init)

### HTML/CSS
- Semantic HTML elements (`<nav>`, `<main>`, `<section>`, `<article>`)
- CSS custom properties (variables) for theming
- Mobile-first responsive design
- Light/white theme as default
- No CSS frameworks (no Tailwind, no Bootstrap) — write clean CSS
- BEM-ish class naming or simple descriptive classes

### File Organization
- One module per file, named for what it does
- Keep files under 300 lines — split when they grow beyond that
- Group related functions in the same file, but don't create god-files

### Error Handling
- Always return proper HTTP status codes from API endpoints
- Never expose internal errors to end users — log them, return a generic message
- Validate all user input at the API boundary
- Use try/catch around D1 queries and external API calls

## User Preferences
- **Theme**: Light/white theme preferred
- **Design**: Clean, minimal aesthetic
- **File paths**: Always output full absolute file paths

---

*This file serves as persistent context for Claude Code sessions working on Calendo. Update it as the project evolves.*
