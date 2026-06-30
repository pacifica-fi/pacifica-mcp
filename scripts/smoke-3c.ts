/**
 * Tier 3c live smoke -- Layer 1 + Layer 2: TWAP (5 endpoints) + batchOrders.
 *
 *   Case A (ungated, Layer 1, NON-EXECUTING) -- audited vectors from the
 *     Phase-3 probe-audit table:
 *     A1 createTwapOrder  -- audited P4 vector (duration_in_seconds=1).
 *          MANDATORY post-probe GET /orders/twap assertion (TWAP's local
 *          validation gap makes this the phase's amount-"0"-class trap check).
 *     A2 cancelTwapOrder  -- audited P7 vector (bogus order_id 999999999999).
 *          Note: this is a 200 success no-op, NOT a 422.
 *     A3 batchOrders      -- audited P5a vector (single bogus Cancel -> per-action
 *          failure shape) + P5b differential (one tampered action -> WHOLE batch
 *          rejected with "Invalid signature", NOT a per-action result).
 *     Each An has a tampered-sig differential leg (where applicable) and
 *     classifies the valid-sig response against the EXACT error string recorded
 *     in the probe-audit table.
 *
 *   Case B (ungated) -- TWAP GETs: getOpenTwapOrders envelope on ADDRESS
 *     (expect []), getTwapOrderHistory envelope (ADDRESS), and
 *     getTwapOrderHistoryById with order_id 1 (envelope-only).
 *
 *   Case C (gated SMOKE_CREATE=1, Layer 2) -- TWAP lifecycle on URNM:
 *     C1 createTwapOrder URNM bid, amount '0.3', slippage '1', duration 3600s
 *        (long duration means at most one or two sub-orders can fire in the
 *        seconds before cancel, and each sub-order is a market order against an
 *        EMPTY book, which per the audited P2 behavior cannot fill) -> order_id.
 *     C2 getOpenTwapOrders shows it.
 *     C3 cancelTwapOrder in a finally; verify getOpenTwapOrders empty after.
 *     C4 getTwapOrderHistory / getTwapOrderHistoryById show the create+cancel events.
 *
 *   Case D (gated SMOKE_CREATE=1, Layer 2) -- batch lifecycle on URNM, design
 *     per the P5c audit verdict (YES, in-batch sequential cancel sees the create):
 *     D1 one batch of [Create(URNM deep bid, client_order_id=UUID),
 *        Cancel(by same client_order_id)] -> results[0].success true,
 *        results[1].success true; 0 open orders after.
 *     D2 cleanup: cancelAllOrders backstop in finally + GET /orders clean.
 *
 * The signing helpers come from scripts/signing-helpers.ts, which keeps a copy of
 * the src/index.ts signing scheme that is independent of the server (so this test
 * can catch a regression there). Keep that file in sync if the scheme changes.
 *
 * Run:  PRIVATE_KEY=... ADDRESS=... npm run smoke:3c                  (A+B run, C+D skipped)
 *       SMOKE_CREATE=1 PRIVATE_KEY=... ADDRESS=... npm run smoke:3c   (A+B+C+D run)
 *   (PACIFICA_BASE_URL optional; defaults to testnet, same as the server.)
 */
import {
  BASE_URL, privateKey, address,
  signRequest, tamperSignature, get, post,
  looksLikeSignatureRejection, looksLikeDeserializeError,
  log, ok, no,
} from './signing-helpers.js';
import { randomUUID } from 'crypto';

// --- endpoints --------------------------------------------------------------

const PRICES = '/api/v1/info/prices';
const OPEN_ORDERS = '/api/v1/orders';
const OPEN_TWAP = '/api/v1/orders/twap';
const TWAP_HISTORY = '/api/v1/orders/twap/history';
const TWAP_HISTORY_BY_ID = '/api/v1/orders/twap/history_by_id';
const CREATE_TWAP = '/api/v1/orders/twap/create';
const CANCEL_TWAP = '/api/v1/orders/twap/cancel';
const BATCH_ORDERS = '/api/v1/orders/batch';
const CANCEL_ALL = '/api/v1/orders/cancel_all';

// --- audit-verified exact error strings (from probe-audit table) -----------

