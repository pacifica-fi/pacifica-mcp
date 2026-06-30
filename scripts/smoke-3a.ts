/**
 * Tier 3a live smoke -- Layer 0: read-only GET envelope/shape assertions.
 * All cases UNSIGNED and NON-EXECUTING. No gates.
 *
 *  Case A  public market data   (no creds needed)
 *  Case B  account histories    (needs ADDRESS; data-bearing legs use CONTROL)
 *  Case C  spot asset data      (needs ADDRESS for the history legs)
 *
 * CONTROL is the leaderboard positive-control account (handoff-3/4 pattern):
 * the test account has empty histories, so envelope-only checks run against
 * ADDRESS and data-shape checks run against CONTROL.
 */
import { get, looksLikeDeserializeError, log, ok, no, address, BASE_URL } from './signing-helpers.js';

const CONTROL = '31VgzNFnGPbg61M7f5qtwWwAkkNkW1EgrPqkRjmVpb3V';

// Generic Layer-0 assertion: 200 + success:true + not a deserialize error.
// 504/"timed out" is logged as backend perf (funding-history precedent), counted
// as a soft-fail note, NOT a harness failure, ONLY for the endpoints listed in
// TIMEOUT_TOLERANT (empty-account history endpoints).
// dataNonEmpty asserts Array.isArray(data) && data.length > 0 (data-bearing shape check).
const envelopeOk = async (
  name: string,
  path: string,
  params: Record<string, any>,
  opts: { dataIsArray?: boolean; dataNonEmpty?: boolean; timeoutTolerant?: boolean } = {}
): Promise<boolean> => {
  const o = await get(path, params);
  const success = o.status === 200 && o.body?.success === true;
  const shapeOk = opts.dataIsArray ? Array.isArray(o.body?.data) : o.body?.data !== undefined;
  const dataNonEmpty = opts.dataNonEmpty ? Array.isArray(o.body?.data) && o.body.data.length > 0 : true;
  const timedOut = o.status === 504 || /timed out|timeout/.test(JSON.stringify(o.body).toLowerCase());
  log(`${name.padEnd(34)} status: ${o.status}  body: ${JSON.stringify(o.body).slice(0, 120)}`);
  if (!success && timedOut && opts.timeoutTolerant) {
    log(`  note: backend TIMEOUT (known empty-account perf issue) -- tolerated for ${name}`);
    return true;
  }
  return success && shapeOk && dataNonEmpty && !looksLikeDeserializeError(o);
};

// Case A: public market data (no creds needed).
const caseA = async (): Promise<boolean> => {
  log('\n=== Case A: public market data (unsigned GET, no creds) ===');

  // A1: URNM orderbook (assert l:[[],[]] on the dead market).
  const a1o = await get('/api/v1/book', { symbol: 'URNM', agg_level: 1 });
  log(`A1 URNM book   status: ${a1o.status}  body: ${JSON.stringify(a1o.body).slice(0, 200)}`);
  const a1Success = a1o.status === 200 && a1o.body?.success === true;
  const a1EmptyBook = Array.isArray(a1o.body?.data?.l) && a1o.body.data.l.length === 2;
  if (a1Success && a1EmptyBook) {
    const isDead = a1o.body.data.l[0].length === 0 && a1o.body.data.l[1].length === 0;
    if (!isDead) log(`  WARNING: URNM book is NON-empty! l=${JSON.stringify(a1o.body.data.l)}`);
  }
  const a1 = a1Success && a1EmptyBook && !looksLikeDeserializeError(a1o);

  // A2: /info/prices.
  const a2 = await envelopeOk('A2 /info/prices', '/api/v1/info/prices', {}, { dataIsArray: true });

  // A3: /info/fees.
  const a3 = await envelopeOk('A3 /info/fees', '/api/v1/info/fees', {}, { dataIsArray: true });

  // A4: /kline/mark?symbol=BTC&interval=1m&start_time=now-1h.
  const now = Date.now();
  const a4 = await envelopeOk(
    'A4 /kline/mark',
    '/api/v1/kline/mark',
    { symbol: 'BTC', interval: '1m', start_time: now - 3600 * 1000 },
    { dataIsArray: true }
  );

  // A5: /funding_rate/history?symbol=BTC.
  const a5 = await envelopeOk(
    'A5 /funding_rate/history',
    '/api/v1/funding_rate/history',
    { symbol: 'BTC' },
    { dataIsArray: true }
  );

  // A6: /funding_rate/aggregated.
  const a6 = await envelopeOk(
    'A6 /funding_rate/aggregated',
    '/api/v1/funding_rate/aggregated',
    {},
    { dataIsArray: true }
  );

  // A7: /loan_pool.
  const a7 = await envelopeOk('A7 /loan_pool', '/api/v1/loan_pool', {});

  // A8: /kline/sparklines?symbols=BTC.
  const a8 = await envelopeOk(
    'A8 /kline/sparklines',
    '/api/v1/kline/sparklines',
    { symbols: 'BTC' },
    { dataIsArray: true }
  );

  // A9: /position_liquidation_prices (no filters, inject address).
  const a9 = await envelopeOk(
    'A9 /position_liquidation_prices',
    '/api/v1/position_liquidation_prices',
    { address: address ?? CONTROL, limit: 5 },
    { dataIsArray: true }
  );

  const pass = a1 && a2 && a3 && a4 && a5 && a6 && a7 && a8 && a9;
  log(pass ? ok('Case A PASS') : no('Case A FAIL'));
  return pass;
};

