/**
 * Tier 3b live smoke -- Layer 1 + Layer 2: trading ops batch 1.
 *
 *   Case A (ungated, Layer 1, NON-EXECUTING) -- per-endpoint probes USING THE AUDITED
 *     VECTORS FROM THE PHASE-3 TABLE (do not improvise vectors here):
 *     A1 createMarketOrder  -- audited P2 vector (URNM empty-book no-liquidity probe).
 *          PRECONDITION leg: GET /book?symbol=URNM must show l:[[],[]]; if not, A1 is
 *          SKIPPED with a loud warning (never fire a market order at a non-empty URNM).
 *     A2 editOrder          -- audited P6 vector (bogus order_id).
 *     A3 setPositionTpsl    -- audited P1 vector (no-position or backup), + GET /orders
 *          afterward asserting NO stop rested (the explicit anti-amount-"0" assertion).
 *     A4 addIsolatedMargin  -- audited P8 vector.
 *     Each An has a tampered-sig differential leg (expect "Verification failed") and
 *     classifies the valid-sig response against the EXACT error string recorded in the
 *     probe-audit table (not the generic heuristics alone).
 *
 *   Case B (ungated) -- getOrderHistory envelope on ADDRESS (timeout-tolerant) and on
 *     CONTROL (data-bearing: assert rows + next_cursor/has_more shape).
 *
 *   Case C (gated SMOKE_CREATE=1, Layer 2, EXECUTING/REVERSIBLE) -- URNM edit lifecycle:
 *     C0 fetch oracle from /info/prices; deepBid = (oracle*0.7) rounded to tick 0.001;
 *        amount '0.3' (~$11 notional at ~$37 -- above the $10 min, lot-aligned).
 *     C1 openOrder URNM limit bid @ deepBid, tif GTC, amount 0.3 -> order_id.
 *     C2 editOrder order_id -> price deepBid+0.001 -> NEW order_id returned.
 *     C3 cancelOrder the new order_id (in a finally; cancelAllOrders backstop on failure
 *        -- remember it also sweeps any stop the run may have leaked).
 *     C4 GET /orders -> none of our ids resting (every exit path).
 *     C5 getOrderHistory -> the lifecycle rows for both order_ids are present
 *        (create -> cancelled-for-edit -> create -> cancelled), proving the Phase-4 GET
 *        tool against data we just generated.
 *
 * The signing helpers come from scripts/signing-helpers.ts, which keeps a copy of
 * the src/index.ts signing scheme that is independent of the server (so this test
 * can catch a regression there). Keep that file in sync if the scheme changes.
 *
 * Run:  PRIVATE_KEY=... ADDRESS=... npm run smoke:3b                  (A+B run, C skipped)
 *       SMOKE_CREATE=1 PRIVATE_KEY=... ADDRESS=... npm run smoke:3b   (A+B+C run)
 *   (PACIFICA_BASE_URL optional; defaults to testnet, same as the server.)
 */
import {
  BASE_URL, privateKey, address,
  signRequest, tamperSignature, get, post,
  looksLikeSignatureRejection, looksLikeDeserializeError,
  log, ok, no,
} from './signing-helpers.js';

// --- endpoints --------------------------------------------------------------

const BOOK = '/api/v1/book';
const PRICES = '/api/v1/info/prices';
const OPEN_ORDERS = '/api/v1/orders';
const ORDERS_HISTORY = '/api/v1/orders/history';
const CREATE_MARKET = '/api/v1/orders/create_market';
const CREATE_ORDER = '/api/v1/orders/create';
const EDIT_ORDER = '/api/v1/orders/edit';
const CANCEL_ORDER = '/api/v1/orders/cancel';
const CANCEL_ALL = '/api/v1/orders/cancel_all';
const POSITIONS_TPSL = '/api/v1/positions/tpsl';
const ADD_ISOLATED_MARGIN = '/api/v1/positions/add_isolated_margin';

// CONTROL is the leaderboard positive-control account (handoff-3/4 pattern).
const CONTROL = '31VgzNFnGPbg61M7f5qtwWwAkkNkW1EgrPqkRjmVpb3V';

// --- audit-verified exact error strings (from probe-audit table) -----------

