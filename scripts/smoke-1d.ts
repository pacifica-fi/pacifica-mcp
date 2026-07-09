/**
 * Tier 1d live smoke test -- createStopOrder.
 *
 * Closes the one open verification gap from Tier 2: createStopOrder's fix (the
 * nested stop_order object now carries decimal-string stop_price/limit_price via
 * the shared stopOrderInfoSchema, replacing the old numeric stop_tick_level/
 * limit_tick_level) was verified only by struct-analysis + analogy to the proven
 * openOrder fix. Nothing exercised create_stop_order on the wire. This does.
 *
 *   Case A  create_stop_order  signed POST  new nested stop_order shape deserializes + sig accepted/rejected differential + old tick_level-shape negative control (NON-EXECUTING)
 *   Case B  create_stop_order  signed POST  optional nested fields (limit_price, trigger_price_type variants) deserialize (NON-EXECUTING)
 *   Case C  create+cancel      signed POST  LIVE reversible non-triggering stop + immediate cancel (GATED behind SMOKE_CREATE=1)
 *
 * The signing helpers come from scripts/signing-helpers.ts, which keeps a copy of
 * the src/index.ts signing scheme that is independent of the server (so this test
 * can catch a regression there). Keep that file in sync if the scheme changes.
 *
 *  ===================  WHY NOT amount "0"  ===================
 *  smoke:1c's regular create_order proves its non-executing cases with amount "0"
 *  (a zero-size order fails the min-notional check and never rests). That trick does
 *  NOT work for a STANDALONE STOP: the stop endpoint defers the amount / min-notional
 *  check to TRIGGER time, so a correctly-signed amount-"0" stop is ACCEPTED and RESTS
 *  (verified empirically -- it returns 200 + an order_id). So Cases A and B instead
 *  make every leg non-resting with a FRACTIONAL stop_price ("100000.5"): BTC tick_size
 *  is 1, so the price-validation step rejects it ("not a multiple of tick size 1")
 *  with a 400 and nothing rests. Crucially, signature verification runs BEFORE that
 *  price validation (verified: a tampered sig on the same body returns "Verification
 *  failed", a valid sig returns the tick error), so a valid-sig + fractional-price leg
 *  proves BOTH that the shape deserialized AND that the signature was accepted, without
 *  ever resting an order.
 *  ===========================================================
 *
 * Cases A and B need PRIVATE_KEY + ADDRESS and are SKIPPED (not failed) if absent.
 * Case C additionally requires SMOKE_CREATE=1 (mirrors smoke:1c). Case C is executing
 * but reversible: it places a bid stop with a trigger ~5% ABOVE the live mark -- a bid
 * stop (StopMarket) triggers only when price RISES to the trigger (MaxTickGte;
 * perp-backend position/src/order.rs:112-122), so it rests pending without triggering,
 * well inside the +30% taker price band -- then cancels it in a finally block.
 *
 * Run:  PRIVATE_KEY=... ADDRESS=... npm run smoke:1d                  (A+B run, C skipped)
 *       SMOKE_CREATE=1 PRIVATE_KEY=... ADDRESS=... npm run smoke:1d   (A+B+C run)
 *   (PACIFICA_BASE_URL optional; defaults to testnet, same as the server.)
 */
import {
  BASE_URL, privateKey, address,
  signRequest, tamperSignature, get, post,
  looksLikeSignatureRejection, looksLikeDeserializeError,
  log, ok, no,
} from './signing-helpers.js';

// --- endpoints --------------------------------------------------------------

const STOP_CREATE = '/api/v1/orders/stop/create';
const STOP_CANCEL = '/api/v1/orders/stop/cancel';
const CANCEL_ALL = '/api/v1/orders/cancel_all';
const OPEN_ORDERS = '/api/v1/orders';
const PRICES = '/api/v1/info/prices';

// A deliberately NON-tick-aligned BTC trigger for the non-executing cases. BTC
// tick_size is 1, so a fractional price is rejected at price validation ("not a
// multiple of tick size 1") with a 400 and NEVER rests -- but only AFTER signature
// verification has passed. This is what lets Cases A/B prove deserialization +
// signature acceptance without resting an order (see header). Do NOT change this to
// a tick-aligned value: a valid stop_price WOULD rest.
const NON_RESTING_STOP_PRICE = '100000.5';

// --- cases ------------------------------------------------------------------

