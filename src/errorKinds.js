/**
 * Collapses a raw error message into a category, so "91 failed" becomes
 * "80 timed out, 11 unparseable JSON" — the difference between a model-speed
 * problem and a model-output problem, which need opposite fixes.
 *
 * Lives in its own module rather than in cli.js so the server can import it
 * without executing the CLI's top-level main().
 */
export function classifyError(message = '') {
  const m = String(message);
  if (/timed out|aborted/i.test(m)) return 'Request timed out (model too slow)';
  if (/parseable JSON|did not return/i.test(m)) return 'Model returned unusable/incomplete JSON';
  if (/\b429\b|rate limit/i.test(m)) return 'Rate limited by the provider (429)';
  if (/\b401\b|\b403\b|unauthor|forbidden|api key/i.test(m)) return 'Auth rejected (401/403) — check your API key';
  if (/\b4\d\d\b/.test(m)) return `Provider rejected the request (${(m.match(/\b4\d\d\b/) || [])[0]})`;
  if (/\b5\d\d\b/.test(m)) return `Provider server error (${(m.match(/\b5\d\d\b/) || [])[0]})`;
  if (/no non-empty scorable fields/i.test(m)) return 'Card has no scorable text';
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|network/i.test(m)) return 'Network/connection problem';
  return 'Other';
}