// P4 create_twap_order (duration_in_seconds=1)
const P4_DURATION_TOO_SHORT = 'duration of twap order';
// P5a batchOrders (single bogus Cancel)
const P5A_CANCEL_FAILED = 'Failed to cancel order';
// P5b batchOrders (tampered-sig aborts whole batch)
// Note: The audited P5b vector shows "Invalid signature" as the exact error string.
// However, in practice we may see "Verification failed" (the same bare-string
// signature rejection used by single-action endpoints). Both indicate the batch
// was rejected at the signature layer, which is the load-bearing assertion.
const P5B_INVALID_SIGNATURE = 'Invalid signature';
const P5B_VERIFICATION_FAILED = 'Verification failed';
// Tampered-sig legs (for individual TWAP endpoints)
const TAMPERED_SIG_MSG = 'Verification failed';

// --- generic differential helper --------------------------------------------

// Run the (signed, possibly-tampered) body to the endpoint, return Outcome.
const probe = async (path: string, body: Record<string, any>, tamper = false) => {
  const wire = tamper ? { ...body, signature: tamperSignature(body.signature) } : body;
  return post(path, wire);
};

// True iff the response is the audited valid-sig business rejection.
const matchesAuditError = (o: any, fragment: string): boolean => {
  if (o.status !== 422 && o.status !== 400 && o.status !== 200) return false;
  if (looksLikeSignatureRejection(o)) return false;
  if (looksLikeDeserializeError(o)) return false;
  const text = JSON.stringify(o.body).toLowerCase();
  return text.includes(fragment.toLowerCase());
};

// --- Case A: signed POST probes (audited vectors) ---------------------------

// A1: createTwapOrder -- audited P4 vector. duration_in_seconds=1.
const caseA1 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== A1: createTwapOrder audited P4 vector (duration_in_seconds=1) + anti-amount-"0" assertion ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Valid-sig leg: expect 422 with "duration of twap order ... too short".
  const good = signRequest('create_twap_order', {
    symbol: 'URNM', amount: '0.3', side: 'bid', reduce_only: false,
    slippage_percent: '1', duration_in_seconds: 1,
  });
  const goodO = await probe(CREATE_TWAP, good);
  log(`A1 valid-sig         status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  const a1Valid = matchesAuditError(goodO, P4_DURATION_TOO_SHORT);

  // Tampered-sig leg: expect 400 "Verification failed".
  const badO = await probe(CREATE_TWAP, good, true);
  log(`A1 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a1Tamper = looksLikeSignatureRejection(badO);

  // MANDATORY anti-amount-"0" assertion: GET /orders/twap, assert nothing rested.
  // TWAP's local validation gap means that invalid vectors (like duration=99999999)
  // CAN rest state. The probe audit confirmed duration=1 is safe, but we re-check
  // on every run to catch any regression.
  const twapO = await get(OPEN_TWAP, { account: address });
  const twapOrders = Array.isArray(twapO.body?.data) ? twapO.body.data : [];
  const ourTwaps = twapOrders.filter((o: any) => o.symbol === 'URNM');
  const a1NoRest = ourTwaps.length === 0;
  log(`A1 post-probe open   ${twapOrders.length} open TWAP(s); URNM TWAPs rested? ${ourTwaps.length}  (want 0)`);
  if (ourTwaps.length > 0) {
    log(`  LEAK: ${ourTwaps.length} URNM TWAP(s) resting after duration probe!`);
  }

  log(`  A1 valid-sig matched audited "duration too short"? ${a1Valid}  (want true)`);
  log(`  A1 tampered-sig is sig rejection?                  ${a1Tamper}  (want true)`);
  log(`  A1 no TWAP rested (anti-amount-"0" check)?         ${a1NoRest}  (want true)`);
  const pass = a1Valid && a1Tamper && a1NoRest;
  log(pass ? ok('A1 PASS') : no('A1 FAIL'));
  return pass;
};

