/**
 * Tier 1b live smoke test.
 *
 * Exercises the four Tier 1b tool fixes (reroutes/reshapes) against the Pacifica
 * testnet, each as an independent case with its own PASS/FAIL. Exits non-zero if
 * any (non-skipped) case fails.
 *
 *   Case A  getOrderHistoryById  unsigned GET   reroute to /orders/history_by_id (+ old-path negative control)
 *   Case B  getPositionHistory   unsigned GET   reroute to /trades/history (envelope present)
 *   Case C  getPortfolioHistory  unsigned GET   required time_range (+ missing-field negative control)
 *   Case D  cancelOrder          signed POST    trimmed payload { symbol, order_id } + differential (NON-EXECUTING)
 *
 * The signing helpers come from scripts/signing-helpers.ts, which keeps a copy of
 * the src/index.ts signing scheme that is independent of the server (so this test
 * can catch a regression there). Keep that file in sync if the scheme changes.
 *
 * Case A runs fully unsigned (no creds). Cases B and C need ADDRESS and are
 * SKIPPED (not failed) if it is absent. Case D needs PRIVATE_KEY + ADDRESS and
 * is SKIPPED if creds are absent. Case D is non-executing by construction: it
 * only ever targets a deliberately bogus order id, so no extra opt-in gate is
 * needed.
 *
 * Run:  ADDRESS=... npm run smoke:1b
 *       PRIVATE_KEY=... ADDRESS=... npm run smoke:1b
 *   (PACIFICA_BASE_URL optional; defaults to testnet, same as the server.)
 */
import {
  BASE_URL, privateKey, address,
  signRequest, tamperSignature, get, post,
  looksLikeSignatureRejection, looksLikeDeserializeError, looksLikeNotFound,
  log, ok, no,
} from './signing-helpers.js';

// --- cases ------------------------------------------------------------------

// Case A: getOrderHistoryById reroute (unsigned GET, no creds needed).
// A1: NEW path /orders/history_by_id?order_id=N -> 200 success:true OR 404 "not
//     found" (both prove routing + param shape). FAIL on deserialize/route-404/405.
// A2: OLD path /orders/history?order_id=N (no account) -> MUST error (the general
//     history endpoint requires account), proving the old routing was broken.
const caseA = async (): Promise<boolean> => {
  log('\n=== Case A: getOrderHistoryById reroute (unsigned GET) ===');
  const ORDER_ID = 1;

  // A1: NEW path. A 404 "not found" is healthy (proves route resolves + param shape).
  const a1o = await get('/api/v1/orders/history_by_id', { order_id: ORDER_ID });
  log(`A1 new-path   status: ${a1o.status}  body: ${JSON.stringify(a1o.body).slice(0, 200)}`);
  const a1Success = a1o.status === 200 && a1o.body && a1o.body.success === true;
  const a1NotFound = looksLikeNotFound(a1o);
  // A route-not-found (404 from the router with no "not found" message) or a 405
  // would surface as a deserialize-unrelated error; we accept ONLY success or a
  // genuine "not found" body, and explicitly reject deserialize errors.
  const a1 = (a1Success || a1NotFound) && !looksLikeDeserializeError(a1o);

  // A2: OLD path with NO account -> MUST error (deserialize/missing-field or non-2xx).
  const a2o = await get('/api/v1/orders/history', { order_id: ORDER_ID });
  log(`A2 old-path   status: ${a2o.status}  body: ${JSON.stringify(a2o.body).slice(0, 200)}`);
  const a2Errored = looksLikeDeserializeError(a2o)
    || (typeof a2o.status === 'number' && a2o.status >= 400)
    || a2o.status === 'NETWORK_ERROR';
  const a2 = a2Errored;

  log(`  A1 new path 200/not-found, not deser? ${a1}  (want true)`);
  log(`  A2 old path errored (was broken)?     ${a2}  (want true)`);
  const pass = a1 && a2;
  log(pass ? ok('Case A PASS') : no('Case A FAIL'));
  return pass;
};

// Case B: getPositionHistory -> /trades/history (unsigned GET, needs ADDRESS).
// Envelope presence; data may be empty for an account with no fills.
const caseB = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case B: getPositionHistory -> /trades/history (unsigned GET) ===');
  if (!address) {
    log('SKIPPED (set ADDRESS to include)');
    return 'SKIP';
  }
  const o = await get('/api/v1/trades/history', { account: address, limit: 5 });
  log(`status: ${o.status}`);
  log(`body  : ${JSON.stringify(o.body).slice(0, 300)}`);
  const success = o.status === 200 && o.body && o.body.success === true;
  const hasData = success && Array.isArray(o.body.data) && o.body.data.length > 0;
  if (success && !hasData) log('note: success:true but data array empty (acceptable).');
  // If a timeout/504 surfaces (unrelated backend perf), log it clearly.
  if (!success) {
    const text = JSON.stringify(o.body).toLowerCase();
    if (o.status === 504 || /timed out|timeout/.test(text)) {
      log('note: response looks like a backend TIMEOUT (504/"timed out"), not a code defect.');
    }
  }
  log(success ? ok('Case B PASS') : no('Case B FAIL'));
  return success;
};

