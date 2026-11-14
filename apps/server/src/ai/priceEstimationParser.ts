// Parses the model's raw stdout into a single confident price, or null
// (part-price-estimation feature T2). Unlike identificationParser.ts and
// catalogSourcingParser.ts, structural failure here is NOT fatal: this
// module's whole contract is "say so rather than guess" (see
// priceEstimationPrompt.ts's rule 4), so a refusal, a price range, "no
// price found", unparseable prose, or any other shape the model returns
// instead of a clean confident number is exactly as valid an answer as an
// explicit confident:false — all of them fall through to null rather than
// throwing. The only thing that ever produces a non-null result is a
// structurally valid {"confident":true,"priceUsd":<finite positive number>}
// response; every other case is logged at Warn (never Error — an honest "I
// don't know" is not a failure) and returns null. Never invents a number.
import type { PriceComp } from '@pc-parts-flipper/shared';
import { logger } from '../logger.js';
import { extractBracketedJson, stripCodeFence } from './identificationParser.js';

// Turns the model's response text into a parsed JSON value, or undefined
// when it carries no usable JSON at all. JSON.parse's SyntaxError is
// swallowed rather than rethrown: non-JSON prose (a plain-English refusal)
// is an expected, valid shape for this endpoint to receive, not a failure
// to restate as a 502.
//
// Two attempts, in order. The fence-stripped `text` is parsed directly,
// which covers a bare or fully-fenced payload. Only if that fails is the
// outermost `{...}` payload embedded in the ORIGINAL `rawStdout` extracted
// and parsed — bracket search is immune to whether a fence wraps the
// payload, so the original text is the right thing to search. That second
// attempt is the harden-ai-json-parsing fallback, identical in mechanism to
// identificationParser.ts's own: it recovers a real price the model already
// gave but buried inside incidental prose. A truncated payload (no closing
// brace to find) or a response with no JSON at all still comes back
// undefined, and still resolves to "no confident price".
function parseResponseJson(rawStdout: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fall through to the embedded-payload attempt below.
  }

  const extracted = extractBracketedJson(rawStdout, 'object');
  if (extracted === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(extracted);
  } catch {
    return undefined;
  }
}

/**
 * Parses the runner's raw stdout into a single confident used-resale price
 * estimate, or null when the model was not confident, returned a range,
 * answered in unparseable prose, or produced any other shape besides a
 * clean {"confident":true,"priceUsd":<number>}. Never throws, and never
 * returns an invented/guessed number: anything short of a structurally
 * valid, strictly positive, finite `priceUsd` paired with `confident:true`
 * is treated as "no confident price" and normalized to null.
 *
 * A response that embeds a complete, valid JSON object inside incidental
 * prose (a caveat sentence the model added despite the prompt's "no
 * commentary" instruction — live-observed as `"Original full-tower... $90
 * consistently.\n\n{\"confident\":true,\"priceUsd\":90.00}"`) is recovered
 * rather than thrown away as "no confident price": the direct parse is
 * tried first, and only on its failure is the outermost `{...}` payload
 * extracted from the ORIGINAL raw text and re-parsed. A response carrying
 * no JSON at all still resolves to null exactly as before — this only
 * recovers a real answer the model already gave.
 */
export function parsePriceEstimationResponse(rawStdout: string): number | null {
  const text = stripCodeFence(rawStdout);
  const parsed = parseResponseJson(rawStdout, text);

  if (typeof parsed !== 'object' || parsed === null) {
    logger.warn({ outputPreview: text.slice(0, 200) }, 'AI price estimation output was not valid JSON; treating as no confident price');
    return null;
  }

  // `in` narrowing rather than an inline cast: the parsed value is untrusted
  // model output, so the property is read as `unknown` and confirmed below.
  const confident: unknown = 'confident' in parsed ? parsed.confident : undefined;
  if (confident !== true) {
    // A model that honestly reports confident:false (or omits/misshapes the
    // field) is behaving correctly per the prompt's own instruction — no
    // warning needed, this is the expected "I don't know" path.
    return null;
  }

  const priceUsd: unknown = 'priceUsd' in parsed ? parsed.priceUsd : undefined;
  if (typeof priceUsd === 'number' && Number.isFinite(priceUsd) && priceUsd > 0) {
    return priceUsd;
  }

  // confident=true but priceUsd is malformed (missing, not a number,
  // non-finite, zero/negative) is a failure to deliver what was asked for —
  // coerce to null and log it, never trust an unverified number through.
  logger.warn(
    { priceUsd },
    'AI price estimation returned confident=true but with a malformed priceUsd field; treating as no confident price',
  );
  return null;
}