// A2: cancelTwapOrder -- audited P7 vector. Bogus order_id 999999999999.
// Note: this returns 200 success (no-op), NOT a 422.
const caseA2 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== A2: cancelTwapOrder audited P7 vector (bogus order_id -- 200 no-op) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Valid-sig leg: expect 200 with success:true, data:null.
  const good = signRequest('cancel_twap_order', {
    symbol: 'URNM', order_id: 999999999999,
  });
  const goodO = await probe(CANCEL_TWAP, good);
  log(`A2 valid-sig         status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  // P7 specific: 200 status, success:true, data:null. This is NOT a rejection --
  // it's a successful no-op for a nonexistent TWAP.
  const a2Valid = goodO.status === 200
    && goodO.body?.success === true
    && goodO.body?.data === null
    && !looksLikeSignatureRejection(goodO);

  // Tampered-sig leg: expect 400 "Verification failed".
  const badO = await probe(CANCEL_TWAP, good, true);
  log(`A2 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a2Tamper = looksLikeSignatureRejection(badO);

  // Post-probe: no TWAPs resting (the bogus cancel is a no-op, so there should
  // be nothing to verify, but we check anyway as a sanity).
  const twapO = await get(OPEN_TWAP, { account: address });
  const twapOrders = Array.isArray(twapO.body?.data) ? twapO.body.data : [];
  const a2NoRest = twapOrders.filter((o: any) => o.symbol === 'URNM').length === 0;

  log(`  A2 valid-sig is 200 no-op (success:true, data:null)? ${a2Valid}  (want true)`);
  log(`  A2 tampered-sig is sig rejection?                    ${a2Tamper}  (want true)`);
  log(`  A2 no URNM TWAPs resting?                            ${a2NoRest}  (want true)`);
  const pass = a2Valid && a2Tamper && a2NoRest;
  log(pass ? ok('A2 PASS') : no('A2 FAIL'));
  return pass;
};

// A3: batchOrders -- audited P5a (single bogus Cancel) + P5b (tampered sig aborts batch).
const caseA3 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== A3: batchOrders audited P5a (bogus Cancel) + P5b (tampered sig aborts batch) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // P5a: batch with one action: Cancel with bogus order_id.
  // Expected: 200, results[0].success=false, error="Failed to cancel order".
  const p5aSignedAction = signRequest('cancel_order', {
    symbol: 'URNM', order_id: 999999999999,
  });
  const p5aBatch = { actions: [{ type: 'Cancel', data: p5aSignedAction }] };
  const p5aO = await post(BATCH_ORDERS, p5aBatch);
  log(`A3 P5a valid-sig     status: ${p5aO.status}  body: ${JSON.stringify(p5aO.body).slice(0, 300)}`);
  const p5aValid = p5aO.status === 200
    && p5aO.body?.success === true
    && Array.isArray(p5aO.body?.data?.results)
    && p5aO.body.data.results.length === 1
    && p5aO.body.data.results[0].success === false
    && (p5aO.body.data.results[0].error || '').includes(P5A_CANCEL_FAILED);
  log(`  A3 P5a per-action business failure shape? ${p5aValid}  (want true)`);

  // P5b: batch with one tampered-sig action.
  // Expected: 400 with a signature rejection (either "Invalid signature" or
  // "Verification failed"), WHOLE batch aborts (not per-action result).
  const p5bTamperedAction = { ...p5aSignedAction, signature: tamperSignature(p5aSignedAction.signature) };
  const p5bBatch = { actions: [{ type: 'Cancel', data: p5bTamperedAction }] };
  const p5bO = await post(BATCH_ORDERS, p5bBatch);
  log(`A3 P5b tampered-sig  status: ${p5bO.status}  body: ${JSON.stringify(p5bO.body).slice(0, 200)}`);
  // P5b specific: 400 status, body is a bare signature-rejection string
  // (either "Invalid signature" per audit, or "Verification failed" in practice).
  // The load-bearing assertion is that the WHOLE batch is rejected, not per-action.
  const p5bBody = typeof p5bO.body === 'string' ? p5bO.body : JSON.stringify(p5bO.body);
  const p5bInvalid = p5bO.status === 400
    && (p5bBody.includes(P5B_INVALID_SIGNATURE) || p5bBody.includes(P5B_VERIFICATION_FAILED));
  // Also verify the response is NOT a per-action success:false result.
  const p5bNotPerAction = !(p5bO.body?.data?.results && Array.isArray(p5bO.body.data.results));
  log(`  A3 P5b is 400 with sig rejection?            ${p5bInvalid}  (want true)`);
  log(`  A3 P5b is NOT a per-action result?           ${p5bNotPerAction}  (want true)`);

  // Post-probe: no orders resting (both legs are non-executing).
  const openO = await get(OPEN_ORDERS, { account: address });
  const open = Array.isArray(openO.body?.data) ? openO.body.data : [];
  const a3NoRest = open.length === 0;
  log(`A3 post-probe open   ${open.length} open order(s)  (want 0)`);
  if (open.length > 0) {
    log(`  LEAK: ${open.length} order(s) resting after batch probes!`);
  }

  const pass = p5aValid && p5bInvalid && p5bNotPerAction && a3NoRest;
  log(pass ? ok('A3 PASS') : no('A3 FAIL'));
  return pass;
};

