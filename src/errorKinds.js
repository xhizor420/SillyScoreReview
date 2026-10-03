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

/**
 * Errors that mean the *whole run* is broken, not this card: every remaining
 * card would fail the same way. Continuing just converts a bad key into
 * thousands of "failed" cards (and thousands of rejected requests against the
 * provider), so these pause the scan instead. Returns null for anything that
 * might be card-specific.
 */
export function fatalReason(err) {
  const status = err?.status;
  const text = `${err?.message || ''} ${err?.body || ''}`;
  // "Quota" is ambiguous: OpenAI's out-of-money 429 says "exceeded your current
  // quota", but plenty of providers say "quota exceeded" in an ordinary
  // per-minute rate limit. Only the unmistakably-about-money wording pauses a
  // scan; a plain rate limit is handled by slowing down, not by stopping.
  const aboutMoney = /insufficient (balance|funds|credit)|out of credits|no credits|balance is (too low|empty)|billing|payment required|exceeded your current quota/i.test(text);
  const perPeriod = /per (second|minute|hour)|requests per|rpm|tpm|try again in/i.test(text);
  if (status === 402 || (aboutMoney && !perPeriod) || (/quota exceeded/i.test(text) && status !== 429 && !perPeriod)) {
    return {
      kind: 'credits',
      message: 'The provider says the account is out of credits or over quota. Top it up, then press Resume — nothing after this point was charged or marked failed.',
    };
  }
  if (status === 401 || status === 403 || /invalid api key|incorrect api key|unauthori[sz]ed|authentication/i.test(text)) {
    return {
      kind: 'auth',
      message: 'The provider rejected the API key. Fix it in Settings, then press Resume — nothing after this point was marked failed.',
    };
  }
  if (status === 404 && /model/i.test(text)) {
    return {
      kind: 'model',
      message: 'The provider does not recognise the model name. Pick another model in Settings, then press Resume.',
    };
  }
  return null;
}

/**
 * Errors that mean the provider can't be reached at all — Wi-Fi drop, Tailscale
 * reconnecting, the PC waking from sleep, or the provider itself down. One of
 * these could be a blip; a streak of them is an outage, and an outage is not a
 * reason to mark a card as bad.
 */
export function isConnectivityError(err) {
  if (!err) return false;
  if (err.isTimeout) return false; // a slow model is not an outage
  if ([502, 503, 504].includes(err.status)) return true;
  const code = err.code || err.cause?.code;
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }
  return /fetch failed|socket hang up|network|other side closed/i.test(err.message || '');
}

/** True when a failure says nothing about the card, so it must not be recorded against it. */
export function isRunLevelError(err) {
  return Boolean(fatalReason(err)) || isConnectivityError(err);
}
