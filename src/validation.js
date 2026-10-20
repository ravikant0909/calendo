// Kept out of worker.js: Cloudflare treats every export of the main module as
// an entry point, so non-function values can't be exported from there.

// Plain email check. Also rejects characters that are legal in exotic quoted
// addresses but have no real-world use and are classic HTML-injection payloads
// (" < > ` \ and brackets/parens/commas/semicolons/colons).
export const EMAIL_RE = /^[^\s@"<>`\\()\[\],;:]+@[^\s@"<>`\\()\[\],;:]+\.[^\s@"<>`\\()\[\],;:]+$/;

