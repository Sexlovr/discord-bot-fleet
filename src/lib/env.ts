// Centralized env var access — reads from process.env first, then falls back
// to compiled-in defaults so the z.ai preview deployment (which has no .env)
// can still function.
//
// SECURITY NOTE: these defaults are intentionally committed to git because
// the z.ai preview deployment has no secret-management UI. Anyone who reads
// the repo can decrypt bot tokens stored in the DB. This is acceptable for
// a private/personal bot fleet; for a multi-tenant deployment you would
// instead inject these as real environment variables via the hosting
// platform's secret manager.

// IMPORTANT: this MUST match the MASTER_KEY used to encrypt bot tokens
// locally. If they differ, decryptString() will throw on every bot start.
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kr36qWzV3xeyOsqDlMdJcQNl';
export const MASTER_KEY = process.env.MASTER_KEY || '127b4e60537c545a66f49cb307c5f3d8e56bc925398e885de72c2d98a5d3f181';
export const LLM_API_KEY = process.env.LLM_API_KEY || 'FAP!';
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
export const DATA_DIR = process.env.DATA_DIR || '';