// Up to this many comps are kept, regardless of how many the model listed —
// enough to support the estimate without the response ballooning.
const MAX_PRICE_COMPS = 5;

// A comp with no usable title/url is not worth keeping — the UI links out to
// `url` directly, so a non-http(s) string or empty title would render a dead
// or unsafe link. Returns the validated {title, url} pair, or undefined when
// either is unusable.
function coerceCompIdentity(entry: object): { title: string; url: string } | undefined {
  const title: unknown = 'title' in entry ? entry.title : undefined;
  const url: unknown = 'url' in entry ? entry.url : undefined;
  const urlIsHttp = typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));

  if (typeof title !== 'string' || title.length === 0 || !urlIsHttp) {
    return undefined;
  }
  return { title, url: url as string };
}

// Coerces a comp entry's three optional fields together: `priceUsd` to a
// finite positive number or null (mirrors parsePriceEstimationResponse's own
// priceUsd check above — only a trustworthy number is kept, anything else
// becomes null rather than a silently-wrong figure), `condition` to a string
// or null, and `saleType` to one of the two allowed values or null. None of
// the three failing independently costs the comp its title/url — a comp
// with an unusable optional field is still worth keeping, just with that
// field nulled out.
function coerceCompFields(entry: object): Pick<PriceComp, 'priceUsd' | 'condition' | 'saleType'> {
  const rawPriceUsd: unknown = 'priceUsd' in entry ? entry.priceUsd : undefined;
  const rawCondition: unknown = 'condition' in entry ? entry.condition : undefined;
  const rawSaleType: unknown = 'saleType' in entry ? entry.saleType : undefined;

  return {
    priceUsd: typeof rawPriceUsd === 'number' && Number.isFinite(rawPriceUsd) && rawPriceUsd > 0 ? rawPriceUsd : null,
    condition: typeof rawCondition === 'string' ? rawCondition : null,
    saleType: rawSaleType === 'sold' || rawSaleType === 'listed' ? rawSaleType : null,
  };
}

/**
 * Parses the runner's raw stdout for the up-to-5 real comps the model cited
 * alongside its price estimate (pricing-comps feature T1) — a sibling to
 * parsePriceEstimationResponse above, which it does not call or affect.
 * Reuses the same two-attempt JSON recovery (direct parse of the
 * fence-stripped text, then the outermost `{...}` payload extracted from the
 * original raw text) since both functions read the same response object,
 * just different fields of it.
 *
 * Never throws: a missing or malformed `comps` array is the normal shape
 * when the model found no clean comps to cite (or answered with
 * confident:false), so this resolves to `[]` rather than failing the whole
 * response. Each entry is validated independently, mirroring
 * identificationParser.ts's coerceIdentityField style — `title` must be a
 * non-empty string and `url` a string starting with `http://`/`https://`
 * (the UI links out to it, so an unusable value is dropped rather than
 * passed through); `priceUsd` is coerced to a finite positive number or
 * null, `condition` to a string or null, `saleType` to 'sold'/'listed' or
 * null. An entry with no usable title/url is dropped with a Warn log; any
 * other malformed field on an otherwise-usable entry is coerced and kept
 * rather than dropping the whole comp. The result is capped at
 * MAX_PRICE_COMPS regardless of how many the model listed. `linkStatus` is
 * always set to null here — the model never reports it, and link-liveness
 * verification (pricing-comps feature T7) runs as a separate later pass.
 */
export function parsePriceComps(rawStdout: string): PriceComp[] {
  const text = stripCodeFence(rawStdout);
  const parsed = parseResponseJson(rawStdout, text);

  if (typeof parsed !== 'object' || parsed === null) {
    return [];
  }

  const rawComps: unknown = 'comps' in parsed ? parsed.comps : undefined;
  if (!Array.isArray(rawComps)) {
    return [];
  }

  const comps: PriceComp[] = [];
  for (const entry of rawComps) {
    if (comps.length >= MAX_PRICE_COMPS) {
      break;
    }
    if (typeof entry !== 'object' || entry === null) {
      logger.warn({ entry }, 'AI price estimation returned a malformed comp entry; dropping it');
      continue;
    }

    const identity = coerceCompIdentity(entry);
    if (identity === undefined) {
      logger.warn({ entry }, 'AI price estimation returned a comp with a missing/malformed title or url; dropping it');
      continue;
    }

    comps.push({ title: identity.title, url: identity.url, ...coerceCompFields(entry), linkStatus: null });
  }

  return comps;
}
