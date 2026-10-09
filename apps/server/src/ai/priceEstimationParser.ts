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
