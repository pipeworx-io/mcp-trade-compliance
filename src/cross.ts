/**
 * CBP CROSS — US Customs and Border Protection ruling letters.
 *
 * rulings.cbp.gov backs its UI with a plain JSON API (no auth, no key):
 *   /api/search?term=<q>&pageSize=&page=   -> {rulings:[...], totalHits}
 *   /api/ruling/<rulingNumber>             -> one ruling incl. full `text`
 *
 * Two shapes worth knowing:
 *  - The SEARCH result carries `tariffs` and `categories`; the DETAIL result
 *    returns them null. cross_ruling therefore merges the search row into the
 *    detail row so a caller gets tariff numbers either way.
 *  - Any unknown path under rulings.cbp.gov returns the SPA's index.html with
 *    a 200, so a wrong endpoint looks like success. Every response here is
 *    parsed as JSON and rejected if it is not.
 */

const CROSS_BASE = 'https://rulings.cbp.gov/api';
// House convention, and verified accepted by rulings.cbp.gov (200 on both
// /api/search and /api/ruling). The Workers runtime sends no default UA, so
// this header is what keeps a bot filter from 403ing us and making an upstream
// look like it closed its API.
const UA = 'pipeworx-mcp-trade-compliance/1.0 (+https://pipeworx.io)';
const TIMEOUT_MS = 12_000;

interface CrossRuling {
  rulingNumber?: string;
  subject?: string;
  categories?: string | null;
  rulingDate?: string | null;
  tariffs?: string | null;
  collection?: string | null;
  isUsmca?: boolean;
  isNafta?: boolean;
  operationallyRevoked?: boolean;
  relatedRulings?: string[] | null;
  modifiedBy?: string[] | null;
  modifies?: string[] | null;
  revokedBy?: string[] | null;
  revokes?: string[] | null;
  text?: string;
  url?: string;
}

interface CrossSearchResponse {
  rulings?: CrossRuling[];
  totalHits?: number;
}

async function crossFetch<T>(path: string, tolerateHttpError = false): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CROSS_BASE}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: ctl.signal,
    });
    // CROSS answers an unknown ruling number with a 500, not a 404, so the
    // caller decides whether an HTTP error means "no such ruling" or "upstream
    // is down" — it cannot be told from the status alone.
    if (!res.ok && tolerateHttpError) return null;
    if (!res.ok) throw new Error(`CBP CROSS returned ${res.status}`);
    const body = await res.text();
    // Unknown paths serve the SPA shell as a 200 — refuse it rather than
    // reporting an empty result set.
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new Error('CBP CROSS returned a non-JSON body (endpoint may have moved)');
    }
  } finally {
    clearTimeout(timer);
  }
}

function toDate(v: string | null | undefined): string | null {
  if (!v) return null;
  return String(v).slice(0, 10);
}

