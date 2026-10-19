# Launch Quality System

This repo now has a layered pre-merge and pre-deploy test pipeline designed to catch logic bugs, schema regressions, broken routes, and user-flow failures before they reach production.

## Required checks on every change

Run these locally before merging high-risk changes:

```bash
npm run test:worker
npm run test:client
npm run test:schema
npm run test:smoke
npm run test:e2e:install
npm run test:e2e
```

## What each layer covers

- `test:worker` - unit and route-level worker tests
- `test:client` - client-side DOM tests for static pages
- `test:schema` - fresh local D1 schema apply from `schema.sql`
- `test:smoke` - local HTTP smoke against a real `wrangler dev` + D1 instance
- `test:e2e` - browser flow for sign-up, dashboard event creation, and public booking

Smoke and E2E runs load `scripts/local-test.env` so they exercise the real app while disabling outbound email/SMS delivery.

## CI pipeline

The GitHub Actions pipeline is split so failures are easy to locate:

- `worker-and-client` - Vitest suites
- `schema` - local D1 schema validation
- `smoke` - real local worker smoke flow
- `e2e` - Playwright browser flow on CI

Deployment is chained off a successful CI run on `main`, so deploys only happen from a tested commit.

## Bug prevention policy

- Every production bug gets a regression test before the fix merges.
- Booking, OAuth, payment, timezone, and recurrence changes are always treated as high-risk.
- New features should add at least one happy-path integration or E2E check in addition to unit coverage when they touch booking flows.
- No direct pushes to `main`; require PR review and required status checks.

## Manual GitHub settings to enable

These cannot be enforced from the repo alone and should be enabled in GitHub:

1. Protect `main`.
2. Require pull requests before merging.
3. Require the CI workflow to pass before merging.
4. Restrict direct pushes to `main`.
5. Require branches to be up to date before merging.

## Recommended post-launch additions

The repo changes here improve pre-merge quality, but launch reliability also needs runtime safeguards:

1. Production error tracking and alerting.
2. Scheduled synthetic booking checks against production.
3. Canary deploy or feature-flag rollout for risky features.
4. Fast rollback playbook for bad deploys.