// Case C: getPortfolioHistory required time_range (unsigned GET, needs ADDRESS).
// C1: NEW shape ?account&time_range=7d -> 200 success:true (data may be empty).
// C2: negative control, OLD shape with NO time_range -> MUST be a deserialize /
//     missing-field error (proves time_range is genuinely required, Fix 3 matters).
const caseC = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case C: getPortfolioHistory required time_range (unsigned GET) ===');
  if (!address) {
    log('SKIPPED (set ADDRESS to include)');
    return 'SKIP';
  }

  // C1: correct NEW shape.
  const c1o = await get('/api/v1/portfolio', { account: address, time_range: '7d' });
  log(`C1 new-shape  status: ${c1o.status}  body: ${JSON.stringify(c1o.body).slice(0, 200)}`);
  const c1Success = c1o.status === 200 && c1o.body && c1o.body.success === true;
  const c1HasData = c1Success && Array.isArray(c1o.body.data) && c1o.body.data.length > 0;
  if (c1Success && !c1HasData) log('note: success:true but data array empty (acceptable).');
  const c1 = c1Success;

  // C2: negative control, OLD shape (missing time_range) -> MUST error.
  const c2o = await get('/api/v1/portfolio', { account: address, limit: 5 });
  log(`C2 no-range   status: ${c2o.status}  body: ${JSON.stringify(c2o.body).slice(0, 200)}`);
  const c2Errored = looksLikeDeserializeError(c2o)
    || (typeof c2o.status === 'number' && c2o.status >= 400);
  const c2 = c2Errored;

  log(`  C1 new shape success:true?        ${c1}  (want true)`);
  log(`  C2 missing time_range errored?    ${c2}  (want true)`);
  const pass = c1 && c2;
  log(pass ? ok('Case C PASS') : no('Case C FAIL'));
  return pass;
};

// Case D: cancelOrder trim (signed POST) -- NON-EXECUTING.
//
//  ===================  SAFETY  ===================
//  This case MUST NEVER cancel a real order. It targets a deliberately bogus,
//  almost-certainly-nonexistent order id (999999999999) with symbol "BTC".
//  Cancelling a nonexistent order is a no-op: the backend returns a business
//  "order not found"/"does not exist" response. The purpose is only to prove:
//    (a) the TRIMMED payload { symbol, order_id } (no tick_level/side)
//        DESERIALIZES, and
//    (b) the signature is ACCEPTED.
//  Do NOT lower the order id to a small value (e.g. 1) that might actually exist
//  on the account.
//  ================================================
const caseD = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case D: cancelOrder trim (signed POST, NON-EXECUTING) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }
  const PATH = '/api/v1/orders/cancel';
  const BOGUS_ORDER_ID = 999999999999; // intentionally nonexistent -> no-op

  // D1: correctly-signed, TRIMMED payload (no tick_level/side). MUST NOT be a
  //     signature rejection AND MUST NOT be a deserialize error. A business
  //     "order not found"/"does not exist" response is EXPECTED and counts as
  //     PASS -- it proves the trimmed payload deserialized and the sig was
  //     accepted.
  const good = signRequest('cancel_order', { symbol: 'BTC', order_id: BOGUS_ORDER_ID });
  const goodO = await post(PATH, good);
  log(`D1 correctly-signed  status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  const d1 = !looksLikeSignatureRejection(goodO) && !looksLikeDeserializeError(goodO);

  // D2: same payload, tampered signature -> MUST be a signature rejection.
  const bad = { ...good, signature: tamperSignature(good.signature) };
  const badO = await post(PATH, bad);
  log(`D2 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const d2 = looksLikeSignatureRejection(badO);

  log(`  D1 good not rejected (sig/deser)? ${d1}  (want true)`);
  log(`  D2 tampered is sig rejection?     ${d2}  (want true)`);
  const pass = d1 && d2;
  log(pass ? ok('Case D PASS') : no('Case D FAIL'));
  return pass;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Creds    : PRIVATE_KEY=${privateKey ? 'set' : 'MISSING'}  ADDRESS=${address ? 'set' : 'MISSING'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A getOrderHistoryById', await caseA()]);
  results.push(['B getPositionHistory', await caseB()]);
  results.push(['C getPortfolioHistory', await caseC()]);
  results.push(['D cancelOrder', await caseD()]);

  log('\n=== SUMMARY ===');
  let failed = 0;
  for (const [name, r] of results) {
    if (r === 'SKIP') log(`SKIP  ${name}`);
    else if (r) log(`PASS  ${name}`);
    else { log(`FAIL  ${name}`); failed++; }
  }
  log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed ? 1 : 0);
};

main();
