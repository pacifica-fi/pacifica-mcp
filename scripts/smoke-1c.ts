/**
 * Tier 1c live smoke test.
 *
 * Exercises the Tier 1c openOrder tool fix against the Pacifica testnet, with
 * three independent cases. Exits non-zero if any (non-skipped) case fails.
 *
 *   Case A  create_order   signed POST   new price-string shape deserializes + sig differential + old-shape negative control (NON-EXECUTING, amount "0")
 *   Case B  create_order   signed POST   new TIF values (TOB, RFQ) deserialize (NON-EXECUTING, amount "0")
 *   Case C  create+cancel  signed POST   LIVE reversible near-market (non-filling) order + immediate cancel (GATED behind SMOKE_CREATE=1)
 *
 * The signing helpers come from scripts/signing-helpers.ts, which keeps a copy of
 * the src/index.ts signing scheme that is independent of the server (so this test
 * can catch a regression there). Keep that file in sync if the scheme changes.
 *
 * Cases A and B need PRIVATE_KEY + ADDRESS and are SKIPPED (not failed) if they
 * are absent. Case C needs PRIVATE_KEY + ADDRESS AND is additionally GATED behind
 * SMOKE_CREATE=1. Cases A and B are non-executing by
 * construction: they only ever send amount "0", which is business-rejected before
 * any order rests. Case C is executing but reversible: it derives a price ~1%
 * below the live mark (below the best ask, so it rests without filling, yet inside
 * the backend's "price too far from mark" guard), tiny notional, immediate cancel
 * in a finally block.
 *
 * Run:  PRIVATE_KEY=... ADDRESS=... npm run smoke:1c                  (A+B run, C skipped)
 *       SMOKE_CREATE=1 PRIVATE_KEY=... ADDRESS=... npm run smoke:1c   (A+B+C run)
 *   (PACIFICA_BASE_URL optional; defaults to testnet, same as the server.)
 */
import {
  BASE_URL, privateKey, address,
  signRequest, tamperSignature, get, post,
  looksLikeSignatureRejection, looksLikeDeserializeError,
  log, ok, no,
} from './signing-helpers.js';

// --- cases ------------------------------------------------------------------

const CREATE = '/api/v1/orders/create';
const CANCEL = '/api/v1/orders/cancel';

// Case A: create_order deserialize + sig differential (signed POST) -- NON-EXECUTING.
//
//  ===================  SAFETY  ===================
//  This case MUST NEVER open a position. Every leg sends amount = "0" (a string),
//  which NonNegativeDecimal deserializes but business validation rejects (min-lot /
//  amount must be > 0) BEFORE any order can rest. The purpose is only to prove:
//    (a) the new price-as-string shape DESERIALIZES,
//    (b) the signature is ACCEPTED, and
//    (c) the OLD tick_level-only shape no longer deserializes (price is required).
//  Runs whenever PRIVATE_KEY + ADDRESS are present; no opt-in gate needed.
//  ================================================
const caseA = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case A: create_order deserialize + sig differential (signed POST, NON-EXECUTING) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // A1: correctly-signed NEW shape (price as string), amount "0". MUST NOT be a
  //     signature rejection AND MUST NOT be a deserialize error. A business
  //     rejection (amount must be > 0 / min lot) is EXPECTED and counts as PASS --
  //     it proves price deserialized and the sig was accepted.
  const good = signRequest('create_order', { symbol: 'BTC', price: '1000', amount: '0', side: 'bid', tif: 'GTC', reduce_only: false });
  const goodO = await post(CREATE, good);
  log(`A1 new-shape good    status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  const a1 = !looksLikeDeserializeError(goodO) && !looksLikeSignatureRejection(goodO);

  // A2: same body, tampered signature -> MUST be a signature rejection.
  const bad = { ...good, signature: tamperSignature(good.signature) };
  const badO = await post(CREATE, bad);
  log(`A2 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a2 = looksLikeSignatureRejection(badO);

  // A3: OLD shape (tick_level sent, price OMITTED) -> MUST be a deserialize /
  //     missing-field error (backend reports missing field `price`). Proves the
  //     tick_level->price fix matters and price is genuinely required.
  const old = signRequest('create_order', { symbol: 'BTC', tick_level: 100, amount: '0', side: 'bid', tif: 'GTC', reduce_only: false });
  const oldO = await post(CREATE, old);
  log(`A3 old-shape         status: ${oldO.status}  body: ${JSON.stringify(oldO.body).slice(0, 200)}`);
  const a3 = looksLikeDeserializeError(oldO);

  log(`  A1 new shape not rejected (sig/deser)? ${a1}  (want true)`);
  log(`  A2 tampered is sig rejection?          ${a2}  (want true)`);
  log(`  A3 old tick_level shape deser-errors?  ${a3}  (want true)`);
  const pass = a1 && a2 && a3;
  log(pass ? ok('Case A PASS') : no('Case A FAIL'));
  return pass;
};

// Case B: new TIF value acceptance (signed POST) -- NON-EXECUTING.
// Proves TOB and RFQ deserialize. amount "0" so business validation rejects before
// any order rests. A business rejection is fine; a DESERIALIZE error is a FAIL.
const caseB = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case B: new TIF (TOB, RFQ) acceptance (signed POST, NON-EXECUTING) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // B1: tif TOB.
  const b1Body = signRequest('create_order', { symbol: 'BTC', price: '1000', amount: '0', side: 'bid', tif: 'TOB', reduce_only: false });
  const b1O = await post(CREATE, b1Body);
  log(`B1 tif=TOB           status: ${b1O.status}  body: ${JSON.stringify(b1O.body).slice(0, 200)}`);
  const b1 = !looksLikeDeserializeError(b1O);

  // B2: tif RFQ.
  const b2Body = signRequest('create_order', { symbol: 'BTC', price: '1000', amount: '0', side: 'bid', tif: 'RFQ', reduce_only: false });
  const b2O = await post(CREATE, b2Body);
  log(`B2 tif=RFQ           status: ${b2O.status}  body: ${JSON.stringify(b2O.body).slice(0, 200)}`);
  const b2 = !looksLikeDeserializeError(b2O);

  log(`  B1 TOB deserializes (not deser-error)? ${b1}  (want true)`);
  log(`  B2 RFQ deserializes (not deser-error)? ${b2}  (want true)`);
  const pass = b1 && b2;
  log(pass ? ok('Case B PASS') : no('Case B FAIL'));
  return pass;
};

