# Calendo

**A free, open-source Calendly alternative you can run entirely through an AI agent.**

Share a booking link and people pick a time — or skip the settings screens and just tell the
Calendo AI Agent what you want: *"Set up a 30-minute intro call, Tuesday to Thursday afternoons,
on Zoom."*

Hosted version: **https://calendo.dev** (free, and it will stay free). Built by one developer.

## Features

- Booking pages, event types, weekly availability, date overrides, buffers, limits
- Google Calendar and Outlook sync with conflict checking
- Automatic Google Meet, Microsoft Teams and Zoom links
- AI agent that can do anything the dashboard can
- Email reminders, rescheduling and cancellation links, webhooks, embeds
- Team scheduling, meeting polls, routing forms, paid bookings (Stripe)

## Tech stack

Cloudflare Workers + D1 (SQLite) + plain HTML/CSS/JS. No framework, no build step.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars        # fill in at least the "Required" block
npm run test:schema                   # creates a local D1 from schema.sql
npx wrangler dev                      # http://127.0.0.1:8787
```

## Self-host on your own Cloudflare account

1. Create a database: `npx wrangler d1 create calendo`
2. In `wrangler.json`, set `database_id` to the new id, and change `routes` and
   `APP_ORIGIN` to your domain (or remove `routes` to use a `*.workers.dev` URL).
3. Create the tables: `npx wrangler d1 execute calendo --remote --file schema.sql`
4. Set secrets — every name in `.dev.vars.example` — with
   `npx wrangler secret put NAME`. Only the "Required" block is mandatory; each other block
   turns on one integration.
5. Deploy: `npx wrangler deploy`

For Google, Microsoft and Zoom sign-in, register your own OAuth apps and add
`https://YOUR-DOMAIN/api/auth/callback/google` (and `/microsoft`, `/zoom`,
`/google-calendar`, `/outlook-calendar`) as redirect URLs.

## Tests

```bash
npm run test:ci      # worker + client unit tests, schema check, HTTP smoke test
npm run test:e2e     # browser tests (run `npm run test:e2e:install` once first)
```

## Contributing

Issues and pull requests are welcome. Please add tests with every change. For security
issues, see [SECURITY.md](SECURITY.md) — please don't open a public issue.

## License

Copyright (C) 2026 Ravi Gupta.

[AGPL-3.0](LICENSE). You can use, change and share Calendo freely. If you run a modified
version as a service for others, you must publish your changes under the same license.