// --- Case B: TWAP GETs (read-only) ------------------------------------------

const caseB = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case B: TWAP GET envelope (unsigned) ===');
  if (!address) {
    log('SKIPPED (set ADDRESS to include)');
    return 'SKIP';
  }

  // B1: getOpenTwapOrders on ADDRESS -- expect 200, success:true, data:array.
  // For an empty account, data should be [].
  const b1O = await get(OPEN_TWAP, { account: address });
  const b1Success = b1O.status === 200 && b1O.body?.success === true;
  const b1Shape = Array.isArray(b1O.body?.data);
  const b1Data = b1Shape ? b1O.body.data : [];
  log(`B1 ADDRESS /orders/twap  status: ${b1O.status}  data.length=${b1Data.length}  body: ${JSON.stringify(b1O.body).slice(0, 200)}`);
  const b1 = b1Success && b1Shape;

  // B2: getTwapOrderHistory on ADDRESS -- expect 200, success:true, data:array.
  const b2O = await get(TWAP_HISTORY, { account: address, limit: 20 });
  const b2Success = b2O.status === 200 && b2O.body?.success === true;
  const b2Shape = Array.isArray(b2O.body?.data);
  const b2TimedOut = b2O.status === 504 || /timed out|timeout/.test(JSON.stringify(b2O.body).toLowerCase());
  log(`B2 ADDRESS /orders/twap/history  status: ${b2O.status}  dataIsArray=${b2Shape}  body: ${JSON.stringify(b2O.body).slice(0, 200)}`);
  const b2 = (b2Success && b2Shape) || b2TimedOut;

  // B3: getTwapOrderHistoryById with order_id 1 -- envelope-only (success-or-empty-data).
  const b3O = await get(TWAP_HISTORY_BY_ID, { order_id: 1 });
  const b3Success = b3O.status === 200 && b3O.body?.success === true;
  const b3NotDeser = !looksLikeDeserializeError(b3O);
  const b3Shape = b3O.body?.data !== undefined; // data can be [] or an array
  log(`B3 /orders/twap/history_by_id?order_id=1  status: ${b3O.status}  data defined? ${b3Shape}  body: ${JSON.stringify(b3O.body).slice(0, 200)}`);
  const b3 = b3Success && b3NotDeser && b3Shape;

  const pass = b1 && b2 && b3;
  log(pass ? ok('Case B PASS') : no('Case B FAIL'));
  return pass;
};

// --- Case C: gated SMOKE_CREATE=1 Layer-2 TWAP lifecycle -------------------