// Case A: create_stop_order deserialize + sig differential (signed POST) -- NON-EXECUTING.
//
//  ===================  SAFETY  ===================
//  This case MUST NEVER rest a stop order. Every leg uses a fractional stop_price
//  ("100000.5") which the nested StopOrderInfo deserializes but price validation
//  rejects ("not a multiple of tick size 1") BEFORE any stop can rest. The purpose
//  is only to prove:
//    (a) the new nested stop_order shape (decimal-string stop_price) DESERIALIZES,
//    (b) the signature over the nested object is ACCEPTED (a valid-sig leg reaches
//        price validation; a tampered-sig leg is rejected at signature check), and
//    (c) the OLD stop_tick_level-only shape no longer deserializes (stop_price is
//        required).
//  Runs whenever PRIVATE_KEY + ADDRESS are present; no opt-in gate needed.
//  ================================================
const caseA = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case A: create_stop_order deserialize + sig differential (signed POST, NON-EXECUTING) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // A1: correctly-signed NEW nested shape (decimal-string stop_price), fractional
  //     price. MUST NOT be a signature rejection AND MUST NOT be a deserialize error.
  //     The expected price-validation rejection (tick-size) is neither, and proves
  //     the nested stop_order DESERIALIZED and the signature was ACCEPTED (the request
  //     reached price validation, which runs after signature verification).
  const good = signRequest('create_stop_order', {
    symbol: 'BTC', side: 'bid', reduce_only: false,
    stop_order: { stop_price: NON_RESTING_STOP_PRICE, amount: '0.001' },
  });
  const goodO = await post(STOP_CREATE, good);
  log(`A1 new-shape good    status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  const a1 = !looksLikeDeserializeError(goodO) && !looksLikeSignatureRejection(goodO);

  // A2: same body, tampered signature -> MUST be a signature rejection (signature is
  //     verified before price validation, so this never reaches the tick check).
  const bad = { ...good, signature: tamperSignature(good.signature) };
  const badO = await post(STOP_CREATE, bad);
  log(`A2 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a2 = looksLikeSignatureRejection(badO);

  // A3: OLD shape -- stop_tick_level sent inside stop_order, stop_price OMITTED ->
  //     MUST be a deserialize / missing-field error (backend reports missing field
  //     `stop_price`). Proves the stop_tick_level->stop_price fix matters and
  //     stop_price is genuinely required. (Deserialization runs before signature
  //     verification, so this fails at deserialize regardless of the signature.)
  const old = signRequest('create_stop_order', {
    symbol: 'BTC', side: 'bid', reduce_only: false,
    stop_order: { stop_tick_level: 100000, amount: '0.001' },
  });
  const oldO = await post(STOP_CREATE, old);
  log(`A3 old-shape         status: ${oldO.status}  body: ${JSON.stringify(oldO.body).slice(0, 200)}`);
  const a3 = looksLikeDeserializeError(oldO);

  log(`  A1 new nested shape not rejected (sig/deser)? ${a1}  (want true)`);
  log(`  A2 tampered is sig rejection?                 ${a2}  (want true)`);
  log(`  A3 old stop_tick_level shape deser-errors?    ${a3}  (want true)`);
  const pass = a1 && a2 && a3;
  log(pass ? ok('Case A PASS') : no('Case A FAIL'));
  return pass;
};