// Case C: LIVE reversible order placement + cancel (signed POST) -- EXECUTING but REVERSIBLE.
//
//  ===================  SAFETY  ===================
//  This case places a REAL order, but it is designed to be reversible and
//  near-zero risk:
//    - The price is derived from the LIVE BTC mark: a limit BID ~1% BELOW mark.
//      That is below the best ask, so it RESTS on the book and will NOT fill,
//      yet it is close enough to mark to clear the backend's "price too far from
//      mark" guard (a fixed far-from-market price like "1000" is rejected outright
//      and can never rest -- which is why the price must be derived live).
//    - amount 0.001 BTC keeps the resting notional tiny (~ $60).
//    - It is CANCELLED immediately after placement. A `finally` block guarantees
//      the cancel runs even if the placement assertions throw.
//    - Backstop: if the id-based cancel fails, cancelAllOrders
//      (/api/v1/orders/cancel_all) can clear it; the operator should verify no
//      resting order remains after the run (see Phase 3).
//  GATED behind SMOKE_CREATE=1. The operator should review
//  this block before enabling it. SKIPPED unless SMOKE_CREATE=1 is explicitly set.
//  ================================================
const caseC = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case C: LIVE reversible create + cancel (signed POST, EXECUTING/REVERSIBLE) ===');
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

  // C0: derive a safe resting price from the LIVE mark. A bid ~1% below mark is
  //     below the best ask (so it rests without filling) yet inside the backend's
  //     "price too far from mark" guard. BTC tick_size is 1, so floor to integer.
  const priceO = await get('/api/v1/info/prices', {});
  const markStr = Array.isArray(priceO.body?.data)
    ? priceO.body.data.find((p: any) => p.symbol === 'BTC')?.mark
    : undefined;
  const mark = markStr !== undefined ? Number(markStr) : NaN;
  if (!Number.isFinite(mark) || mark <= 0) {
    log(`C0 price fetch       could not read BTC mark (body: ${JSON.stringify(priceO.body).slice(0, 150)})`);
    log(no('Case C FAIL (no live mark price to derive a safe resting bid)'));
    return false;
  }
  const restPrice = String(Math.floor(mark * 0.99));
  log(`C0 mark=${mark}  resting bid=${restPrice}  (~1% below mark; below ask -> rests, will not fill)`);

  try {
    // C1: place a near-market (but non-filling) resting bid.
    const createBody = signRequest('create_order', { symbol: 'BTC', price: restPrice, amount: '0.001', side: 'bid', tif: 'GTC', reduce_only: false });
    const createO = await post(CREATE, createBody);
    log(`C1 create            status: ${createO.status}  body: ${JSON.stringify(createO.body).slice(0, 300)}`);
    // Success envelope: not deser, not sig rejection, and an order_id is present.
    orderId = createO.body?.data?.order_id ?? createO.body?.order_id;
    c1 = !looksLikeDeserializeError(createO)
      && !looksLikeSignatureRejection(createO)
      && orderId !== undefined && orderId !== null;
    if (!c1) {
      log('note: order not accepted. If the body mentions a MIN-NOTIONAL / min-size');
      log('      rejection, bump amount (see plan Phase 3) and capture the actual');
      log('      minimum from the error message; if it mentions price-too-far, widen');
      log('      the offset below mark.');
    }
  } catch (e: any) {
    log(`C1 threw: ${e?.message ?? e}`);
  } finally {
    // C2 (cleanup): cancel the order if one was created. Runs even if C1 failed.
    if (orderId !== undefined && orderId !== null) {
      const cancelBody = signRequest('cancel_order', { symbol: 'BTC', order_id: orderId });
      const cancelO = await post(CANCEL, cancelBody);
      log(`C2 cancel            status: ${cancelO.status}  body: ${JSON.stringify(cancelO.body).slice(0, 200)}`);
      c2Success = (typeof cancelO.status === 'number' && cancelO.status < 400)
        || (cancelO.body && cancelO.body.success === true);
      log(`  C2 cancel succeeded? ${c2Success}  (want true)`);
      log('  Backstop if cancel failed: cancelAllOrders -> /api/v1/orders/cancel_all');
    } else {
      log('C2 cleanup           no order_id captured; nothing to cancel.');
    }
  }

  const pass = c1 && c2Success;
  log(`  C1 order accepted (order_id returned)? ${c1}  (want true)`);
  log(pass ? ok('Case C PASS') : no('Case C FAIL'));
  return pass;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Creds    : PRIVATE_KEY=${privateKey ? 'set' : 'MISSING'}  ADDRESS=${address ? 'set' : 'MISSING'}`);
  log(`Create   : ${process.env.SMOKE_CREATE === '1' ? 'enabled (SMOKE_CREATE=1)' : 'disabled (default)'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A create_order deserialize+sig', await caseA()]);
  results.push(['B new TIF acceptance', await caseB()]);
  results.push(['C live reversible create+cancel', await caseC()]);

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
