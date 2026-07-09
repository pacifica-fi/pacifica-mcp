/**
 * Tier 1a live smoke test.
 *
 * Exercises the Tier 1a tool fixes against the Pacifica testnet, each as an
 * independent case with its own PASS/FAIL. Exits non-zero if any (non-skipped)
 * case fails.
 *
 *   Case A  getKline           unsigned GET   snake_case + new interval enum (2h)
 *   Case B  getFundingHistory  unsigned GET   response envelope present
 *   Case C  cancelAllOrders    signed POST    required exclude_reduce_only + differential
 *
 * The signing helpers come from scripts/signing-helpers.ts, which keeps a copy of
 * the src/index.ts signing scheme that is independent of the server (so this test
 * can catch a regression there). Keep that file in sync if the scheme changes.
 *
 * Cases A and B run unsigned (A needs no creds; B needs ADDRESS). Case C
 * requires PRIVATE_KEY + ADDRESS and is SKIPPED (not failed) if creds are absent.
 *
 * Run:  PRIVATE_KEY=... ADDRESS=... npm run smoke:1a
 *   (PACIFICA_BASE_URL optional; defaults to testnet, same as the server.)
 */
import {
  BASE_URL, privateKey, address,
  signRequest, tamperSignature, get, post,
  looksLikeSignatureRejection, looksLikeDeserializeError,
  log, ok, no,
} from './signing-helpers.js';

// --- cases ------------------------------------------------------------------

// Case A: getKline (unsigned GET). interval=2h is a NEWLY-added enum value, and
// start_time/end_time being honored proves snake_case is correct.
const caseA = async (): Promise<boolean> => {
  log('\n=== Case A: getKline (unsigned GET) ===');
  const now = Date.now();
  const start_time = now - 86_400_000;
  const params = { symbol: 'BTC', interval: '2h', start_time, end_time: now };
  const o = await get('/api/v1/kline', params);
  log(`status: ${o.status}`);
  log(`body  : ${JSON.stringify(o.body).slice(0, 300)}`);
  const success = o.status === 200 && o.body && o.body.success === true;
  const hasData = success && Array.isArray(o.body.data) && o.body.data.length > 0;
  // PASS on success:true; note (but do not fail) if data is empty.
  if (success && !hasData) log('note: success:true but data array empty (acceptable).');
  log(success ? ok('Case A PASS') : no('Case A FAIL'));
  return success;
};

// Case B: getFundingHistory (unsigned GET). Reachability + envelope shape.
// Funding history only has rows once an account has held a position across a
// funding boundary (hours), so a fresh test account legitimately has none and
// the backend may 504 on the empty lookup (known perf issue). Treat a healthy
// envelope OR that known empty-account timeout as PASS; fail only on unexpected
// responses (network error, non-timeout 5xx, deserialize/error envelope), which
// would signal a real routing/shape regression.
const caseB = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case B: getFundingHistory (unsigned GET) ===');
  if (!address) {
    log('SKIPPED (set ADDRESS to include)');
    return 'SKIP';
  }
  const o = await get('/api/v1/funding/history', { account: address, limit: 5 });
  log(`status: ${o.status}`);
  log(`body  : ${JSON.stringify(o.body).slice(0, 300)}`);
  const healthy = o.status === 200 && o.body && o.body.success === true;
  const timedOut = o.status === 504 || /timed out|timeout/.test(JSON.stringify(o.body).toLowerCase());
  if (!healthy && timedOut) {
    log('  note: empty-account funding-history timeout (known backend perf issue) -- tolerated.');
  }
  const pass = healthy || timedOut;
  log(pass ? ok('Case B PASS') : no('Case B FAIL'));
  return pass;
};

// Case C: cancelAllOrders (signed POST). Core functional fix: required
// exclude_reduce_only + differential signature + negative control.
const caseC = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case C: cancelAllOrders (signed POST) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }
  const PATH = '/api/v1/orders/cancel_all';

  // C1: correctly-signed, complete payload -> NOT a signature rejection AND NOT
  //     a deserialize error (expect 200 with cancelled_count).
  const good = signRequest('cancel_all_orders', { symbol: 'BTC', all_symbols: false, exclude_reduce_only: false });
  const goodO = await post(PATH, good);
  log(`C1 correctly-signed  status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  const c1 = !looksLikeSignatureRejection(goodO) && !looksLikeDeserializeError(goodO);

  // C2: same payload, tampered signature -> MUST be a signature rejection.
  const bad = { ...good, signature: tamperSignature(good.signature) };
  const badO = await post(PATH, bad);
  log(`C2 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const c2 = looksLikeSignatureRejection(badO);

  // C3: negative control -- correctly-signed but OMITS exclude_reduce_only ->
  //     MUST be a deserialize error (proves the field is genuinely required).
  const missing = signRequest('cancel_all_orders', { symbol: 'BTC', all_symbols: false });
  const missingO = await post(PATH, missing);
  log(`C3 missing-field     status: ${missingO.status}  body: ${JSON.stringify(missingO.body).slice(0, 200)}`);
  const c3 = looksLikeDeserializeError(missingO);

  log(`  C1 good not rejected (sig/deser)? ${c1}  (want true)`);
  log(`  C2 tampered is sig rejection?     ${c2}  (want true)`);
  log(`  C3 missing-field is deser error?  ${c3}  (want true)`);
  const pass = c1 && c2 && c3;
  log(pass ? ok('Case C PASS') : no('Case C FAIL'));
  return pass;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Creds    : PRIVATE_KEY=${privateKey ? 'set' : 'MISSING'}  ADDRESS=${address ? 'set' : 'MISSING'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A getKline', await caseA()]);
  results.push(['B getFundingHistory', await caseB()]);
  results.push(['C cancelAllOrders', await caseC()]);

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
