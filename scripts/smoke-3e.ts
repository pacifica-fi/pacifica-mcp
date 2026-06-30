/**
 * Tier 3e live smoke -- Layer 3: fill-producing maker rig (two accounts).
 *
 *   Case A (gated SMOKE_FILL=1, Layer 3, EXECUTING/FILL-PRODUCING) -- the rig:
 *     Choreography A0–A6 plus finally-cleanup C1–C5 on every exit path.
 *     Every step logs `status+body`.
 *     The whole thing runs inside try/finally with a two-account cleanup
 *     (cancelAllOrders, position close, margin-mode restore) so the testnet
 *     is left clean even on a mid-run error.
 *
 *   Case B (bonus, additionally gated SMOKE_FUNDING=1 because it intentionally
 *     holds a position for up to ~1h): same A0–A2 open, then WAIT until the
 *     next hourly funding tick (poll getFundingHistory for the account every
 *     60s until a URNM row appears, hard timeout 75min), then close via
 *     A5–A6 + cleanup. One successful run permanently gives the test account
 *     a funding-history row and turns the long-standing smoke:1a Case B 504
 *     green. Not part of routine invocation.
 *
 * Startup guards G1–G6 all hard-fail BEFORE any order is sent:
 *   G1 SMOKE_FILL === '1'                 (else SKIP everything)
 *   G2 PRIVATE_KEY/ADDRESS and MAKER_PRIVATE_KEY/MAKER_ADDRESS all set
 *   G3 MAKER_ADDRESS !== ADDRESS          (self-trade prevention REJECTS AND
 *      REMOVES the resting maker order on self-cross; structural guard)
 *   G4 GET /book?symbol=URNM empty both sides
 *   G5 GET /account for both accounts shows balance > $50
 *   G6 Both accounts start with 0 open orders / 0 positions on URNM
 *
 * The signing helpers come from scripts/signing-helpers.ts, which now exposes
 * `signAs(priv, addr, type, payload)` (added for this rig) alongside
 * `signRequest(type, payload)`. signRequest delegates to signAs -- one
 * implementation, two entry points.
 *
 * Run:  PRIVATE_KEY=... ADDRESS=... MAKER_PRIVATE_KEY=... MAKER_ADDRESS=... \
 *       npm run smoke:3e                              (everything SKIPs)
 *       SMOKE_FILL=1 ... npm run smoke:3e             (Case A runs, B SKIPs)
 *       SMOKE_FILL=1 SMOKE_FUNDING=1 ... npm run smoke:3e  (A + B run)
 *   (PACIFICA_BASE_URL optional; defaults to testnet.)
 */
import {
  BASE_URL, privateKey, address, signAs, get, post,
  log, ok, no,
} from './signing-helpers.js';

// --- endpoints --------------------------------------------------------------

const ORDERS = '/api/v1/orders';
const POSITIONS = '/api/v1/positions';
const ACCOUNT = '/api/v1/account';
const BOOK = '/api/v1/book';
const INFO_PRICES = '/api/v1/info/prices';
const CANCEL_ALL_ORDERS = '/api/v1/orders/cancel_all';
const UPDATE_MARGIN_MODE = '/api/v1/account/margin';

// --- helpers ----------------------------------------------------------------

const round3 = (n: number): string => n.toFixed(3);

// Per-account, per-symbol rest-count helper.
const openOrderIdsFor = async (acct: string, symbol: string): Promise<number[]> => {
  const o = await get(ORDERS, { account: acct });
  if (o.status !== 200) return [];
  const list = Array.isArray(o.body?.data) ? o.body.data : [];
  return list.filter((r: any) => r.symbol === symbol).map((r: any) => r.order_id);
};

const hasPositionFor = async (acct: string, symbol: string): Promise<boolean> => {
  const o = await get(POSITIONS, { account: acct });
  if (o.status !== 200) return false;
  const list = Array.isArray(o.body?.data) ? o.body.data : [];
  return list.some((p: any) => p.symbol === symbol);
};

const getAccountBalance = async (acct: string): Promise<number> => {
  const o = await get(ACCOUNT, { account: acct });
  if (o.status !== 200) return 0;
  return Number(o.body?.data?.balance ?? '0');
};