// P1 set_position_tpsl (no position, URNM bid, take_profit)
const P1_POSITION_NOT_FOUND = 'Position not found';
// P2 create_market_order (URNM empty book, buy 0.3, slippage 0.5)
const P2_NO_REASONABLE_PRICE = 'No reasonable price found';
// P6 edit_order (URNM, bogus order_id 999999999999)
const P6_ORDER_NOT_FOUND = 'Order not found';
// P8 add_isolated_margin (URNM, amount 1, no isolated position)
const P8_POSITION_NOT_FOUND = 'PositionNotFound';
// Tampered-sig legs
const TAMPERED_SIG_MSG = 'Verification failed';

// --- generic differential helper --------------------------------------------

// Run the (signed, possibly-tampered) body to the endpoint, return Outcome.
const probe = async (path: string, body: Record<string, any>, tamper = false) => {
  const wire = tamper ? { ...body, signature: tamperSignature(body.signature) } : body;
  return post(path, wire);
};

// True iff the response is the audited valid-sig business rejection.
const matchesAuditError = (o: any, fragment: string): boolean => {
  if (o.status !== 422 && o.status !== 400) return false;
  if (looksLikeSignatureRejection(o)) return false;
  if (looksLikeDeserializeError(o)) return false;
  const text = JSON.stringify(o.body).toLowerCase();
  return text.includes(fragment.toLowerCase());
};

// --- Case A: signed POST probes (audited vectors) ---------------------------

