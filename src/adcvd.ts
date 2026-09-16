/**
 * AD/CVD orders — US antidumping / countervailing duty orders, live off the
 * Federal Register API (International Trade Administration notices).
 * Keyless, no hosting: every call proxies federalregister.gov directly.
 *
 * Tools:
 * - adcvd_orders: product/country/HTS search → current AD/CVD order status
 *   ("is there an antidumping duty order in place on X from Y")
 * - adcvd_case: one AD/CVD case number (A-570-979 / C-570-980 style) or FR
 *   document number → the full notice history for that case
 *
 * Correctness trap (load-bearing): Federal Register full-text search is
 * noisy — a query for "steel China" surfaces notices about Japan, Korea,
 * Taiwan, etc. purely on term relevance. This module NEVER trusts the query
 * to describe what a returned row is about — it re-derives product/country
 * from the notice's own TITLE (federalregister.gov's AD/CVD title convention
 * is "<Product> From <Country>: <Action>") and filters on that parsed value.
 *
 * Case numbers come from the Federal Register `docket_ids` field, which the
 * LIST endpoint already returns (no per-document detail fetch needed) for
 * any notice that carries one — confirmed live: fiberglass door panels order
 * 2026-16033 → docket_ids: ["A-570-209, C-570-210"]. Batch/omnibus notices
 * (administrative-review initiations covering many cases at once) carry an
 * empty docket_ids and are excluded from adcvd_orders by the order-shaped
 * title filter anyway.
 */

const FR_BASE = 'https://www.federalregister.gov/api/v1';
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = 'pipeworx-mcp-trade-compliance/1.0 (+https://pipeworx.io)';

type ToolResult = Record<string, unknown>;

// ── HTTP ─────────────────────────────────────────────────────────────