// --- startup guards G1–G6 ---------------------------------------------------

const g1Gate = (): boolean | 'SKIP' => {
  if (process.env.SMOKE_FILL !== '1') {
    log('SKIPPED (set SMOKE_FILL=1 to enable the Layer-3 fill rig)');
    return 'SKIP';
  }
  return true;
};

const g2Creds = (): { ok: boolean; takerKey: string; takerAddr: string; makerKey: string; makerAddr: string } => {
  const takerKey = process.env.PRIVATE_KEY;
  const takerAddr = process.env.ADDRESS;
  const makerKey = process.env.MAKER_PRIVATE_KEY;
  const makerAddr = process.env.MAKER_ADDRESS;
  if (!takerKey || !takerAddr || !makerKey || !makerAddr) {
    log('HARD FAIL (G2): PRIVATE_KEY/ADDRESS/MAKER_PRIVATE_KEY/MAKER_ADDRESS all required');
    return { ok: false, takerKey: '', takerAddr: '', makerKey: '', makerAddr: '' };
  }
  return { ok: true, takerKey, takerAddr, makerKey, makerAddr };
};

const g3SelfCross = (takerAddr: string, makerAddr: string): boolean => {
  if (takerAddr === makerAddr) {
    log('HARD FAIL (G3): MAKER_ADDRESS === ADDRESS -- self-trade prevention would DELETE the resting maker order on self-cross (orderbook.rs:732). Refusing to run.');
    return false;
  }
  return true;
};

const g4BookEmpty = async (): Promise<boolean> => {
  const o = await get(BOOK, { symbol: 'URNM' });
  if (o.status !== 200) {
    log(`G4 could not fetch URNM book: status ${o.status}  body: ${JSON.stringify(o.body).slice(0, 150)}`);
    return false;
  }
  const l = o.body?.data?.l;
  if (!Array.isArray(l) || l.length !== 2) {
    log(`G4 URNM book shape unexpected: ${JSON.stringify(l).slice(0, 150)}`);
    return false;
  }
  const bidsCount = Array.isArray(l[0]) ? l[0].length : 0;
  const asksCount = Array.isArray(l[1]) ? l[1].length : 0;
  if (bidsCount > 0 || asksCount > 0) {
    log(`HARD FAIL (G4): URNM book NOT empty (bids=${bidsCount} asks=${asksCount}). The rig requires an empty book -- abort loudly.`);
    return false;
  }
  return true;
};

const g5Balances = async (takerAddr: string, makerAddr: string): Promise<boolean> => {
  const takerBal = await getAccountBalance(takerAddr);
  const makerBal = await getAccountBalance(makerAddr);
  log(`G5 balances: taker=${takerBal}  maker=${makerBal}  (want both > 50)`);
  if (takerBal <= 50 || makerBal <= 50) {
    log('HARD FAIL (G5): one or both account balances <= $50');
    return false;
  }
  return true;
};

const g6CleanStart = async (takerAddr: string, makerAddr: string): Promise<boolean> => {
  const takerOrders = await openOrderIdsFor(takerAddr, 'URNM');
  const makerOrders = await openOrderIdsFor(makerAddr, 'URNM');
  const takerPos = await hasPositionFor(takerAddr, 'URNM');
  const makerPos = await hasPositionFor(makerAddr, 'URNM');
  log(`G6 pre-state: taker orders=${takerOrders.length} pos=${takerPos} | maker orders=${makerOrders.length} pos=${makerPos}  (want all 0/false)`);
  if (takerOrders.length > 0 || makerOrders.length > 0 || takerPos || makerPos) {
    log('HARD FAIL (G6): one or both accounts have open URNM orders or positions. Refusing to run.');
    return false;
  }
  return true;
};

// --- Case A: choreographed fill + cleanup -----------------------------------