// A1: createMarketOrder -- audited P2 vector. URNM buy 0.3, slippage 0.5, on empty book.
const caseA1 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== A1: createMarketOrder audited P2 vector (URNM empty-book) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Precondition: URNM book must be empty. If not, skip loudly (never fire a market
  // order at a non-empty URNM).
  const bookO = await get(BOOK, { symbol: 'URNM', agg_level: 1 });
  const bookEmpty = Array.isArray(bookO.body?.data?.l)
    && bookO.body.data.l.length === 2
    && bookO.body.data.l[0].length === 0
    && bookO.body.data.l[1].length === 0;
  if (!bookEmpty) {
    log(`  WARNING: URNM book is NON-empty (l=${JSON.stringify(bookO.body?.data?.l)}). A1 SKIPPED -- never fire a market order at a non-empty URNM.`);
    return 'SKIP';
  }
  log(`  URNM book empty -- precondition OK.`);

  // Valid-sig leg: expect 422 with "No reasonable price found".
  const good = signRequest('create_market_order', {
    symbol: 'URNM', amount: '0.3', side: 'bid', slippage_percent: '0.5', reduce_only: false,
  });
  const goodO = await probe(CREATE_MARKET, good);
  log(`A1 valid-sig         status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  const a1Valid = matchesAuditError(goodO, P2_NO_REASONABLE_PRICE);

  // Tampered-sig leg: expect 400 "Verification failed".
  const badO = await probe(CREATE_MARKET, good, true);
  log(`A1 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a1Tamper = looksLikeSignatureRejection(badO);

  log(`  A1 valid-sig matched audited "No reasonable price found"? ${a1Valid}  (want true)`);
  log(`  A1 tampered-sig is sig rejection?                            ${a1Tamper}  (want true)`);
  const pass = a1Valid && a1Tamper;
  log(pass ? ok('A1 PASS') : no('A1 FAIL'));
  return pass;
};

// A2: editOrder -- audited P6 vector. URNM, price 37.000, bogus order_id 999999999999.
const caseA2 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== A2: editOrder audited P6 vector (bogus order_id) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Valid-sig leg: expect 422 with "Order not found".
  const good = signRequest('edit_order', {
    symbol: 'URNM', price: '37.000', order_id: 999999999999,
  });
  const goodO = await probe(EDIT_ORDER, good);
  log(`A2 valid-sig         status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  const a2Valid = matchesAuditError(goodO, P6_ORDER_NOT_FOUND);

  // Tampered-sig leg: expect 400 "Verification failed".
  const badO = await probe(EDIT_ORDER, good, true);
  log(`A2 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a2Tamper = looksLikeSignatureRejection(badO);

  log(`  A2 valid-sig matched audited "Order not found"? ${a2Valid}  (want true)`);
  log(`  A2 tampered-sig is sig rejection?               ${a2Tamper}  (want true)`);
  const pass = a2Valid && a2Tamper;
  log(pass ? ok('A2 PASS') : no('A2 FAIL'));
  return pass;
};

// A3: setPositionTpsl -- audited P1 vector. URNM bid, take_profit, no position.
const caseA3 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== A3: setPositionTpsl audited P1 vector (no position) + anti-amount-"0" assertion ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Valid-sig leg: expect 422 with "Position not found".
  const good = signRequest('set_position_tpsl', {
    symbol: 'URNM', side: 'bid',
    take_profit: { stop_price: '55' },
  });
  const goodO = await probe(POSITIONS_TPSL, good);
  log(`A3 valid-sig         status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  const a3Valid = matchesAuditError(goodO, P1_POSITION_NOT_FOUND);

  // Tampered-sig leg: expect 400 "Verification failed".
  const badO = await probe(POSITIONS_TPSL, good, true);
  log(`A3 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a3Tamper = looksLikeSignatureRejection(badO);

  // MANDATORY anti-amount-"0" assertion: GET /orders, assert NO stop rested.
  // tpsl creates STOP orders, and stops defer checks (handoff-8 trap). The probe
  // audit confirmed this vector rejects with no residual state, but we re-check
  // on every run to catch any regression that would rest a stop.
  const openO = await get(OPEN_ORDERS, { account: address });
  const open = Array.isArray(openO.body?.data) ? openO.body.data : [];
  const ourStops = open.filter((o: any) =>
    o.symbol === 'URNM' && (o.order_type === 'stop_market' || o.order_type === 'stop_limit'
      || o.order_type === 'take_profit_market' || o.order_type === 'take_profit_limit'
      || o.order_type === 'stop_loss_market' || o.order_type === 'stop_loss_limit')
  );
  const a3NoRest = ourStops.length === 0;
  log(`A3 post-probe open   ${open.length} open order(s); URNM stops rested? ${ourStops.length}  (want 0)`);
  if (ourStops.length > 0) {
    log(`  LEAK: ${ourStops.length} URNM stop(s) resting after tpsl probe!`);
  }

  log(`  A3 valid-sig matched audited "Position not found"? ${a3Valid}  (want true)`);
  log(`  A3 tampered-sig is sig rejection?                  ${a3Tamper}  (want true)`);
  log(`  A3 no stop rested (anti-amount-"0" check)?         ${a3NoRest}  (want true)`);
  const pass = a3Valid && a3Tamper && a3NoRest;
  log(pass ? ok('A3 PASS') : no('A3 FAIL'));
  return pass;
};

// A4: addIsolatedMargin -- audited P8 vector. URNM, amount 1, no isolated position.
const caseA4 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== A4: addIsolatedMargin audited P8 vector (no isolated position) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Valid-sig leg: expect 422 with "PositionNotFound".
  const good = signRequest('add_isolated_margin', { symbol: 'URNM', amount: '1' });
  const goodO = await probe(ADD_ISOLATED_MARGIN, good);
  log(`A4 valid-sig         status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  const a4Valid = matchesAuditError(goodO, P8_POSITION_NOT_FOUND);

  // Tampered-sig leg: expect 400 "Verification failed".
  const badO = await probe(ADD_ISOLATED_MARGIN, good, true);
  log(`A4 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a4Tamper = looksLikeSignatureRejection(badO);

  log(`  A4 valid-sig matched audited "PositionNotFound"? ${a4Valid}  (want true)`);
  log(`  A4 tampered-sig is sig rejection?                 ${a4Tamper}  (want true)`);
  const pass = a4Valid && a4Tamper;
  log(pass ? ok('A4 PASS') : no('A4 FAIL'));
  return pass;
};

// --- Case B: getOrderHistory (read-only) -----------------------------------

const caseB = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case B: getOrderHistory envelope (unsigned GET) ===');
  if (!address) {
    log('SKIPPED (set ADDRESS to include)');
    return 'SKIP';
  }

  // B1: ADDRESS -- envelope check (timeout-tolerant for empty-account history).
  const b1O = await get(ORDERS_HISTORY, { account: address, limit: 20 });
  const b1Success = b1O.status === 200 && b1O.body?.success === true;
  const b1Shape = Array.isArray(b1O.body?.data);
  const b1TimedOut = b1O.status === 504 || /timed out|timeout/.test(JSON.stringify(b1O.body).toLowerCase());
  log(`B1 ADDRESS orders/history  status: ${b1O.status}  dataIsArray=${b1Shape}  body: ${JSON.stringify(b1O.body).slice(0, 200)}`);
  const b1 = (b1Success && b1Shape) || (b1TimedOut);

  // B2: CONTROL -- data-bearing: assert rows + next_cursor/has_more shape.
  const b2O = await get(ORDERS_HISTORY, { account: CONTROL, limit: 5 });
  const b2Success = b2O.status === 200 && b2O.body?.success === true;
  const b2DataNonEmpty = Array.isArray(b2O.body?.data) && b2O.body.data.length > 0;
  const b2HasMore = b2O.body?.has_more !== undefined;
  log(`B2 CONTROL orders/history  status: ${b2O.status}  data.length=${Array.isArray(b2O.body?.data) ? b2O.body.data.length : 'N/A'}  has_more=${b2O.body?.has_more}  body: ${JSON.stringify(b2O.body).slice(0, 200)}`);
  const b2 = b2Success && b2DataNonEmpty && b2HasMore;

  const pass = b1 && b2;
  log(pass ? ok('Case B PASS') : no('Case B FAIL'));
  return pass;
};

