// Kept out of worker.js: Cloudflare treats every export of the main module as
// an entry point, so non-function values can't be exported from there.

// One model for every AI call. Haiku 5.5 keeps the free tier cheap.
export const AI_MODEL = 'claude-haiku-5-5';

// Free daily AI allowance (UTC day). Users with their own Anthropic key or Pro
// are unlimited. Override per deployment with AI_FREE_DAILY_LIMIT /
// AI_PUBLIC_DAILY_LIMIT (self-hosters may set a high number).
export const AI_LIMITS = { dashboard: 30, public: 50 };