const caseA = async (
  takerKey: string, takerAddr: string, makerKey: string, makerAddr: string
): Promise<boolean> => {
  log('\n=== Case A: LIVE fill-producing rig (signed POST, EXECUTING/FILL) ===');

  // Fetch oracle price.
  const pricesO = await get(INFO_PRICES, {});
  if (pricesO.status !== 200 || !Array.isArray(pricesO.body?.data)) {
    log(`A oracle fetch failed: status ${pricesO.status}  body: ${JSON.stringify(pricesO.body).slice(0, 200)}`);
    return false;
  }
  const urnmPrice = pricesO.body.data.find((p: any) => p.symbol === 'URNM');
  if (!urnmPrice) {
    log('A URNM price row not found in /info/prices');
    return false;
  }
  const oracle = Number(urnmPrice.oracle ?? urnmPrice.mark ?? '0');
  if (!Number.isFinite(oracle) || oracle <= 0) {
    log(`A URNM oracle/mark invalid: ${oracle}`);
    return false;
  }
  log(`A URNM oracle=${oracle}  mark=${urnmPrice.mark}`);

  let makerOrderIdA1: number | null = null;
  let makerOrderIdA5: number | null = null;
  let takerMarketOrderIdA2: number | null = null;
  let takerMarketOrderIdA6: number | null = null;
  let takerMarginModeWasIsolated: boolean | null = null;
  let takerEntryPrice: number | null = null;
  let a1Pass = false, a2Pass = false, a3Pass = false, a4Pass = false, a5Pass = false, a6Pass = false;

  const cleanup = async (stage: string) => {
    log(`\n-- cleanup (stage: ${stage}) --`);

    // C1: taker cancelAllOrders (sweeps A3 TP/SL stops).
    try {
      const body = signAs(takerKey, takerAddr, 'cancel_all_orders', { symbol: 'URNM', all_symbols: false, exclude_reduce_only: false });
      const o = await post(CANCEL_ALL_ORDERS, body);
      log(`C1 taker cancelAll   status: ${o.status}  body: ${JSON.stringify(o.body).slice(0, 200)}`);
    } catch (e: any) { log(`C1 taker cancelAll threw: ${e?.message ?? e}`); }

    // C2: maker cancelAllOrders.
    try {
      const body = signAs(makerKey, makerAddr, 'cancel_all_orders', { symbol: 'URNM', all_symbols: false, exclude_reduce_only: false });
      const o = await post(CANCEL_ALL_ORDERS, body);
      log(`C2 maker cancelAll   status: ${o.status}  body: ${JSON.stringify(o.body).slice(0, 200)}`);
    } catch (e: any) { log(`C2 maker cancelAll threw: ${e?.message ?? e}`); }

    // C3: if taker still has a URNM position, attempt reduce-only close against a fresh maker bid.
    try {
      if (await hasPositionFor(takerAddr, 'URNM')) {
        log('C3 taker URNM position still present -- attempting reduce-only close');
        // Maker rest a bid at a deep price so the taker can sell into it.
        const closeBody = signAs(makerKey, makerAddr, 'create_order', {
          symbol: 'URNM', price: round3(oracle), amount: '0.3', side: 'bid', tif: 'ALO', reduce_only: false,
        });
        const closeO = await post('/api/v1/orders/create', closeBody);
        log(`C3 maker close-bid   status: ${closeO.status}  body: ${JSON.stringify(closeO.body).slice(0, 200)}`);
        const closeOrderId = closeO.body?.data?.order_id ?? closeO.body?.order_id;
        if (closeOrderId) {
          // Give the order a moment to rest, then taker market-sells reduce-only.
          await new Promise((r) => setTimeout(r, 1500));
          const takerCloseBody = signAs(takerKey, takerAddr, 'create_market_order', {
            symbol: 'URNM', amount: '0.3', side: 'ask', slippage_percent: '2', reduce_only: true,
          });
          const takerCloseO = await post('/api/v1/orders/create_market', takerCloseBody);
          log(`C3 taker close-ask  status: ${takerCloseO.status}  body: ${JSON.stringify(takerCloseO.body).slice(0, 200)}`);
        }
        // Now sweep again.
        const sweep1 = signAs(takerKey, takerAddr, 'cancel_all_orders', { symbol: 'URNM', all_symbols: false, exclude_reduce_only: false });
        const sweep1O = await post(CANCEL_ALL_ORDERS, sweep1);
        log(`C3 taker re-sweep   status: ${sweep1O.status}  body: ${JSON.stringify(sweep1O.body).slice(0, 200)}`);
        const sweep2 = signAs(makerKey, makerAddr, 'cancel_all_orders', { symbol: 'URNM', all_symbols: false, exclude_reduce_only: false });
        const sweep2O = await post(CANCEL_ALL_ORDERS, sweep2);
        log(`C3 maker re-sweep   status: ${sweep2O.status}  body: ${JSON.stringify(sweep2O.body).slice(0, 200)}`);
        if (await hasPositionFor(takerAddr, 'URNM')) {
          log('C3 LEAK: taker still has URNM position after reduce-only close attempt -- MANUAL INTERVENTION NEEDED');
        }
      }
    } catch (e: any) { log(`C3 position-close threw: ${e?.message ?? e}`); }

    // C4: taker restore margin mode to cross (only valid with no position).
    if (takerMarginModeWasIsolated === true) {
      try {
        const body = signAs(takerKey, takerAddr, 'update_margin_mode', {
          symbol: 'URNM', is_isolated: false,
        });
        const o = await post(UPDATE_MARGIN_MODE, body);
        log(`C4 taker restore margin  status: ${o.status}  body: ${JSON.stringify(o.body).slice(0, 200)}`);
      } catch (e: any) { log(`C4 margin restore threw: ${e?.message ?? e}`); }
    }

    // C5: verify clean.
    const takerOrders = await openOrderIdsFor(takerAddr, 'URNM');
    const makerOrders = await openOrderIdsFor(makerAddr, 'URNM');
    const takerPos = await hasPositionFor(takerAddr, 'URNM');
    const makerPos = await hasPositionFor(makerAddr, 'URNM');
    log(`C5 post-clean: taker orders=${takerOrders.length} pos=${takerPos} | maker orders=${makerOrders.length} pos=${makerPos}  (want all 0/false)`);
    if (takerOrders.length > 0 || makerOrders.length > 0 || takerPos || makerPos) {
      log('C5 LEAK DIAGNOSTICS:');
      if (takerOrders.length > 0) log(`  taker URNM order_ids: ${takerOrders.join(', ')}`);
      if (makerOrders.length > 0) log(`  maker URNM order_ids: ${makerOrders.join(', ')}`);
      if (takerPos) log('  taker URNM position still present');
      if (makerPos) log('  maker URNM position still present');
    }
  };

  try {
    // A0: taker: updateMarginMode URNM is_isolated=true.
    // First, check current state.
    const acctO = await get(ACCOUNT, { account: takerAddr });
    const urnmSettings = Array.isArray(acctO.body?.data?.margin_settings)
      ? acctO.body.data.margin_settings
      : [];
    const urnmEntry = urnmSettings.find((s: any) => s.symbol === 'URNM');
    takerMarginModeWasIsolated = urnmEntry?.is_isolated === true;
    if (!takerMarginModeWasIsolated) {
      const body = signAs(takerKey, takerAddr, 'update_margin_mode', {
        symbol: 'URNM', is_isolated: true,
      });
      const o = await post(UPDATE_MARGIN_MODE, body);
      log(`A0 taker marginMode  status: ${o.status}  body: ${JSON.stringify(o.body).slice(0, 200)}`);
      if (o.status !== 200) {
        log('A0 FAIL: could not set isolated margin mode');
        return false;
      }
    } else {
      log('A0 taker already in isolated mode');
    }

    // A1: maker: openOrder URNM ask, tif ALO, price = round3(oracle), amount '0.3'.
    const a1Body = signAs(makerKey, makerAddr, 'create_order', {
      symbol: 'URNM', price: round3(oracle), amount: '0.3', side: 'ask', tif: 'ALO', reduce_only: false,
    });
    const a1O = await post('/api/v1/orders/create', a1Body);
    log(`A1 maker ALO ask     status: ${a1O.status}  body: ${JSON.stringify(a1O.body).slice(0, 200)}`);
    makerOrderIdA1 = a1O.body?.data?.order_id ?? a1O.body?.order_id ?? null;
    a1Pass = makerOrderIdA1 !== null && a1O.status === 200;
    if (!a1Pass) {
      log('A1 FAIL: maker ask did not rest');
      return false;
    }
    // Give the order a moment to rest.
    await new Promise((r) => setTimeout(r, 1500));

    // A2: taker: createMarketOrder URNM bid, amount '0.3', slippage '2', reduce_only false.
    const a2Body = signAs(takerKey, takerAddr, 'create_market_order', {
      symbol: 'URNM', amount: '0.3', side: 'bid', slippage_percent: '2', reduce_only: false,
    });
    const a2O = await post('/api/v1/orders/create_market', a2Body);
    log(`A2 taker market bid  status: ${a2O.status}  body: ${JSON.stringify(a2O.body).slice(0, 200)}`);
    takerMarketOrderIdA2 = a2O.body?.data?.order_id ?? a2O.body?.order_id ?? null;
    a2Pass = takerMarketOrderIdA2 !== null && a2O.status === 200;
    if (!a2Pass) {
      log('A2 FAIL: taker market order did not execute');
      return false;
    }
    // Verify position opened.
    await new Promise((r) => setTimeout(r, 1500));
    const posO = await get(POSITIONS, { account: takerAddr });
    const positions = Array.isArray(posO.body?.data) ? posO.body.data : [];
    const takerPos = positions.find((p: any) => p.symbol === 'URNM');
    if (!takerPos) {
      log('A2 FAIL: taker URNM position not found after market buy');
      return false;
    }
    takerEntryPrice = Number(takerPos.entry_price ?? '0');
    log(`A2 taker position    entry_price=${takerEntryPrice}  amount=${takerPos.amount}  side=${takerPos.side}`);

    // A3: taker: setPositionTpsl URNM side ask -- the stop's side must be the
    // OPPOSITE of the position side (the closing direction): perp-backend
    // position/src/state_manager/stop_order.rs:100 rejects side == position.side
    // with InvalidStopOrderSide. (The plan said 'bid'; the engine says otherwise.)
    // TP at entry*1.25 (far above mark so it rests; a long TP triggers when price RISES to it).
    // SL at entry*0.75 (far below mark so it rests; a long SL triggers when price FALLS to it).
    const tpPrice = round3(takerEntryPrice * 1.25);
    const slPrice = round3(takerEntryPrice * 0.75);
    // trigger_price_type MUST be 'mark_price' explicitly: the API forwards None
    // through and the engine treats None as MID price (stop_order.rs:118), which
    // is 0 on URNM's empty book -- making any SL unconditionally invalid. ALSO
    // OBSERVED: a request whose SL leg fails still RESTS the TP leg (no rollback;
    // partial-rest trap, amount-"0" family) -- the cleanup sweep handles it.
    const a3Body = signAs(takerKey, takerAddr, 'set_position_tpsl', {
      symbol: 'URNM', side: 'ask',
      take_profit: { stop_price: tpPrice, trigger_price_type: 'mark_price' },
      stop_loss: { stop_price: slPrice, trigger_price_type: 'mark_price' },
    });
    const a3O = await post('/api/v1/positions/tpsl', a3Body);
    log(`A3 taker setTPSL     status: ${a3O.status}  body: ${JSON.stringify(a3O.body).slice(0, 200)}`);
    a3Pass = a3O.status === 200;
    if (!a3Pass) {
      log('A3 FAIL: setPositionTpsl did not succeed');
      return false;
    }
    // Verify both stops appear in GET /orders.
    await new Promise((r) => setTimeout(r, 1000));
    const ordersO = await get(ORDERS, { account: takerAddr });
    const orders = Array.isArray(ordersO.body?.data) ? ordersO.body.data : [];
    const urnmOrders = orders.filter((o: any) => o.symbol === 'URNM');
    const hasTP = urnmOrders.some((o: any) => o.order_type === 'take_profit' || (o.stop_price && Number(o.stop_price) === Number(tpPrice)));
    const hasSL = urnmOrders.some((o: any) => o.order_type === 'stop_loss' || (o.stop_price && Number(o.stop_price) === Number(slPrice)));
    log(`A3 stops in book: TP=${hasTP} SL=${hasSL}`);
    a3Pass = a3Pass && hasTP && hasSL;

    // A4: taker: addIsolatedMargin URNM amount '5'.
    const a4Body = signAs(takerKey, takerAddr, 'add_isolated_margin', {
      symbol: 'URNM', amount: '5',
    });
    const a4O = await post('/api/v1/positions/add_isolated_margin', a4Body);
    log(`A4 taker addIsolated status: ${a4O.status}  body: ${JSON.stringify(a4O.body).slice(0, 200)}`);
    a4Pass = a4O.status === 200;
    if (a4Pass) {
      // Verify margin increased.
      await new Promise((r) => setTimeout(r, 1500));
      const posAfterO = await get(POSITIONS, { account: takerAddr });
      const positionsAfter = Array.isArray(posAfterO.body?.data) ? posAfterO.body.data : [];
      const takerPosAfter = positionsAfter.find((p: any) => p.symbol === 'URNM');
      if (takerPosAfter) {
        const margin = Number(takerPosAfter.margin ?? takerPosAfter.isolated_margin ?? '0');
        log(`A4 taker margin after add: ${margin}  (want > 0)`);
        a4Pass = a4Pass && margin > 0;
      } else {
        log('A4 FAIL: taker URNM position not found after addIsolatedMargin');
        a4Pass = false;
      }
    }

    // A5: maker: openOrder URNM bid, tif ALO, price = round3(oracle), amount '0.3'.
    const a5Body = signAs(makerKey, makerAddr, 'create_order', {
      symbol: 'URNM', price: round3(oracle), amount: '0.3', side: 'bid', tif: 'ALO', reduce_only: false,
    });
    const a5O = await post('/api/v1/orders/create', a5Body);
    log(`A5 maker ALO bid     status: ${a5O.status}  body: ${JSON.stringify(a5O.body).slice(0, 200)}`);
    makerOrderIdA5 = a5O.body?.data?.order_id ?? a5O.body?.order_id ?? null;
    a5Pass = makerOrderIdA5 !== null && a5O.status === 200;
    if (!a5Pass) {
      log('A5 FAIL: maker bid did not rest');
      return false;
    }
    await new Promise((r) => setTimeout(r, 1500));

    // A6: taker: createMarketOrder URNM ask, amount '0.3', reduce_only TRUE, slippage '2'.
    const a6Body = signAs(takerKey, takerAddr, 'create_market_order', {
      symbol: 'URNM', amount: '0.3', side: 'ask', slippage_percent: '2', reduce_only: true,
    });
    const a6O = await post('/api/v1/orders/create_market', a6Body);
    log(`A6 taker market ask  status: ${a6O.status}  body: ${JSON.stringify(a6O.body).slice(0, 200)}`);
    takerMarketOrderIdA6 = a6O.body?.data?.order_id ?? a6O.body?.order_id ?? null;
    a6Pass = takerMarketOrderIdA6 !== null && a6O.status === 200;
    if (!a6Pass) {
      log('A6 FAIL: taker market close did not execute');
      return false;
    }
    // Verify position closed.
    await new Promise((r) => setTimeout(r, 1500));
    const finalPos = await hasPositionFor(takerAddr, 'URNM');
    a6Pass = a6Pass && !finalPos;
    if (finalPos) {
      log('A6 FAIL: taker URNM position still present after reduce-only close');
    }

    return a1Pass && a2Pass && a3Pass && a4Pass && a5Pass && a6Pass;
  } catch (e: any) {
    log(`A threw: ${e?.message ?? e}`);
    return false;
  } finally {
    await cleanup('Case A');
  }
};