async function frFetch(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        // ignore — body may be unreadable
      }
      throw new Error(`Federal Register API: ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

interface FrListResult {
  title?: unknown;
  publication_date?: unknown;
  document_number?: unknown;
  type?: unknown;
  html_url?: unknown;
  abstract?: unknown;
  docket_ids?: unknown;
}

interface FrListResponse {
  count?: unknown;
  results?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function searchDocuments(term: string, perPage: number): Promise<FrListResult[]> {
  const params = new URLSearchParams();
  params.append('conditions[agencies][]', 'international-trade-administration');
  if (term) params.append('conditions[term]', term);
  params.append('per_page', String(perPage));
  params.append('order', 'newest');
  for (const f of ['title', 'publication_date', 'document_number', 'type', 'html_url', 'abstract', 'docket_ids']) {
    params.append('fields[]', f);
  }
  const data = await frFetch(`${FR_BASE}/documents.json?${params.toString()}`);
  if (!isRecord(data)) return [];
  const resp = data as FrListResponse;
  return Array.isArray(resp.results) ? (resp.results as FrListResult[]) : [];
}

async function getDocument(documentNumber: string): Promise<Record<string, unknown> | null> {
  const data = await frFetch(`${FR_BASE}/documents/${encodeURIComponent(documentNumber)}.json`);
  return isRecord(data) ? data : null;
}

// ── Case-number extraction ──────────────────────────────────────────
// `docket_ids` elements are sometimes ONE code, sometimes a comma-joined
// string of several ("A-570-979, C-570-980, A-570-010, C-570-011") — join
// everything and regex out the codes rather than trusting array shape.

const CASE_NUMBER_RE = /\b[AC]-\d{3}-\d{3}\b/g;

function extractCaseNumbers(docketIds: unknown): string[] {
  if (!Array.isArray(docketIds)) return [];
  const joined = docketIds.filter((x): x is string => typeof x === 'string').join(', ');
  const found = joined.match(CASE_NUMBER_RE) ?? [];
  return [...new Set(found.map((c) => c.toUpperCase()))];
}

// ── Country parsing ──────────────────────────────────────────────────
// FR titles use formal treaty/State-Dept names ("the People's Republic of
// China") far more often than the plain name a caller types ("China"). Peel
// off the known formal names first (consuming them from the segment so they
// don't also get picked up as leftover plain text), then split what remains
// on commas/"and" for countries that are already in plain form (Japan,
// Taiwan, India, ...).

const FORMAL_COUNTRY_PATTERNS: Array<{ re: RegExp; plain: string }> = [
  { re: /the people's republic of china/gi, plain: 'China' },
  { re: /the socialist republic of vietnam/gi, plain: 'Vietnam' },
  { re: /the republic of korea/gi, plain: 'South Korea' },
  { re: /the democratic people's republic of korea/gi, plain: 'North Korea' },
  { re: /the republic of turk[ie]ye/gi, plain: 'Turkey' },
  { re: /t[uü]rk[ie]ye/gi, plain: 'Turkey' },
  { re: /the lao people's democratic republic/gi, plain: 'Laos' },
  { re: /the russian federation/gi, plain: 'Russia' },
  { re: /the united mexican states/gi, plain: 'Mexico' },
  { re: /the federative republic of brazil/gi, plain: 'Brazil' },
  { re: /the republic of india/gi, plain: 'India' },
  { re: /the republic of indonesia/gi, plain: 'Indonesia' },
  { re: /the kingdom of thailand/gi, plain: 'Thailand' },
  { re: /the arab republic of egypt/gi, plain: 'Egypt' },
  { re: /the republic of the philippines/gi, plain: 'Philippines' },
  { re: /the state of qatar/gi, plain: 'Qatar' },
  { re: /the united arab emirates/gi, plain: 'United Arab Emirates' },
  { re: /the kingdom of saudi arabia/gi, plain: 'Saudi Arabia' },
  { re: /the republic of south africa/gi, plain: 'South Africa' },
  { re: /the republic of colombia/gi, plain: 'Colombia' },
  { re: /the republic of chile/gi, plain: 'Chile' },
];

// User-facing aliases → the canonical plain form parseCountries() emits.
// Matching is case-insensitive and forgiving in both directions (see
// countryMatches below), so this list only needs the non-obvious ones.
const COUNTRY_ALIASES: Record<string, string> = {
  china: 'China',
  prc: 'China',
  'people’s republic of china': 'China',
  vietnam: 'Vietnam',
  'viet nam': 'Vietnam',
  korea: 'South Korea',
  'south korea': 'South Korea',
  'republic of korea': 'South Korea',
  'north korea': 'North Korea',
  turkey: 'Turkey',
  turkiye: 'Turkey',
  'türkiye': 'Turkey',
  laos: 'Laos',
  russia: 'Russia',
  mexico: 'Mexico',
  uae: 'United Arab Emirates',
  'saudi arabia': 'Saudi Arabia',
};

function normalizeCountryInput(input: string): string {
  const key = input.trim().toLowerCase();
  return COUNTRY_ALIASES[key] ?? input.trim();
}

/** Extract every country named in a "From <segment>" chunk of a title. */
function parseCountries(segment: string): string[] {
  let remaining = segment;
  const found: string[] = [];
  for (const { re, plain } of FORMAL_COUNTRY_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(remaining)) {
      if (!found.includes(plain)) found.push(plain);
      remaining = remaining.replace(re, ' ');
    }
  }
  const leftover = remaining
    .replace(/\bthe\b/gi, ' ')
    .split(/,|\band\b/i)
    .map((tok) => tok.trim())
    .filter(Boolean);
  for (const tok of leftover) {
    if (/^[A-Za-z .'-]+$/.test(tok)) {
      const clean = tok.replace(/\s+/g, ' ').trim();
      if (clean.length > 1 && !found.some((f) => f.toLowerCase() === clean.toLowerCase())) {
        found.push(clean);
      }
    }
  }
  return found;
}

/** Forgiving match: does any parsed country correspond to the caller's input? */
function countryMatches(userInput: string, parsedCountries: string[]): string | null {
  const canonical = normalizeCountryInput(userInput).toLowerCase();
  const rawLower = userInput.trim().toLowerCase();
  for (const c of parsedCountries) {
    const cl = c.toLowerCase();
    if (cl === canonical || cl === rawLower) return c;
    if (cl.includes(rawLower) || rawLower.includes(cl)) return c;
  }
  return null;
}

// ── Title → (product, countries, action) ─────────────────────────────

type AdcvdAction = 'order' | 'continuation' | 'revocation' | 'partial_revocation' | 'amended';
type OrderType = 'antidumping' | 'countervailing' | 'both';
type OrderStatus = 'in_place' | 'in_place_revoked_in_part' | 'revoked';

interface ParsedTitle {
  product: string;
  countries: string[];
  action: AdcvdAction;
  orderType: OrderType;
}

const NOISE_WORDS =
  /\b(review|reviews|determination|determinations|investigation|investigations|rescission|rescission|initiation|scope ruling|court decision|circumvention|inquiry|opportunity|finding|findings|suspended|comment period|correction)\b/i;

/**
 * Classify a title as an actual order-status document (imposition,
 * continuation, revocation, amendment) or noise (administrative review,
 * sunset-review result short of revocation, scope ruling, court remand,
 * initiation notice, ...). Returns null for anything that isn't a clean
 * "<Product> From <Country>: <Action>" AD/CVD order-shaped title.
 */
function parseOrderTitle(title: string): ParsedTitle | null {
  const m = /^(.*?)\s+[Ff]rom\s+(.+?):\s*(.+)$/.exec(title);
  if (!m) return null;
  const [, productRaw, countrySegment, actionRaw] = m;
  const action = actionRaw.trim();
  const lowered = action.toLowerCase();

  // NB: titles often share "Duty" across a conjunction ("Antidumping and
  // Countervailing Duty Orders") rather than repeating it ("antidumping duty
  // ... countervailing duty"), so gate/type on the bare words + a separate
  // "duty" check rather than requiring the literal two-word phrase — the
  // definitive order_type still comes from case-number prefixes downstream
  // (see orderTypeFromCaseNumbers), this is only the gate + a text fallback.
  const hasAD = /antidumping/.test(lowered);
  const hasCVD = /countervailing/.test(lowered);
  const hasDutyWord = /\bduty\b/.test(lowered);
  const hasOrderWord = /\border(s)?\b/.test(lowered);
  if (!hasOrderWord || !hasDutyWord || !(hasAD || hasCVD)) return null;

  let resolvedAction: AdcvdAction;
  if (/revocation/.test(lowered)) {
    // Commerce revokes an order "in Part" far more often than in full —
    // typically for named companies or a carved-out product subset, leaving
    // the order in force for everyone else. Reporting that as a flat
    // "revoked" would tell an importer a duty is gone when it still applies.
    resolvedAction = /\bin part\b/.test(lowered) ? 'partial_revocation' : 'revocation';
  } else if (/continuation/.test(lowered)) {
    resolvedAction = 'continuation';
  } else if (NOISE_WORDS.test(lowered)) {
    return null; // sunset-review result, admin review, scope ruling, etc. — not an order action
  } else if (/amended/.test(lowered)) {
    resolvedAction = 'amended';
  } else {
    resolvedAction = 'order';
  }

  const countries = parseCountries(countrySegment);
  if (countries.length === 0) return null;

  const orderType: OrderType = hasAD && hasCVD ? 'both' : hasAD ? 'antidumping' : 'countervailing';

  return {
    product: productRaw.trim().replace(/\s+/g, ' '),
    countries,
    action: resolvedAction,
    orderType,
  };
}

/**
 * Case numbers are unambiguous (A- = antidumping, C- = countervailing) and
 * more reliable than title text, which sometimes shares "Duty" across a
 * conjunction ("Antidumping and Countervailing Duty Orders") in a way that
 * defeats naive phrase matching. Prefer this when case numbers are present;
 * fall back to the title-derived type (parseOrderTitle) only when they aren't.
 */
function orderTypeFromCaseNumbers(caseNumbers: string[]): OrderType | null {
  const hasA = caseNumbers.some((c) => c.startsWith('A-'));
  const hasC = caseNumbers.some((c) => c.startsWith('C-'));
  if (hasA && hasC) return 'both';
  if (hasA) return 'antidumping';
  if (hasC) return 'countervailing';
  return null;
}

function productKey(product: string): string {
  return product.toLowerCase().replace(/^certain\s+/, '').trim();
}

// ── adcvd_orders ─────────────────────────────────────────────────────

interface OrderNoticeRow {
  action: AdcvdAction;
  order_type: OrderType;
  publication_date: string;
  document_number: string;
  federal_register_url: string;
  title: string;
  case_numbers: string[];
}

interface OrderGroup {
  product: string;
  country: string;
  status: OrderStatus;
  order_type: OrderType;
  case_numbers: string[];
  latest_action: AdcvdAction;
  latest_publication_date: string;
  notices: OrderNoticeRow[];
}

function statusFromAction(action: AdcvdAction): OrderStatus {
  if (action === 'revocation') return 'revoked';
  // Still in force for everyone outside the carve-out — the caller has to read
  // the notice to learn who or what came out from under it.
  if (action === 'partial_revocation') return 'in_place_revoked_in_part';
  return 'in_place';
}

async function adcvdOrders(args: Record<string, unknown>): Promise<unknown> {
  const product = typeof args.product === 'string' ? args.product.trim() : '';
  const country = typeof args.country === 'string' ? args.country.trim() : '';
  const hts = typeof args.hts === 'string' ? args.hts.trim() : '';
  const limitRaw = args.limit;
  const limit = Math.min(50, Math.max(1, Number(limitRaw) || 20));

  if (!product && !country) {
    return {
      found: false,
      reason: 'user_error',
      hint:
        'Pass at least "product" or "country" (or both). Example: { "product": "steel", "country": "China" } or { "country": "Vietnam" } for every AD/CVD order currently covering imports from Vietnam.',
    } satisfies ToolResult;
  }

  const termParts = [product, country, hts].filter(Boolean);
  const term = termParts.join(' ');

  let raw: FrListResult[];
  try {
    raw = await searchDocuments(term, 100);
  } catch (err) {
    return {
      found: false,
      reason: 'upstream_error',
      hint: 'The Federal Register API did not respond. Try again shortly.',
      detail: err instanceof Error ? err.message : String(err),
    } satisfies ToolResult;
  }

  const groups = new Map<string, OrderGroup>();
  let noticeCount = 0;

  for (const row of raw) {
    const title = asString(row.title);
    const parsed = parseOrderTitle(title);
    if (!parsed) continue; // not order-shaped — administrative review, scope ruling, court remand, etc.

    // Country filter: re-derive from the TITLE, never trust the search term —
    // full-text search on "China" happily returns notices about Japan.
    let matchedCountries = parsed.countries;
    if (country) {
      const hit = countryMatches(country, parsed.countries);
      if (!hit) continue;
      matchedCountries = [hit];
    }

    noticeCount += 1;
    const docketIds = row.docket_ids;
    const caseNumbers = extractCaseNumbers(docketIds);
    const noticeOrderType = orderTypeFromCaseNumbers(caseNumbers) ?? parsed.orderType;
    const pubDate = asString(row.publication_date);
    const docNumber = asString(row.document_number);
    const url = asString(row.html_url);

    for (const c of matchedCountries) {
      const key = `${productKey(parsed.product)}|${c.toLowerCase()}`;
      const notice: OrderNoticeRow = {
        action: parsed.action,
        order_type: noticeOrderType,
        publication_date: pubDate,
        document_number: docNumber,
        federal_register_url: url,
        title,
        case_numbers: caseNumbers,
      };
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          product: parsed.product,
          country: c,
          status: statusFromAction(parsed.action),
          order_type: noticeOrderType,
          case_numbers: caseNumbers,
          latest_action: parsed.action,
          latest_publication_date: pubDate,
          notices: [notice],
        });
      } else {
        existing.notices.push(notice);
        for (const cn of caseNumbers) {
          if (!existing.case_numbers.includes(cn)) existing.case_numbers.push(cn);
        }
      }
    }
  }

  const groupList = [...groups.values()]
    .sort((a, b) => (a.latest_publication_date < b.latest_publication_date ? 1 : -1))
    .slice(0, limit)
    .map((g) => ({
      ...g,
      // Recompute from the FULL accumulated case-number set once every notice
      // in the group has been seen — a group assembled from several notices
      // (e.g. separate AD and CVD continuation filings) may only reveal it
      // covers both once later, older notices are folded in.
      order_type: orderTypeFromCaseNumbers(g.case_numbers) ?? g.order_type,
      notices: g.notices.slice(0, 10),
    }));

  const result: ToolResult = {
    found: groupList.length > 0,
    query: { product: product || null, country: country || null, hts: hts || null },
    order_notice_count: noticeCount,
    group_count: groupList.length,
    groups: groupList,
    source: 'Federal Register notices from the International Trade Administration (federalregister.gov)',
    // Without this the caller reads a short list as "these are all the orders",
    // which for a country query understates reality by two orders of magnitude
    // — China alone has hundreds of orders in place. This searches the most
    // recent matching notices, so it reports recent order ACTIVITY.
    coverage_note:
      `Assembled from the ${raw.length} most recent Federal Register notices matching this query, newest first — this is recent AD/CVD order activity, not a complete census of every order in place. A country can have hundreds of active orders while this returns only those with recent order, continuation, or revocation notices. Narrow with a product term to surface a specific order, and treat an absence here as "no recent notice found", not as "no order exists".`,
    // Scope language governs whether or not the caller passed an HTS code, so
    // this caveat is unconditional.
    scope_note:
      'The legally binding scope of an AD/CVD order is the SCOPE LANGUAGE in the order text (federal_register_url), not any HTS number. HTS codes in these notices are advisory cross-references: merchandise can be in scope under an HTS code that looks unrelated, or out of scope under one that looks like a match. Never conclude "not covered" from an HTS miss.',
  };

  if (groupList.length === 0) {
    return {
      found: false,
      reason: 'no_matching_orders',
      hint:
        'No AD/CVD order-status notices matched. Try a broader product term, drop the country filter, or check spelling — country matching is forgiving ("China" matches "the People’s Republic of China") but the product term is matched against Federal Register full text.',
      query: result.query,
    } satisfies ToolResult;
  }

  return result;
}

// ── adcvd_case ───────────────────────────────────────────────────────

function caseNumberPattern(caseNumber: string): RegExp {
  const escaped = caseNumber.trim().toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`);
}