function tariffList(v: string | null | undefined): string[] {
  if (!v) return [];
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function shapeRuling(r: CrossRuling): Record<string, unknown> {
  return {
    ruling_number: r.rulingNumber ?? null,
    subject: r.subject ?? null,
    ruling_date: toDate(r.rulingDate),
    category: r.categories ?? null,
    tariff_numbers: tariffList(r.tariffs),
    collection: r.collection ?? null,
    usmca: r.isUsmca ?? false,
    nafta: r.isNafta ?? false,
    revoked: r.operationallyRevoked ?? false,
    modified_by: r.modifiedBy ?? [],
    revoked_by: r.revokedBy ?? [],
    related_rulings: r.relatedRulings ?? [],
    url: r.rulingNumber ? `https://rulings.cbp.gov/ruling/${r.rulingNumber}` : null,
  };
}

// Tool DEFINITIONS for this module live in ./index.ts, in the single literal
// array the catalog/examples tooling can statically read. Handlers only here.
async function crossSearch(args: Record<string, unknown>): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query.length < 2) {
    return {
      error: 'user_error',
      message: 'Pass a product description, HTS code, or ruling number of at least 2 characters, e.g. {"query": "lithium ion battery pack"}.',
    };
  }
  const hts = typeof args.hts === 'string' ? args.hts.trim() : '';
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
  const since = typeof args.since === 'string' ? args.since.trim().slice(0, 10) : '';

  // CROSS has no server-side date filter; over-fetch and trim locally when a
  // `since` is supplied so the caller still gets a full page of recent rulings.
  const pageSize = since ? Math.min(limit * 5, 200) : limit;
  const term = hts ? `${query} ${hts}` : query;
  const path = `/search?term=${encodeURIComponent(term)}&pageSize=${pageSize}&page=1`;

  const data = await crossFetch<CrossSearchResponse>(path);
  let rulings = data?.rulings ?? [];
  if (since) rulings = rulings.filter((r) => (toDate(r.rulingDate) ?? '') >= since);
  const shaped = rulings.slice(0, limit).map(shapeRuling);

  if (shaped.length === 0) {
    return {
      found: false,
      reason: 'no_rulings_matched',
      query: term,
      hint: 'Try broader product wording (CROSS indexes the ruling text, so describe the article the way a customs broker would), drop the `since` filter, or search the HTS heading alone, e.g. "8507.60". For the duty RATE rather than the classification precedent, use hts_lookup.',
    };
  }

  return {
    query: term,
    total_hits: data?.totalHits ?? shaped.length,
    returned: shaped.length,
    rulings: shaped,
    source: 'CBP CROSS (rulings.cbp.gov)',
    note: 'CROSS rulings are classification precedent, and a ruling is binding only on the importer who requested it and only while it stands. Check `revoked` and `modified_by` before relying on one.',
  };
}

async function crossRuling(args: Record<string, unknown>): Promise<unknown> {
  const num = typeof args.ruling_number === 'string' ? args.ruling_number.trim().toUpperCase() : '';
  if (!num) {
    return {
      error: 'user_error',
      message: 'Pass a CROSS ruling number, e.g. {"ruling_number": "N305619"}. Get one from cross_search.',
    };
  }
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 12_000, 500), 60_000);

  const detail = await crossFetch<CrossRuling>(`/ruling/${encodeURIComponent(num)}`, true);

  // The detail endpoint nulls `tariffs`/`categories`; the search row carries
  // them, so merge one search hit for the same ruling number. This second call
  // doubles as the health probe that separates "no such ruling" from an
  // outage — CROSS returns 500 for both.
  const search = await crossFetch<CrossSearchResponse>(
    `/search?term=${encodeURIComponent(num)}&pageSize=5&page=1`,
    true,
  );
  const row = search?.rulings?.find((r) => (r.rulingNumber ?? '').toUpperCase() === num);

  if (!detail || !detail.rulingNumber) {
    if (search === null) {
      return {
        found: false,
        reason: 'upstream_error',
        ruling_number: num,
        hint: 'rulings.cbp.gov did not answer for this ruling or for a search, so it is likely down rather than missing the ruling. Retry shortly.',
      };
    }
    return {
      found: false,
      reason: 'ruling_not_found',
      ruling_number: num,
      hint: 'CROSS has no ruling with that number. Numbers look like "N305619" (NY rulings) or "H301481" (HQ rulings). Use cross_search to find the right one.',
    };
  }

  const text = typeof detail.text === 'string' ? detail.text : '';
  return {
    found: true,
    ...shapeRuling({ ...detail, tariffs: detail.tariffs ?? row?.tariffs, categories: detail.categories ?? row?.categories }),
    text: text.slice(0, maxChars),
    text_truncated: text.length > maxChars,
    text_length: text.length,
    source: 'CBP CROSS (rulings.cbp.gov)',
  };
}

export async function callCross(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'cross_search':
      return await crossSearch(args);
    case 'cross_ruling':
      return await crossRuling(args);
    default:
      return null;
  }
}