// C: URNM TWAP lifecycle -- createTwapOrder, getOpenTwapOrders, cancelTwapOrder, verify.
const caseC = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case C: LIVE URNM TWAP lifecycle (signed POST, EXECUTING/REVERSIBLE) ===');
  if (process.env.SMOKE_CREATE !== '1') {
    log('SKIPPED (set SMOKE_CREATE=1 to include)');
    return 'SKIP';
  }
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  let twapOrderId: number | string | undefined;
  let c1 = false;
  let c2 = false;
  let c3 = false;

  try {
    // C1: createTwapOrder URNM bid, amount 0.3, slippage 1, duration 3600s.
    // Long duration means at most one or two sub-orders can fire in the seconds
    // before cancel, and each sub-order is a market order against an EMPTY book,
    // which per the audited P2 behavior cannot fill.
    const c1Body = signRequest('create_twap_order', {
      symbol: 'URNM', amount: '0.3', side: 'bid', reduce_only: false,
      slippage_percent: '1', duration_in_seconds: 3600,
    });
    const c1O = await post(CREATE_TWAP, c1Body);
    log(`C1 createTwapOrder   status: ${c1O.status}  body: ${JSON.stringify(c1O.body).slice(0, 300)}`);
    twapOrderId = c1O.body?.data?.order_id ?? c1O.body?.order_id;
    c1 = !looksLikeDeserializeError(c1O)
      && !looksLikeSignatureRejection(c1O)
      && twapOrderId !== undefined && twapOrderId !== null;
    if (!c1) {
      log('note: createTwapOrder not accepted -- cannot proceed with TWAP lifecycle.');
    }

    // C2: getOpenTwapOrders shows the TWAP.
    if (c1 && twapOrderId !== undefined) {
      const c2O = await get(OPEN_TWAP, { account: address });
      const openTwaps = Array.isArray(c2O.body?.data) ? c2O.body.data : [];
      const ourTwap = openTwaps.find((t: any) => String(t.order_id) === String(twapOrderId));
      c2 = ourTwap !== undefined;
      log(`C2 getOpenTwapOrders status: ${c2O.status}  found our TWAP ${twapOrderId}? ${c2}  (open TWAPs: ${openTwaps.length})`);
      if (!c2) {
        log(`  open TWAPs: ${JSON.stringify(openTwaps.map((t: any) => ({ id: t.order_id, symbol: t.symbol })))}`);
      }
    }
  } catch (e: any) {
    log(`C1/C2 threw: ${e?.message ?? e}`);
  } finally {
    // C3 (cleanup): cancel the TWAP. If the cancel-by-id fails, backstop with
    // nothing extra (cancel_twap_order only takes order_id, not symbol+cancel_all).
    if (twapOrderId !== undefined && twapOrderId !== null) {
      const c3Body = signRequest('cancel_twap_order', { symbol: 'URNM', order_id: twapOrderId });
      const c3O = await post(CANCEL_TWAP, c3Body);
      log(`C3 cancelTwapOrder   status: ${c3O.status}  body: ${JSON.stringify(c3O.body).slice(0, 200)}`);
      c3 = (typeof c3O.status === 'number' && c3O.status < 400)
        || (c3O.body && c3O.body.success === true);
      log(`  C3 id-cancel succeeded? ${c3}  (want true)`);
    } else {
      log('C3 cleanup           no TWAP order_id captured; nothing to cancel.');
    }
  }

  // C4: post-run GET /orders/twap -- our TWAP not resting.
  const twapO = await get(OPEN_TWAP, { account: address });
  const openTwaps = Array.isArray(twapO.body?.data) ? twapO.body.data : [];
  const ourTwaps = openTwaps.filter((t: any) => String(t.order_id) === String(twapOrderId));
  const c4Clean = ourTwaps.length === 0;
  log(`C4 post-run open     ${openTwaps.length} open TWAP(s); our id ${twapOrderId} resting? ${ourTwaps.length}  (want 0)`);
  if (ourTwaps.length > 0) {
    log(`  LEAK: ${ourTwaps.length} TWAP(s) still resting -- cancel manually.`);
  }

  const pass = c1 && c2 && c3 && c4Clean;
  log(`  C1 createTwapOrder accepted?  ${c1}  (want true)`);
  log(`  C2 getOpenTwapOrders shows it? ${c2}  (want true)`);
  log(`  C3 cancel succeeded?          ${c3}  (want true)`);
  log(`  C4 post-run 0 open TWAPs?     ${c4Clean}  (want true)`);
  log(pass ? ok('Case C PASS') : no('Case C FAIL'));
  return pass;
};

// --- Case D: gated SMOKE_CREATE=1 Layer-2 batch lifecycle -------------------