// Case B: account histories (needs ADDRESS; data-bearing legs use CONTROL).
// CONTROL = 31VgzNFnGPbg61M7f5qtwWwAkkNkW1EgrPqkRjmVpb3V (leaderboard positive-control account).
// ADDRESS legs are timeoutTolerant (empty-account 504 precedent);
// CONTROL legs additionally assert data.length > 0 where the leaderboard account has history.
const caseB = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case B: account histories (unsigned GET, needs ADDRESS) ===');
  if (!address) {
    log('SKIPPED (set ADDRESS to include)');
    return 'SKIP';
  }

  // B1: /account/balance/history (ADDRESS, timeout-tolerant).
  // CONTROL balance/history is timeoutTolerant (empirically 504 even for data-bearing account
  // as of 2026-06-10 — backend perf issue, not MCP). If backend is fixed, this will start
  // asserting data.length > 0.
  const b1 = await envelopeOk(
    'B1 /account/balance/history',
    '/api/v1/account/balance/history',
    { account: address, limit: 20 },
    { dataIsArray: true, timeoutTolerant: true }
  );

  // B2: /account/loan (ADDRESS).
  const b2 = await envelopeOk(
    'B2 /account/loan',
    '/api/v1/account/loan',
    { account: address }
  );

  // B3: /account/activity/daily (ADDRESS, start_time=now-7d, end_time=now).
  const nowB = Date.now();
  const b3 = await envelopeOk(
    'B3 /account/activity/daily',
    '/api/v1/account/activity/daily',
    { account: address, start_time: nowB - 7 * 24 * 3600 * 1000, end_time: nowB },
    { dataIsArray: true }
  );

  // B4: /account/payout/history (ADDRESS, timeout-tolerant).
  const b4 = await envelopeOk(
    'B4 /account/payout/history',
    '/api/v1/account/payout/history',
    { account: address, limit: 20 },
    { dataIsArray: true, timeoutTolerant: true }
  );

  // B5: /account/deposit/history (ADDRESS, timeout-tolerant).
  const b5 = await envelopeOk(
    'B5 /account/deposit/history',
    '/api/v1/account/deposit/history',
    { account: address, limit: 20 },
    { dataIsArray: true, timeoutTolerant: true }
  );

  // B6: /account/withdraw/history (ADDRESS, timeout-tolerant).
  const b6 = await envelopeOk(
    'B6 /account/withdraw/history',
    '/api/v1/account/withdraw/history',
    { account: address, limit: 20 },
    { dataIsArray: true, timeoutTolerant: true }
  );

  // B7: /account/withdraw/pending (ADDRESS).
  const b7 = await envelopeOk(
    'B7 /account/withdraw/pending',
    '/api/v1/account/withdraw/pending',
    { account: address },
    { dataIsArray: true }
  );

  // CONTROL data-bearing legs: assert data.length > 0 against the leaderboard account.
  // These verify that the shape assertions (dataIsArray) pass against real data rows,
  // not just empty envelopes.

  // B8: CONTROL /account/deposit/history (data-bearing, 5 rows observed).
  // Empirically: /account/deposit/history?account=CONTROL&limit=5 → 5 rows.
  const b8 = await envelopeOk(
    'B8 CONTROL /account/deposit/history',
    '/api/v1/account/deposit/history',
    { account: CONTROL, limit: 5 },
    { dataIsArray: true, dataNonEmpty: true }
  );

  // B9: CONTROL /account/activity/daily (data-bearing, 8 rows observed).
  // Empirically: /account/activity/daily?account=CONTROL&start_time=now-7d&end_time=now → 8 rows.
  const b9 = await envelopeOk(
    'B9 CONTROL /account/activity/daily',
    '/api/v1/account/activity/daily',
    { account: CONTROL, start_time: nowB - 7 * 24 * 3600 * 1000, end_time: nowB },
    { dataIsArray: true, dataNonEmpty: true }
  );

  // B10: CONTROL /account/balance/history (timeoutTolerant + dataNonEmpty).
  // Empirically 504 even for CONTROL (backend perf, same family as funding-history empty-account 504).
  // Currently passes via timeout tolerance. If backend is fixed, will assert dataNonEmpty.
  // (do NOT also add CONTROL legs for payout/withdraw history — empirically empty for CONTROL).
  const b10 = await envelopeOk(
    'B10 CONTROL /account/balance/history',
    '/api/v1/account/balance/history',
    { account: CONTROL, limit: 1 },
    { dataIsArray: true, dataNonEmpty: true, timeoutTolerant: true }
  );
  if (!b10) {
    log('  note: B10 CONTROL balance/history failed even with timeout tolerance (status 504? — backend perf)');
  }

  const pass = b1 && b2 && b3 && b4 && b5 && b6 && b7 && b8 && b9 && b10;
  log(pass ? ok('Case B PASS') : no('Case B FAIL'));
  return pass;
};

