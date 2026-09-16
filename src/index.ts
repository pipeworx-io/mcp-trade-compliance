interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Trade Compliance MCP — the two questions an importer asks that the tariff
 * schedule alone cannot answer:
 *
 *  1. "How has CBP classified this product before?" — CROSS ruling letters
 *     (rulings.cbp.gov), the classification precedent behind an HTS code.
 *  2. "Is there an antidumping or countervailing duty on this from that
 *     country?" — AD/CVD orders, from the Federal Register notices that
 *     impose, continue, and revoke them.
 *
 * Both are keyless live proxies. Sits next to `hts` (duty RATES) and
 * `census-trade`/`comtrade` (trade FLOWS); the forced-labor and restricted-
 * party side of import compliance lives in `sanctions-screening`, which
 * carries the DHS UFLPA Entity List.
 *
 * Scope caveat worth repeating because it is the field's most common error:
 * an AD/CVD order's reach is set by its SCOPE LANGUAGE, not by an HTS code.
 * HTS numbers in these notices are administrative aids. Never conclude a
 * product is outside an order because its HTS code is absent.
 *
 * NOTE ON LAYOUT: the tool DEFINITIONS live here as one literal array, while
 * the handlers live in ./cross.ts and ./adcvd.ts. That split is not
 * cosmetic — scripts/lib/pack-tools-runtime.mjs evaluates this file in a vm
 * whose require() refuses relative imports, so definitions reached through an
 * import are invisible to it and the pack lands in the catalog with
 * `tools: []`, taking check:examples and the website tool counts down with it.
 * Keep every tool def in this array.
 */

import { callCross } from './cross.js';
import { callAdcvd } from './adcvd.js';

const tools: McpToolExport['tools'] = [
  {
    name: 'cross_search',
    description:
      'Search CBP CROSS — the US Customs and Border Protection ruling letters database — for how Customs has classified a product before. Returns binding and informational ruling letters with ruling number, date, subject, HTS tariff numbers assigned, and whether the ruling was later modified or revoked. Use this to find tariff classification precedent for an import: what HTS code CBP assigned to a similar article, country-of-origin and marking determinations, USMCA/NAFTA eligibility rulings, and valuation rulings. Search by product description ("lithium ion battery pack", "cotton knit shirt"), by HTS code, or by ruling number.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Product description, HTS code, or ruling number, e.g. "lithium ion battery pack" or "8507.60".',
        },
        hts: {
          type: 'string',
          description: 'Optional HTS/tariff number to narrow the search, e.g. "8507.60.0020".',
        },
        since: {
          type: 'string',
          description: 'Only rulings issued on or after this date (YYYY-MM-DD).',
        },
        limit: { type: ['number', 'string'], description: 'Max rulings to return (1-50, default 20).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'cross_ruling',
    description:
      'Get one CBP CROSS customs ruling letter in full by its ruling number (e.g. "N305619" or "H301481", from cross_search). Returns the complete ruling text — the facts presented, CBP\'s classification analysis, and the holding — plus the HTS tariff numbers assigned, issue date, and the rulings it modifies, revokes, or is revoked by. Use this to read the actual reasoning behind a tariff classification precedent before relying on it for an entry.',
    inputSchema: {
      type: 'object',
      properties: {
        ruling_number: {
          type: 'string',
          description: 'CROSS ruling number, e.g. "N305619". Get one from cross_search.',
        },
        max_chars: {
          type: ['number', 'string'],
          description: 'Truncate the ruling text to this many characters (default 12000, max 60000). Ruling letters run long.',
        },
      },
      required: ['ruling_number'],
    },
  },
  {
    name: 'adcvd_orders',
    description:
      'US antidumping duty (AD) and countervailing duty (CVD) trade-remedy orders — is there an import duty order in place on a product from a country. Searches Federal Register / International Trade Administration notices for a product and/or country, resolves current status per product-country pair (in_place, in_place_revoked_in_part when Commerce revoked an order only for named companies or a carved-out subset, or revoked), and returns AD/CVD case numbers, order type (antidumping, countervailing, or both), and the governing Federal Register notice. Use for "is there an antidumping/countervailing duty order on X from Y", "AD/CVD case number for X", "trade remedy duties on imports of X from Y", "is the dumping order on X still in place". Country matching is forgiving (pass "China", not "the People\'s Republic of China"). If an HTS code is passed it is used only as a search hint — the ORDER SCOPE LANGUAGE, not any HTS number, governs what merchandise is actually covered, so an HTS mismatch never means "not covered".',
    inputSchema: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product keyword(s), e.g. "steel", "solar cells", "shrimp"' },
        country: { type: 'string', description: 'Country of origin, e.g. "China", "Vietnam", "South Korea" — plain names work' },
        hts: { type: 'string', description: 'Optional HTS/HS code as an additional search hint (advisory only — see description)' },
        limit: { type: ['number', 'string'], description: 'Max product/country groups to return (1-50, default 20)' },
      },
    },
  },
  {
    name: 'adcvd_case',
    description:
      'Look up a specific US antidumping/countervailing duty case by its case number (A-570-979 style: letter A=antidumping or C=countervailing, 3-digit country code, 3-digit case code) or by a Federal Register document number. Returns every Federal Register notice on file for that case with full abstract text and the FR URL — use after adcvd_orders when you already have the case number and need the underlying notices (initiation, order, continuation, revocation, amendments) in one place.',
    inputSchema: {
      type: 'object',
      properties: {
        case_number: { type: 'string', description: 'AD/CVD case number, e.g. "A-570-979" or "C-570-980"' },
        document_number: { type: 'string', description: 'Federal Register document number, e.g. "2026-16033" (alternative to case_number)' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const cross = await callCross(name, args);
    if (cross !== null) return cross;
    const adcvd = await callAdcvd(name, args);
    if (adcvd !== null) return adcvd;
    return { error: `Unknown tool: ${name}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      found: false,
      reason: 'upstream_error',
      message,
      hint: 'The upstream source (rulings.cbp.gov or federalregister.gov) did not answer. Both are US government sites with occasional outages — retry shortly. For duty RATES rather than rulings or trade-remedy orders, use hts_lookup.',
    };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