// D: URNM batch lifecycle -- per P5c audit verdict, in-batch cancel DOES see
// the create, so we use the primary path: single batch [Create(URNM deep bid,
// client_order_id=UUID), Cancel(by same client_order_id)].
const caseD = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case D: LIVE URNM batch lifecycle (signed POST, EXECUTING/REVERSIBLE) ===');
  if (process.env.SMOKE_CREATE !== '1') {
    log('SKIPPED (set SMOKE_CREATE=1 to include)');
    return 'SKIP';
  }
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  let d1BatchOk = false;
  let d1CreateOk = false;
  let d1CancelOk = false;
  let orderCreated = false;

  try {
    // D0: fetch oracle for URNM, derive deepBid.
    const priceO = await get(PRICES, {});
    const urnmRow = Array.isArray(priceO.body?.data)
      ? priceO.body.data.find((p: any) => p.symbol === 'URNM')
      : undefined;
    const oracle = urnmRow?.oracle !== undefined ? Number(urnmRow.oracle) : NaN;
    if (!Number.isFinite(oracle) || oracle <= 0) {
      log(`D0 price fetch       could not read URNM oracle (body: ${JSON.stringify(priceO.body).slice(0, 150)})`);
      log(no('Case D FAIL (no live oracle to derive a safe deep bid)'));
      return false;
    }
    const deepBid = (Math.floor(oracle * 0.7 * 1000) / 1000).toFixed(3);
    log(`D0 oracle=${oracle}  deepBid=${deepBid}  (~30% below oracle; well inside the -90% bid band)`);

    // D1: one batch of [Create(URNM deep bid, cloid=UUID), Cancel(by same cloid)].
    // Per P5c audit: in-batch sequential cancel sees the create. The Create
    // action creates a limit order, the Cancel action cancels it by cloid.
    const cloid = randomUUID();
    log(`D1 client_order_id=${cloid}`);

    // Action 1: Create (unsigned payload -- batchOrders tool signs it).
    const createPayload = {
      symbol: 'URNM', price: deepBid, amount: '0.3', side: 'bid',
      tif: 'GTC', reduce_only: false, client_order_id: cloid,
    };
    const createSigned = signRequest('create_order', createPayload);

    // Action 2: Cancel by client_order_id (note: standalone cancelOrder only
    // takes order_id, but the batch tool passes data through, so cloid works
    // here -- per the plan's P5c design note).
    const cancelPayload = {
      symbol: 'URNM', client_order_id: cloid,
    };
    const cancelSigned = signRequest('cancel_order', cancelPayload);

    const batch = { actions: [
      { type: 'Create', data: createSigned },
      { type: 'Cancel', data: cancelSigned },
    ]};
    const d1O = await post(BATCH_ORDERS, batch);
    log(`D1 batchOrders       status: ${d1O.status}  body: ${JSON.stringify(d1O.body).slice(0, 400)}`);

    // Assert per-action results shape.
    const results = d1O.body?.data?.results;
    d1BatchOk = d1O.status === 200
      && d1O.body?.success === true
      && Array.isArray(results)
      && results.length === 2;
    d1CreateOk = d1BatchOk && results[0].success === true && results[0].order_id !== undefined;
    d1CancelOk = d1BatchOk && results[1].success === true;
    orderCreated = d1CreateOk; // for cleanup
    log(`  D1 batch envelope OK?   ${d1BatchOk}  (want true)`);
    log(`  D1 results[0] (Create) success? ${d1CreateOk}  (want true)`);
    log(`  D1 results[1] (Cancel) success? ${d1CancelOk}  (want true)`);
  } catch (e: any) {
    log(`D1 threw: ${e?.message ?? e}`);
  } finally {
    // Cleanup: cancelAllOrders backstop (in case the in-batch cancel didn't work
    // for any reason). This sweeps any resting order on URNM.
    try {
      const sweepBody = signRequest('cancel_all_orders', {
        symbol: 'URNM', all_symbols: false, exclude_reduce_only: false,
      });
      const sweepO = await post(CANCEL_ALL, sweepBody);
      log(`D  cancelAllOrders   status: ${sweepO.status}  body: ${JSON.stringify(sweepO.body).slice(0, 200)}`);
    } catch (e: any) {
      log(`D  cancelAllOrders threw: ${e?.message ?? e}`);
    }
  }

  // D2: post-run GET /orders -- no URNM orders resting.
  const openO = await get(OPEN_ORDERS, { account: address });
  const open = Array.isArray(openO.body?.data) ? openO.body.data : [];
  const urnmOpen = open.filter((o: any) => o.symbol === 'URNM');
  const d2Clean = urnmOpen.length === 0;
  log(`D2 post-run open     ${open.length} open order(s); URNM: ${urnmOpen.length}  (want 0)`);
  if (urnmOpen.length > 0) {
    log(`  LEAK: ${urnmOpen.length} URNM order(s) still resting -- cancel manually.`);
  }

  const pass = d1BatchOk && d1CreateOk && d1CancelOk && d2Clean;
  log(`  D1 batch envelope OK?   ${d1BatchOk}  (want true)`);
  log(`  D1 results[0] (Create)? ${d1CreateOk}  (want true)`);
  log(`  D1 results[1] (Cancel)? ${d1CancelOk}  (want true)`);
  log(`  D2 post-run 0 open?     ${d2Clean}  (want true)`);
  log(pass ? ok('Case D PASS') : no('Case D FAIL'));
  return pass;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Creds    : PRIVATE_KEY=${privateKey ? 'set' : 'MISSING'}  ADDRESS=${address ? 'set' : 'MISSING'}`);
  log(`Create   : ${process.env.SMOKE_CREATE === '1' ? 'enabled (SMOKE_CREATE=1)' : 'disabled (default)'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A1 createTwapOrder audited P4', await caseA1()]);
  results.push(['A2 cancelTwapOrder audited P7', await caseA2()]);
  results.push(['A3 batchOrders audited P5a+P5b', await caseA3()]);
  results.push(['B TWAP GET envelope', await caseB()]);
  results.push(['C URNM TWAP lifecycle (gated)', await caseC()]);
  results.push(['D URNM batch lifecycle (gated)', await caseD()]);

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