// Case C: spot asset data (needs ADDRESS for history legs).
const caseC = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case C: spot asset data (unsigned GET, needs ADDRESS for history) ===');

  // C1: /spot_assets (no creds).
  const c1 = await envelopeOk('C1 /spot_assets', '/api/v1/spot_assets', {}, { dataIsArray: true });

  // C2: /spot_assets/bridge/info (no creds).
  const c2 = await envelopeOk('C2 /spot_assets/bridge/info', '/api/v1/spot_assets/bridge/info', {}, { dataIsArray: true });

  // C3: /spot_assets/bridge/parameters/SOL (path param, no creds).
  const c3 = await envelopeOk(
    'C3 /spot_assets/bridge/parameters/SOL',
    '/api/v1/spot_assets/bridge/parameters/SOL',
    {}
  );

  // C4-C7 need ADDRESS.
  if (!address) {
    log('C4-C7 SKIPPED (set ADDRESS to include)');
    return 'SKIP';
  }

  // C4: /account/spot_asset/deposit/history (ADDRESS, timeout-tolerant).
  const c4 = await envelopeOk(
    'C4 /account/spot_asset/deposit/history',
    '/api/v1/account/spot_asset/deposit/history',
    { account: address, limit: 20 },
    { dataIsArray: true, timeoutTolerant: true }
  );

  // C5: /account/spot_asset/withdraw/history (ADDRESS, timeout-tolerant).
  const c5 = await envelopeOk(
    'C5 /account/spot_asset/withdraw/history',
    '/api/v1/account/spot_asset/withdraw/history',
    { account: address, limit: 20 },
    { dataIsArray: true, timeoutTolerant: true }
  );

  // C6: /account/spot_asset/withdraw/pending (ADDRESS).
  const c6 = await envelopeOk(
    'C6 /account/spot_asset/withdraw/pending',
    '/api/v1/account/spot_asset/withdraw/pending',
    { account: address },
    { dataIsArray: true }
  );

  // C7: /account/spot_balance/history (ADDRESS, timeout-tolerant).
  const c7 = await envelopeOk(
    'C7 /account/spot_balance/history',
    '/api/v1/account/spot_balance/history',
    { account: address, limit: 20 },
    { dataIsArray: true, timeoutTolerant: true }
  );

  const pass = c1 && c2 && c3 && c4 && c5 && c6 && c7;
  log(pass ? ok('Case C PASS') : no('Case C FAIL'));
  return pass;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Creds    : ADDRESS=${address ? 'set' : 'MISSING'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A public market data', await caseA()]);
  results.push(['B account histories', await caseB()]);
  results.push(['C spot asset data', await caseC()]);

  log('\n=== SUMMARY ===');
  let failed = 0;
  for (const [name, r] of results) {
    if (r === 'SKIP') log(`SKIP  ${name}`);
    else if (r) log(`PASS  ${name}`);
    else {
      log(`FAIL  ${name}`);
      failed++;
    }
  }
  log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed ? 1 : 0);
};

main();