async function adcvdCase(args: Record<string, unknown>): Promise<unknown> {
  const caseNumber = typeof args.case_number === 'string' ? args.case_number.trim() : '';
  const documentNumber = typeof args.document_number === 'string' ? args.document_number.trim() : '';

  if (!caseNumber && !documentNumber) {
    return {
      found: false,
      reason: 'user_error',
      hint: 'Pass "case_number" (e.g. "A-570-979" or "C-570-980") or "document_number" (a Federal Register document number, e.g. "2026-16033").',
    } satisfies ToolResult;
  }

  if (!/^[AC]-\d{3}-\d{3}$/i.test(caseNumber) && caseNumber) {
    return {
      found: false,
      reason: 'invalid_case_number',
      hint: `"${caseNumber}" doesn't match the AD/CVD case-number shape: a letter (A = antidumping, C = countervailing), a 3-digit country code, a 3-digit case code — e.g. "A-570-979".`,
    } satisfies ToolResult;
  }

  if (documentNumber) {
    let doc: Record<string, unknown> | null;
    try {
      doc = await getDocument(documentNumber);
    } catch (err) {
      return {
        found: false,
        reason: 'upstream_error',
        hint: 'The Federal Register API did not respond. Try again shortly.',
        detail: err instanceof Error ? err.message : String(err),
      } satisfies ToolResult;
    }
    if (!doc) {
      return {
        found: false,
        reason: 'not_found',
        hint: `No Federal Register document "${documentNumber}" found.`,
      } satisfies ToolResult;
    }
    const caseNumbers = extractCaseNumbers(doc.docket_ids);
    return {
      found: true,
      lookup: 'document_number',
      document_number: asString(doc.document_number) || documentNumber,
      title: asString(doc.title),
      publication_date: asString(doc.publication_date),
      abstract: asString(doc.abstract),
      case_numbers: caseNumbers,
      federal_register_url: asString(doc.html_url),
      full_text_url: asString(doc.raw_text_url) || undefined,
    } satisfies ToolResult;
  }

  let raw: FrListResult[];
  try {
    raw = await searchDocuments(caseNumber, 100);
  } catch (err) {
    return {
      found: false,
      reason: 'upstream_error',
      hint: 'The Federal Register API did not respond. Try again shortly.',
      detail: err instanceof Error ? err.message : String(err),
    } satisfies ToolResult;
  }

  const pattern = caseNumberPattern(caseNumber);
  const matches = raw.filter((row) => {
    const joined = Array.isArray(row.docket_ids)
      ? row.docket_ids.filter((x): x is string => typeof x === 'string').join(', ')
      : '';
    return pattern.test(joined);
  });

  if (matches.length === 0) {
    return {
      found: false,
      reason: 'not_found',
      hint: `No Federal Register notices carry case number "${caseNumber.toUpperCase()}" in their docket_ids. Double-check the number, or try adcvd_orders with a product/country instead.`,
    } satisfies ToolResult;
  }

  const notices = matches.map((row) => ({
    document_number: asString(row.document_number),
    title: asString(row.title),
    publication_date: asString(row.publication_date),
    type: asString(row.type),
    abstract: asString(row.abstract),
    case_numbers: extractCaseNumbers(row.docket_ids),
    federal_register_url: asString(row.html_url),
  }));

  return {
    found: true,
    lookup: 'case_number',
    case_number: caseNumber.toUpperCase(),
    notice_count: notices.length,
    notices,
  } satisfies ToolResult;
}

// ── Tool defs ────────────────────────────────────────────────────────

// Tool DEFINITIONS for this module live in ./index.ts, in the single literal
// array the catalog/examples tooling can statically read. Handlers only here.
export async function callAdcvd(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'adcvd_orders':
      return adcvdOrders(args);
    case 'adcvd_case':
      return adcvdCase(args);
    default:
      return null;
  }
}