// Case B: optional nested-field acceptance (signed POST) -- NON-EXECUTING.
// Proves the full StopOrderInfo nested shape deserializes: limit_price (stop-limit
// style) and each trigger_price_type enum value. Every leg uses the fractional
// stop_price so it is rejected at price validation and never rests; a valid enum/
// field DESERIALIZES (so the rejection is the tick error, not a deserialize error),
// while a bad enum value would surface as a deserialize error -> FAIL.
const caseB = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case B: optional nested-field acceptance (signed POST, NON-EXECUTING) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // B1: limit_price present (stop-limit style) + trigger_price_type mark_price.
  const b1Body = signRequest('create_stop_order', {
    symbol: 'BTC', side: 'bid', reduce_only: false,
    stop_order: { stop_price: NON_RESTING_STOP_PRICE, limit_price: NON_RESTING_STOP_PRICE, amount: '0.001', trigger_price_type: 'mark_price' },
  });
  const b1O = await post(STOP_CREATE, b1Body);
  log(`B1 limit+mark_price  status: ${b1O.status}  body: ${JSON.stringify(b1O.body).slice(0, 200)}`);
  const b1 = !looksLikeDeserializeError(b1O);

  // B2: trigger_price_type last_trade_price.
  const b2Body = signRequest('create_stop_order', {
    symbol: 'BTC', side: 'bid', reduce_only: false,
    stop_order: { stop_price: NON_RESTING_STOP_PRICE, amount: '0.001', trigger_price_type: 'last_trade_price' },
  });
  const b2O = await post(STOP_CREATE, b2Body);
  log(`B2 last_trade_price  status: ${b2O.status}  body: ${JSON.stringify(b2O.body).slice(0, 200)}`);
  const b2 = !looksLikeDeserializeError(b2O);

  // B3: trigger_price_type mid_price.
  const b3Body = signRequest('create_stop_order', {
    symbol: 'BTC', side: 'bid', reduce_only: false,
    stop_order: { stop_price: NON_RESTING_STOP_PRICE, amount: '0.001', trigger_price_type: 'mid_price' },
  });
  const b3O = await post(STOP_CREATE, b3Body);
  log(`B3 mid_price         status: ${b3O.status}  body: ${JSON.stringify(b3O.body).slice(0, 200)}`);
  const b3 = !looksLikeDeserializeError(b3O);

  log(`  B1 limit_price + mark_price deserializes? ${b1}  (want true)`);
  log(`  B2 last_trade_price deserializes?         ${b2}  (want true)`);
  log(`  B3 mid_price deserializes?                ${b3}  (want true)`);
  const pass = b1 && b2 && b3;
  log(pass ? ok('Case B PASS') : no('Case B FAIL'));
  return pass;
};