// --- Case B: funding-tick bonus (gated SMOKE_FUNDING=1) ---------------------

const caseB = async (
  takerKey: string, takerAddr: string, makerKey: string, makerAddr: string
): Promise<boolean> => {
  log('\n=== Case B: LIVE funding-tick bonus (gated SMOKE_FUNDING=1) ===');
  if (process.env.SMOKE_FUNDING !== '1') {
    log('SKIPPED (set SMOKE_FUNDING=1 to include)');
    return false;
  }

  // Same A0–A2 as Case A.
  const pricesO = await get(INFO_PRICES, {});
  const urnmPrice = pricesO.body?.data?.find((p: any) => p.symbol === 'URNM');
  const oracle = Number(urnmPrice?.oracle ?? '0');
  log(`B URNM oracle=${oracle}`);

  // A0: taker isolated margin mode.
  const acctO = await get(ACCOUNT, { account: takerAddr });
  const urnmSettings = Array.isArray(acctO.body?.data?.margin_settings)
    ? acctO.body.data.margin_settings
    : [];
  const urnmEntry = urnmSettings.find((s: any) => s.symbol === 'URNM');
  if (urnmEntry?.is_isolated !== true) {
    const body = signAs(takerKey, takerAddr, 'update_margin_mode', { symbol: 'URNM', is_isolated: true });
    const o = await post(UPDATE_MARGIN_MODE, body);
    log(`B A0 taker marginMode  status: ${o.status}  body: ${JSON.stringify(o.body).slice(0, 200)}`);
  }

  // A1: maker ALO ask.
  const a1Body = signAs(makerKey, makerAddr, 'create_order', {
    symbol: 'URNM', price: round3(oracle), amount: '0.3', side: 'ask', tif: 'ALO', reduce_only: false,
  });
  const a1O = await post('/api/v1/orders/create', a1Body);
  log(`B A1 maker ALO ask   status: ${a1O.status}  body: ${JSON.stringify(a1O.body).slice(0, 200)}`);
  if (a1O.status !== 200) {
    log('B A1 FAIL');
    return false;
  }
  await new Promise((r) => setTimeout(r, 1500));

  // A2: taker market bid.
  const a2Body = signAs(takerKey, takerAddr, 'create_market_order', {
    symbol: 'URNM', amount: '0.3', side: 'bid', slippage_percent: '2', reduce_only: false,
  });
  const a2O = await post('/api/v1/orders/create_market', a2Body);
  log(`B A2 taker market bid  status: ${a2O.status}  body: ${JSON.stringify(a2O.body).slice(0, 200)}`);
  if (a2O.status !== 200) {
    log('B A2 FAIL');
    return false;
  }

  // Wait for funding tick (poll getFundingHistory every 60s for a URNM row, hard timeout 75min).
  log('B polling getFundingHistory for URNM funding row (every 60s, hard timeout 75min)...');
  const startTime = Date.now();
  const HARD_TIMEOUT = 75 * 60 * 1000; // 75 minutes
  const POLL_INTERVAL = 60 * 1000; // 60 seconds
  let fundingRowFound = false;

  while (Date.now() - startTime < HARD_TIMEOUT) {
    const fhO = await get('/api/v1/funding/history', { account: takerAddr });
    log(`B funding history    status: ${fhO.status}  body: ${JSON.stringify(fhO.body).slice(0, 150)}`);
    if (fhO.status === 200 && Array.isArray(fhO.body?.data) && fhO.body.data.length > 0) {
      log('B funding row found!');
      fundingRowFound = true;
      break;
    }
    log(`B no funding row yet, sleeping ${POLL_INTERVAL / 1000}s...`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  if (!fundingRowFound) {
    log('B HARD TIMEOUT: no funding row within 75min');
    return false;
  }

  // A5: maker ALO bid (exit liquidity).
  const a5Body = signAs(makerKey, makerAddr, 'create_order', {
    symbol: 'URNM', price: round3(oracle), amount: '0.3', side: 'bid', tif: 'ALO', reduce_only: false,
  });
  const a5O = await post('/api/v1/orders/create', a5Body);
  log(`B A5 maker ALO bid   status: ${a5O.status}  body: ${JSON.stringify(a5O.body).slice(0, 200)}`);
  if (a5O.status !== 200) {
    log('B A5 FAIL');
    return false;
  }
  await new Promise((r) => setTimeout(r, 1500));

  // A6: taker market ask reduce_only.
  const a6Body = signAs(takerKey, takerAddr, 'create_market_order', {
    symbol: 'URNM', amount: '0.3', side: 'ask', slippage_percent: '2', reduce_only: true,
  });
  const a6O = await post('/api/v1/orders/create_market', a6Body);
  log(`B A6 taker market ask  status: ${a6O.status}  body: ${JSON.stringify(a6O.body).slice(0, 200)}`);
  if (a6O.status !== 200) {
    log('B A6 FAIL');
    return false;
  }

  // Cleanup.
  try {
    const sweep1 = signAs(takerKey, takerAddr, 'cancel_all_orders', { symbol: 'URNM', all_symbols: false, exclude_reduce_only: false });
    await post(CANCEL_ALL_ORDERS, sweep1);
    const sweep2 = signAs(makerKey, makerAddr, 'cancel_all_orders', { symbol: 'URNM', all_symbols: false, exclude_reduce_only: false });
    await post(CANCEL_ALL_ORDERS, sweep2);
    if (urnmEntry?.is_isolated !== true) {
      const restore = signAs(takerKey, takerAddr, 'update_margin_mode', { symbol: 'URNM', is_isolated: false });
      await post(UPDATE_MARGIN_MODE, restore);
    }
  } catch (e: any) {
    log(`B cleanup threw: ${e?.message ?? e}`);
  }

  return true;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Fill     : ${process.env.SMOKE_FILL === '1' ? 'enabled (SMOKE_FILL=1)' : 'disabled (default)'}`);
  log(`Funding  : ${process.env.SMOKE_FUNDING === '1' ? 'enabled (SMOKE_FUNDING=1)' : 'disabled (default)'}`);

  // G1: gate.
  const g1 = g1Gate();
  if (g1 === 'SKIP') {
    log('\n=== SUMMARY ===');
    log('SKIP  Case A fill rig (SMOKE_FILL=1 not set)');
    log('SKIP  Case B funding-tick bonus (SMOKE_FUNDING=1 not set)');
    log('\nALL PASS (gates closed, nothing to run)');
    process.exit(0);
  }

  // G2: creds.
  const g2 = g2Creds();
  if (!g2.ok) {
    log('\n=== SUMMARY ===');
    log('FAIL  Case A fill rig (G2 creds)');
    process.exit(1);
  }

  // G3: self-cross guard.
  if (!g3SelfCross(g2.takerAddr, g2.makerAddr)) {
    log('\n=== SUMMARY ===');
    log('FAIL  Case A fill rig (G3 self-cross)');
    process.exit(1);
  }

  // G4: book empty.
  if (!(await g4BookEmpty())) {
    log('\n=== SUMMARY ===');
    log('FAIL  Case A fill rig (G4 book not empty)');
    process.exit(1);
  }

  // G5: balances.
  if (!(await g5Balances(g2.takerAddr, g2.makerAddr))) {
    log('\n=== SUMMARY ===');
    log('FAIL  Case A fill rig (G5 balances)');
    process.exit(1);
  }

  // G6: clean start.
  if (!(await g6CleanStart(g2.takerAddr, g2.makerAddr))) {
    log('\n=== SUMMARY ===');
    log('FAIL  Case A fill rig (G6 not clean)');
    process.exit(1);
  }

  log('\nAll startup guards passed (G1–G6).');

  // Run Case A.
  const aResult = await caseA(g2.takerKey, g2.takerAddr, g2.makerKey, g2.makerAddr);

  // Run Case B (if gated).
  const bResult = await caseB(g2.takerKey, g2.takerAddr, g2.makerKey, g2.makerAddr);

  log('\n=== SUMMARY ===');
  log(aResult ? 'PASS  Case A fill rig' : 'FAIL  Case A fill rig');
  if (process.env.SMOKE_FUNDING === '1') {
    log(bResult ? 'PASS  Case B funding-tick bonus' : 'FAIL  Case B funding-tick bonus');
  } else {
    log('SKIP  Case B funding-tick bonus (SMOKE_FUNDING=1 not set)');
  }

  const failed = (aResult ? 0 : 1) + (process.env.SMOKE_FUNDING === '1' && !bResult ? 1 : 0);
  log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed ? 1 : 0);
};

main();