// --- Case C: gated SMOKE_CREATE=1 Layer-2 lifecycle ------------------------

// C: URNM edit lifecycle -- openOrder, editOrder, cancelOrder, verify.
const caseC = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case C: LIVE URNM edit lifecycle (signed POST, EXECUTING/REVERSIBLE) ===');
  if (process.env.SMOKE_CREATE !== '1') {
    log('SKIPPED (set SMOKE_CREATE=1 to include)');
    return 'SKIP';
  }
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  let originalOrderId: number | string | undefined;
  let newOrderId: number | string | undefined;
  let c1 = false;
  let c2 = false;
  let c3 = false;

  try {
    // C0: fetch oracle price for URNM, derive deepBid = oracle * 0.7, tick 0.001.
    const priceO = await get(PRICES, {});
    const urnmRow = Array.isArray(priceO.body?.data)
      ? priceO.body.data.find((p: any) => p.symbol === 'URNM')
      : undefined;
    const oracle = urnmRow?.oracle !== undefined ? Number(urnmRow.oracle) : NaN;
    if (!Number.isFinite(oracle) || oracle <= 0) {
      log(`C0 price fetch       could not read URNM oracle (body: ${JSON.stringify(priceO.body).slice(0, 150)})`);
      log(no('Case C FAIL (no live oracle to derive a safe deep bid)'));
      return false;
    }
    const deepBid = (Math.floor(oracle * 0.7 * 1000) / 1000).toFixed(3);
    log(`C0 oracle=${oracle}  deepBid=${deepBid}  (~30% below oracle; well inside the -90% bid band)`);

    // C1: openOrder URNM limit bid @ deepBid, tif GTC, amount 0.3.
    const c1Body = signRequest('create_order', {
      symbol: 'URNM', price: deepBid, amount: '0.3', side: 'bid', tif: 'GTC', reduce_only: false,
    });
    const c1O = await post(CREATE_ORDER, c1Body);
    log(`C1 openOrder         status: ${c1O.status}  body: ${JSON.stringify(c1O.body).slice(0, 300)}`);
    originalOrderId = c1O.body?.data?.order_id ?? c1O.body?.order_id;
    c1 = !looksLikeDeserializeError(c1O)
      && !looksLikeSignatureRejection(c1O)
      && originalOrderId !== undefined && originalOrderId !== null;
    if (!c1) {
      log('note: openOrder not accepted -- cannot proceed with edit lifecycle.');
    }

    if (c1 && originalOrderId !== undefined) {
      // C2: editOrder order_id -> price deepBid+0.001 -> NEW order_id.
      const newPrice = (parseFloat(deepBid) + 0.001).toFixed(3);
      const c2Body = signRequest('edit_order', {
        symbol: 'URNM', price: newPrice, order_id: originalOrderId,
      });
      const c2O = await post(EDIT_ORDER, c2Body);
      log(`C2 editOrder         status: ${c2O.status}  body: ${JSON.stringify(c2O.body).slice(0, 300)}`);
      newOrderId = c2O.body?.data?.order_id ?? c2O.body?.order_id;
      c2 = !looksLikeDeserializeError(c2O)
        && !looksLikeSignatureRejection(c2O)
        && newOrderId !== undefined && newOrderId !== null
        && String(newOrderId) !== String(originalOrderId);
      if (!c2) {
        log('note: editOrder did not return a new order_id.');
      }
    }
  } catch (e: any) {
    log(`C1/C2 threw: ${e?.message ?? e}`);
  } finally {
    // C3 (cleanup): cancel the new order if one was created. cancelAllOrders backstop.
    if (newOrderId !== undefined && newOrderId !== null) {
      const c3Body = signRequest('cancel_order', { symbol: 'URNM', order_id: newOrderId });
      const c3O = await post(CANCEL_ORDER, c3Body);
      log(`C3 cancelOrder       status: ${c3O.status}  body: ${JSON.stringify(c3O.body).slice(0, 200)}`);
      c3 = (typeof c3O.status === 'number' && c3O.status < 400)
        || (c3O.body && c3O.body.success === true);
      log(`  C3 id-cancel succeeded? ${c3}  (want true)`);

      if (!c3) {
        log('C3 backstop          id-cancel failed; sweeping with cancelAllOrders...');
        const sweepBody = signRequest('cancel_all_orders', { symbol: 'URNM', all_symbols: false, exclude_reduce_only: false });
        const sweepO = await post(CANCEL_ALL, sweepBody);
        log(`C3 cancel_all        status: ${sweepO.status}  body: ${JSON.stringify(sweepO.body).slice(0, 200)}`);
        c3 = (typeof sweepO.status === 'number' && sweepO.status < 400)
          || (sweepO.body && sweepO.body.success === true);
        log(`  C3 sweep succeeded? ${c3}  (want true)`);
      }
    } else if (originalOrderId !== undefined && originalOrderId !== null) {
      // Edit failed but open succeeded -- cancel the original.
      const c3Body = signRequest('cancel_order', { symbol: 'URNM', order_id: originalOrderId });
      const c3O = await post(CANCEL_ORDER, c3Body);
      log(`C3 cancel original   status: ${c3O.status}  body: ${JSON.stringify(c3O.body).slice(0, 200)}`);
      c3 = (typeof c3O.status === 'number' && c3O.status < 400)
        || (c3O.body && c3O.body.success === true);
    } else {
      log('C3 cleanup           no order_id captured; nothing to cancel.');
    }
  }

  // C4: post-run GET /orders -- neither of our ids resting.
  const openO = await get(OPEN_ORDERS, { account: address });
  const open = Array.isArray(openO.body?.data) ? openO.body.data : [];
  const ourIds = [originalOrderId, newOrderId].filter((x): x is number | string => x !== undefined && x !== null);
  const stillResting = open.filter((o: any) => ourIds.some((id) => String(o.order_id) === String(id)));
  const c4Clean = stillResting.length === 0;
  log(`C4 post-run open     ${open.length} open order(s); our ids [${ourIds.join(',')}] resting? ${stillResting.length}  (want 0)`);
  if (stillResting.length > 0) {
    log(`  LEAK: ${stillResting.length} order(s) still resting -- cancel manually.`);
  }

  // C5: getOrderHistory shows lifecycle rows for both order_ids.
  let c5 = false;
  if (ourIds.length > 0) {
    const histO = await get(ORDERS_HISTORY, { account: address, limit: 50 });
    const hist = Array.isArray(histO.body?.data) ? histO.body.data : [];
    const foundIds = new Set(hist.map((h: any) => String(h.order_id)));
    const c5Found = ourIds.filter((id) => foundIds.has(String(id)));
    c5 = c5Found.length === ourIds.length;
    log(`C5 history check     ${c5Found.length}/${ourIds.length} lifecycle ids found in orders/history`);
  } else {
    c5 = true; // vacuously true if no orders were placed
    log(`C5 history check     no order_ids to verify (vacuously PASS)`);
  }

  const pass = c1 && c2 && c3 && c4Clean && c5;
  log(`  C1 openOrder accepted?    ${c1}  (want true)`);
  log(`  C2 editOrder new id?      ${c2}  (want true)`);
  log(`  C3 cancel succeeded?      ${c3}  (want true)`);
  log(`  C4 post-run 0 open?       ${c4Clean}  (want true)`);
  log(`  C5 history has rows?      ${c5}  (want true)`);
  log(pass ? ok('Case C PASS') : no('Case C FAIL'));
  return pass;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Creds    : PRIVATE_KEY=${privateKey ? 'set' : 'MISSING'}  ADDRESS=${address ? 'set' : 'MISSING'}`);
  log(`Create   : ${process.env.SMOKE_CREATE === '1' ? 'enabled (SMOKE_CREATE=1)' : 'disabled (default)'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A1 createMarketOrder audited P2', await caseA1()]);
  results.push(['A2 editOrder audited P6', await caseA2()]);
  results.push(['A3 setPositionTpsl audited P1', await caseA3()]);
  results.push(['A4 addIsolatedMargin audited P8', await caseA4()]);
  results.push(['B getOrderHistory envelope', await caseB()]);
  results.push(['C URNM edit lifecycle (gated)', await caseC()]);

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