// Case C: LIVE reversible stop placement + cancel (signed POST) -- EXECUTING but REVERSIBLE.
//
//  ===================  SAFETY  ===================
//  This case places a REAL standalone stop order, designed to be reversible and
//  near-zero risk:
//    - side=bid, market-style stop (no limit_price) => order_type StopMarket. A bid
//      stop triggers when price RISES to the trigger (MaxTickGte;
//      position/src/order.rs:112-122). The trigger is derived ~5% ABOVE the live
//      mark, so it RESTS pending and will NOT trigger unless BTC jumps 5% in the
//      ~1s before cancel. +5% is also well inside the +30% taker price band, so the
//      stop (and, hypothetically, its triggered order) is a valid placement, not a
//      far-from-mark rejection.
//    - amount 0.001 BTC keeps any hypothetical triggered notional tiny (~$60+),
//      above the min-order USD floor yet immaterial.
//    - It is CANCELLED immediately after placement. A `finally` block guarantees the
//      cancel runs even if the placement assertions throw. If the id-based cancel
//      fails, cancelAllOrders (which cancels stop orders too; perp-backend
//      position/src/state_manager/order.rs:980-988) is invoked as a backstop, and a
//      final GET /api/v1/orders confirms nothing is left resting.
//  GATED behind SMOKE_CREATE=1 (mirrors smoke:1c). SKIPPED unless
//  SMOKE_CREATE=1 is explicitly set.
//  ================================================
const caseC = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case C: LIVE reversible stop create + cancel (signed POST, EXECUTING/REVERSIBLE) ===');
  if (process.env.SMOKE_CREATE !== '1') {
    log('SKIPPED (set SMOKE_CREATE=1 to include)');
    return 'SKIP';
  }
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  let orderId: number | string | undefined;
  let c1 = false;
  let c2Success = false;

  // C0: derive a safe non-triggering trigger from the LIVE mark. A bid stop ~5%
  //     ABOVE mark triggers only if price rises to it (so it rests now) and is
  //     within the +30% taker band. BTC tick_size is 1, so ceil to integer (strictly
  //     above mark, tick-aligned).
  const priceO = await get(PRICES, {});
  const markStr = Array.isArray(priceO.body?.data)
    ? priceO.body.data.find((p: any) => p.symbol === 'BTC')?.mark
    : undefined;
  const mark = markStr !== undefined ? Number(markStr) : NaN;
  if (!Number.isFinite(mark) || mark <= 0) {
    log(`C0 price fetch       could not read BTC mark (body: ${JSON.stringify(priceO.body).slice(0, 150)})`);
    log(no('Case C FAIL (no live mark price to derive a safe non-triggering stop)'));
    return false;
  }
  const stopPrice = String(Math.ceil(mark * 1.05));
  log(`C0 mark=${mark}  bid-stop trigger=${stopPrice}  (~5% above mark; triggers only on a rise -> rests, will not trigger)`);

  try {
    // C1: place a near-market (but non-triggering) resting bid stop.
    const createBody = signRequest('create_stop_order', {
      symbol: 'BTC', side: 'bid', reduce_only: false,
      stop_order: { stop_price: stopPrice, amount: '0.001' },
    });
    const createO = await post(STOP_CREATE, createBody);
    log(`C1 create            status: ${createO.status}  body: ${JSON.stringify(createO.body).slice(0, 300)}`);
    // Success envelope: not deser, not sig rejection, and an order_id is present.
    orderId = createO.body?.data?.order_id ?? createO.body?.order_id;
    c1 = !looksLikeDeserializeError(createO)
      && !looksLikeSignatureRejection(createO)
      && orderId !== undefined && orderId !== null;
    if (!c1) {
      log('note: stop not accepted. If the body mentions a MIN-NOTIONAL / min-size');
      log('      rejection, bump amount; if it mentions price-too-far, the +5% offset');
      log('      drifted outside the band -- re-check the live mark.');
    }
  } catch (e: any) {
    log(`C1 threw: ${e?.message ?? e}`);
  } finally {
    // C2 (cleanup): cancel the stop if one was created. Runs even if C1 failed.
    if (orderId !== undefined && orderId !== null) {
      const cancelBody = signRequest('cancel_stop_order', { symbol: 'BTC', order_id: orderId });
      const cancelO = await post(STOP_CANCEL, cancelBody);
      log(`C2 cancel            status: ${cancelO.status}  body: ${JSON.stringify(cancelO.body).slice(0, 200)}`);
      c2Success = (typeof cancelO.status === 'number' && cancelO.status < 400)
        || (cancelO.body && cancelO.body.success === true);
      log(`  C2 cancel succeeded? ${c2Success}  (want true)`);

      // C3 (backstop): if id-based cancel failed, sweep with cancelAllOrders, which
      //     cancels stop orders too. Best-effort; failure here is only logged.
      if (!c2Success) {
        log('C3 backstop          id-cancel failed; sweeping with cancelAllOrders...');
        const sweepBody = signRequest('cancel_all_orders', { symbol: 'BTC', all_symbols: false, exclude_reduce_only: false });
        const sweepO = await post(CANCEL_ALL, sweepBody);
        log(`C3 cancel_all        status: ${sweepO.status}  body: ${JSON.stringify(sweepO.body).slice(0, 200)}`);
        c2Success = (typeof sweepO.status === 'number' && sweepO.status < 400)
          || (sweepO.body && sweepO.body.success === true);
        log(`  C3 sweep succeeded? ${c2Success}  (want true)`);
      }
    } else {
      log('C2 cleanup           no order_id captured; nothing to cancel.');
    }
  }

  // C4 (verification): confirm the stop is no longer resting. Open orders include
  //     stop order_types (getOpenOrders docstring); our order_id MUST be absent.
  //     Absence is the expected clean state; presence is a definite leak/FAIL.
  let c4Clean = true;
  if (orderId !== undefined && orderId !== null) {
    const openO = await get(OPEN_ORDERS, { account: address });
    const open = Array.isArray(openO.body?.data) ? openO.body.data : [];
    const stillResting = open.some((o: any) => String(o.order_id) === String(orderId));
    c4Clean = !stillResting;
    log(`C4 post-cancel open  ${open.length} open order(s); our id ${orderId} present? ${stillResting}  (want false)`);
    if (stillResting) {
      log(no('  LEAK: stop order still resting after cancel + backstop -- cancel manually.'));
    }
  }

  const pass = c1 && c2Success && c4Clean;
  log(`  C1 stop accepted (order_id returned)? ${c1}  (want true)`);
  log(pass ? ok('Case C PASS') : no('Case C FAIL'));
  return pass;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Creds    : PRIVATE_KEY=${privateKey ? 'set' : 'MISSING'}  ADDRESS=${address ? 'set' : 'MISSING'}`);
  log(`Create   : ${process.env.SMOKE_CREATE === '1' ? 'enabled (SMOKE_CREATE=1)' : 'disabled (default)'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A create_stop_order deserialize+sig', await caseA()]);
  results.push(['B optional nested-field acceptance', await caseB()]);
  results.push(['C live reversible stop create+cancel', await caseC()]);

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
