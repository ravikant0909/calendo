// Kept out of worker.js: Cloudflare treats every export of the main module as
// an entry point, so non-function values can't be exported from there.

// One model for every AI call. Haiku 5.5 keeps the free tier cheap.
export const AI_MODEL = 'claude-haiku-5-5';

// Free daily AI allowance (UTC day). Users with their own Anthropic key or Pro
// are unlimited. Override per deployment with AI_FREE_DAILY_LIMIT /
// AI_PUBLIC_DAILY_LIMIT (self-hosters may set a high number). `demo` is the
// shared daily cap for all visitors of demo booking pages (AI_DEMO_DAILY_LIMIT).
export const AI_LIMITS = { dashboard: 30, public: 50, demo: 2000 };

// Per-visitor cap on demo-page AI chat, so one person can't use up the shared
// daily cap: this many messages per IP per hour.
export const DEMO_CHAT_PER_IP_HOURLY = 30;
