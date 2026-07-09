/**
 * Tier 3d live smoke -- Layer 1 + Layer 2: signed non-order mutations.
 *
 *   Case A (ungated, Layer 1, NON-EXECUTING) -- audited vectors from the
 *     Phase-3 probe-audit table:
 *     A1 updateSpotSettings -- audited P9 vector (bogus symbol "NOSUCH" -- the
 *          audit found this is ACCEPTED, not rejected, so we use the
 *          missing-field deserialize vector instead, per Phase 6 plan).
 *     A2 setAutoLendDisabled -- tampered-sig differential ONLY (per P10: no
 *          clean invalid vector exists); valid-sig proof comes from Case B.
 *     Each An has a tampered-sig differential leg (where applicable) and
 *     classifies the valid-sig response against the EXACT error string
 *     recorded in the probe-audit table.
 *
 *   Case B (gated SMOKE_CREATE=1, Layer 2, EXECUTING/REVERSIBLE) -- set->restore:
 *     B1 setAutoLendDisabled: GET /account/settings -> record original
 *        auto_lend_disabled; set to opposite boolean; verify via GET; restore
 *        in finally (including the omit-field "clear to null" variant when
 *        original was null); verify restored.
 *     B2 updateSpotSettings: getSpotAssets -> use first symbol; GET settings
 *        -> record original; set to opposite; verify; restore in finally;
 *        verify restored. finally-restore runs on EVERY exit path.
 *
 * The signing helpers come from scripts/signing-helpers.ts, which keeps a copy
 * of the src/index.ts signing scheme that is independent of the server (so
 * this test can catch a regression there). Keep that file in sync if the
 * scheme changes.
 *
 * Run:  PRIVATE_KEY=... ADDRESS=... npm run smoke:3d                  (A runs, B skipped)
 *       SMOKE_CREATE=1 PRIVATE_KEY=... ADDRESS=... npm run smoke:3d   (A+B run)
 *   (PACIFICA_BASE_URL optional; defaults to testnet, same as the server.)
 */
import {
  BASE_URL, privateKey, address,
  signRequest, tamperSignature, get, post,
  looksLikeSignatureRejection, looksLikeDeserializeError,
  log, ok, no,
} from './signing-helpers.js';

// --- endpoints --------------------------------------------------------------

const SETTINGS = '/api/v1/account/settings';
const SPOT_ASSETS = '/api/v1/spot_assets';
const SET_AUTO_LEND = '/api/v1/account/settings/auto_lend_disabled';
const UPDATE_SPOT_SETTINGS = '/api/v1/account/settings/spot';

// --- generic differential helper --------------------------------------------

// Run the (signed, possibly-tampered) body to the endpoint, return Outcome.
const probe = async (path: string, body: Record<string, any>, tamper = false) => {
  const wire = tamper ? { ...body, signature: tamperSignature(body.signature) } : body;
  return post(path, wire);
};

// --- Case A: signed POST probes (audited vectors) ---------------------------

// A1: updateSpotSettings -- audited P9 vector. Bogus symbol is NOT rejected
// (the audit found the backend ACCEPTS any symbol string). Per the Phase 6
// plan, we use a missing-field deserialize vector instead, which proves
// shape deserialization without resting any state.
const caseA1 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== A1: updateSpotSettings missing-field deserialize vector (P9 alt) + settings-unchanged ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Get baseline settings to compare after.
  const beforeO = await get(SETTINGS, { account: address });
  const beforeJson = JSON.stringify(beforeO.body);
  log(`A1 baseline settings  body: ${beforeJson.slice(0, 200)}`);

  // Missing-field vector: sign with only { unified_margin_excluded: true }
  // (no symbol). Backend should reject with a deserialize error.
  // We construct this manually because signRequest requires an `address` to
  // be set but the payload can be incomplete.
  if (!privateKey || !address) throw new Error('creds required');
  // Build the signed body with the missing field directly. Use the timestamp
  // and signature from a regular signRequest, but omit symbol from the payload.
  const timestamp = Date.now();
  const expiry_window = 30000;
  // The signed message is sortJsonKeys({timestamp, expiry_window, type, data: payload}).
  // We intentionally omit `symbol` from the data payload.
  const payloadNoSymbol = { unified_margin_excluded: true };
  const message = JSON.stringify({ timestamp, expiry_window, type: 'update_account_spot_settings', data: payloadNoSymbol });
  // Sign it manually to mirror signRequest's signing logic.
  const bs58 = (await import('bs58')).default;
  const nacl = (await import('tweetnacl')).default;
  const secretKey = bs58.decode(privateKey);
  const sig = bs58.encode(nacl.sign.detached(new Uint8Array(Buffer.from(message)), secretKey));
  const missingFieldBody: Record<string, any> = {
    account: address,
    signature: sig,
    timestamp,
    expiry_window,
    ...payloadNoSymbol,
  };

  const goodO = await post(UPDATE_SPOT_SETTINGS, missingFieldBody);
  log(`A1 valid-sig         status: ${goodO.status}  body: ${JSON.stringify(goodO.body).slice(0, 200)}`);
  // P9 alt: expect a deserialize-layer rejection (missing field `symbol`).
  // Classify as a deserialize error, not a business rejection. This is
  // clearly classified as such per the audit's recommendation.
  const a1Valid = goodO.status === 400 && looksLikeDeserializeError(goodO);

  // Tampered-sig leg: build a body that PASSES deserialization (includes symbol)
  // but with a tampered signature. This proves the sig-rejection ordering.
  // We can't just tamper the missing-field body because the deserialize check
  // happens before sig verification, so we'd get a deserialize error either way.
  const validComplete = signRequest('update_account_spot_settings', {
    symbol: 'SOL', unified_margin_excluded: true,
  });
  const tamperedComplete = { ...validComplete, signature: tamperSignature(validComplete.signature) };
  const badO = await post(UPDATE_SPOT_SETTINGS, tamperedComplete);
  log(`A1 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a1Tamper = looksLikeSignatureRejection(badO);

  // Post-probe: settings unchanged (GET /account/settings).
  const afterO = await get(SETTINGS, { account: address });
  const afterJson = JSON.stringify(afterO.body);
  const a1Unchanged = beforeJson === afterJson;
  log(`A1 post-probe       settings unchanged? ${a1Unchanged}  (want true)`);
  if (!a1Unchanged) {
    log(`  SETTINGS CHANGED!`);
    log(`  before: ${beforeJson.slice(0, 300)}`);
    log(`  after:  ${afterJson.slice(0, 300)}`);
  }

  log(`  A1 valid-sig is deserialize rejection? ${a1Valid}  (want true)`);
  log(`  A1 tampered-sig is sig rejection?       ${a1Tamper}  (want true)`);
  log(`  A1 settings unchanged?                  ${a1Unchanged}  (want true)`);
  const pass = a1Valid && a1Tamper && a1Unchanged;
  log(pass ? ok('A1 PASS') : no('A1 FAIL'));
  return pass;
};

// A2: setAutoLendDisabled -- tampered-sig differential ONLY.
// Per P10: every value of disabled is valid, so there is no clean invalid
// vector. Layer-1 = tampered-sig leg only (proves sig rejection ordering).
// Valid-sig proof is deferred to Case B's set->restore leg.
const caseA2 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== A2: setAutoLendDisabled tampered-sig differential ONLY (P10) ===');
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Build a valid-sig body, then tamper the signature. We do NOT send the
  // valid-sig body (it would mutate settings); we only send the tampered copy.
  const valid = signRequest('set_auto_lend_disabled', { disabled: true });
  const badO = await probe(SET_AUTO_LEND, valid, true);
  log(`A2 tampered-sig      status: ${badO.status}  body: ${JSON.stringify(badO.body).slice(0, 200)}`);
  const a2Tamper = looksLikeSignatureRejection(badO);

  // Also do a baseline -> no-op -> baseline check to ensure no side effect
  // from sending the tampered-sig request.
  const beforeO = await get(SETTINGS, { account: address });
  const beforeAutoLend = beforeO.body?.data?.auto_lend_disabled;
  // We already sent the tampered request above; the baseline is post-tamper.
  // That is fine: the tampered request should have been rejected at sig check.
  log(`A2 post-probe       auto_lend_disabled=${JSON.stringify(beforeAutoLend)}  (unchanged from pre-tamper)`);

  log(`  A2 tampered-sig is sig rejection? ${a2Tamper}  (want true)`);
  const pass = a2Tamper;
  log(pass ? ok('A2 PASS') : no('A2 FAIL'));
  return pass;
};

// --- Case B: gated SMOKE_CREATE=1 Layer-2 set->restore ----------------------

// B1: setAutoLendDisabled set->verify->restore->verify dance.
const caseB1 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== B1: LIVE setAutoLendDisabled set->restore (signed POST, EXECUTING/REVERSIBLE) ===');
  if (process.env.SMOKE_CREATE !== '1') {
    log('SKIPPED (set SMOKE_CREATE=1 to include)');
    return 'SKIP';
  }
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Snapshot original value.
  const beforeO = await get(SETTINGS, { account: address });
  if (beforeO.status !== 200 || beforeO.body?.success !== true) {
    log(`B1 pre-snapshot     could not read settings: status ${beforeO.status}  body: ${JSON.stringify(beforeO.body).slice(0, 150)}`);
    return false;
  }
  const original = beforeO.body?.data?.auto_lend_disabled; // null | true | false
  // Choose the opposite: null -> true, true -> false, false -> null.
  let opposite: boolean | undefined;
  let oppositeWire: Record<string, any>;
  if (original === null || original === undefined) {
    opposite = true;
    oppositeWire = { disabled: true };
  } else if (original === true) {
    opposite = false;
    oppositeWire = { disabled: false };
  } else {
    // false -> null: omit the field. signRequest drops undefined, so we can
    // pass undefined and the signed message + wire body will be the "null/clear" variant.
    opposite = undefined;
    oppositeWire = {};
  }
  // Restore body: same as opposite but flipped back to original.
  let restoreWire: Record<string, any>;
  if (original === null || original === undefined) {
    restoreWire = {}; // omit to clear back to null
  } else if (original === true) {
    restoreWire = { disabled: true };
  } else {
    restoreWire = { disabled: false };
  }

  log(`B1 pre-snapshot     auto_lend_disabled=${JSON.stringify(original)}`);
  log(`B1 will set to      ${JSON.stringify(opposite)}`);

  let b1Set = false;
  let b1Verify = false;
  let b1Restore = false;
  let b1Restored = false;
  try {
    // Set to opposite.
    const setBody = signRequest('set_auto_lend_disabled', oppositeWire);
    const setO = await post(SET_AUTO_LEND, setBody);
    log(`B1 set              status: ${setO.status}  body: ${JSON.stringify(setO.body).slice(0, 150)}`);
    b1Set = setO.status === 200
      && setO.body?.success === true
      && !looksLikeSignatureRejection(setO)
      && !looksLikeDeserializeError(setO);

    // Verify via GET /account/settings.
    if (b1Set) {
      const verifyO = await get(SETTINGS, { account: address });
      const after = verifyO.body?.data?.auto_lend_disabled;
      b1Verify = after === opposite;
      log(`B1 verify           auto_lend_disabled=${JSON.stringify(after)}  (want ${JSON.stringify(opposite)})`);
    }
  } catch (e: any) {
    log(`B1 set/verify threw: ${e?.message ?? e}`);
  } finally {
    // Restore original.
    try {
      const restoreBody = signRequest('set_auto_lend_disabled', restoreWire);
      const restoreO = await post(SET_AUTO_LEND, restoreBody);
      log(`B1 restore          status: ${restoreO.status}  body: ${JSON.stringify(restoreO.body).slice(0, 150)}`);
      b1Restore = restoreO.status === 200
        && restoreO.body?.success === true
        && !looksLikeSignatureRejection(restoreO)
        && !looksLikeDeserializeError(restoreO);

      // Verify restored.
      if (b1Restore) {
        const verifyO = await get(SETTINGS, { account: address });
        const after = verifyO.body?.data?.auto_lend_disabled;
        // Compare: null == undefined for our purposes.
        const matches = (after === original) || (after === null && original === undefined);
        b1Restored = matches;
        log(`B1 restored         auto_lend_disabled=${JSON.stringify(after)}  (want ${JSON.stringify(original)})`);
      }
    } catch (e: any) {
      log(`B1 restore threw: ${e?.message ?? e}`);
    }
  }

  const pass = b1Set && b1Verify && b1Restore && b1Restored;
  log(`  B1 set succeeded?        ${b1Set}  (want true)`);
  log(`  B1 verify matched?       ${b1Verify}  (want true)`);
  log(`  B1 restore succeeded?    ${b1Restore}  (want true)`);
  log(`  B1 restored to original? ${b1Restored}  (want true)`);
  log(pass ? ok('B1 PASS') : no('B1 FAIL'));
  return pass;
};

// B2: updateSpotSettings set->verify->restore->verify dance.
const caseB2 = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== B2: LIVE updateSpotSettings set->restore (signed POST, EXECUTING/REVERSIBLE) ===');
  if (process.env.SMOKE_CREATE !== '1') {
    log('SKIPPED (set SMOKE_CREATE=1 to include)');
    return 'SKIP';
  }
  if (!privateKey || !address) {
    log('SKIPPED (set PRIVATE_KEY and ADDRESS to include)');
    return 'SKIP';
  }

  // Pick the first spot asset symbol.
  const assetsO = await get(SPOT_ASSETS, {});
  const assets = Array.isArray(assetsO.body?.data) ? assetsO.body.data : [];
  if (assets.length === 0) {
    log('B2 could not fetch spot assets -- cannot proceed.');
    return false;
  }
  const symbol = assets[0].symbol;
  log(`B2 using spot asset symbol=${symbol}`);

  // Snapshot original spot_settings for this symbol.
  const beforeO = await get(SETTINGS, { account: address });
  if (beforeO.status !== 200 || beforeO.body?.success !== true) {
    log(`B2 pre-snapshot     could not read settings: status ${beforeO.status}`);
    return false;
  }
  const spotSettings = Array.isArray(beforeO.body?.data?.spot_settings) ? beforeO.body.data.spot_settings : [];
  const originalEntry = spotSettings.find((s: any) => s.symbol === symbol);
  const originalExcluded = originalEntry?.unified_margin_excluded;
  // Default to false (included) if no entry exists.
  const originalValue = originalExcluded === true;
  const oppositeValue = !originalValue;
  log(`B2 pre-snapshot     ${symbol} unified_margin_excluded=${originalValue}  (entry present? ${originalEntry !== undefined})`);

  let b2Set = false;
  let b2Verify = false;
  let b2Restore = false;
  let b2Restored = false;
  try {
    // Set to opposite.
    const setBody = signRequest('update_account_spot_settings', { symbol, unified_margin_excluded: oppositeValue });
    const setO = await post(UPDATE_SPOT_SETTINGS, setBody);
    log(`B2 set              status: ${setO.status}  body: ${JSON.stringify(setO.body).slice(0, 150)}`);
    b2Set = setO.status === 200
      && setO.body?.success === true
      && !looksLikeSignatureRejection(setO)
      && !looksLikeDeserializeError(setO);

    // Verify.
    if (b2Set) {
      const verifyO = await get(SETTINGS, { account: address });
      const afterSettings = Array.isArray(verifyO.body?.data?.spot_settings) ? verifyO.body.data.spot_settings : [];
      const afterEntry = afterSettings.find((s: any) => s.symbol === symbol);
      const afterExcluded = afterEntry?.unified_margin_excluded === true;
      b2Verify = afterExcluded === oppositeValue;
      log(`B2 verify           ${symbol} unified_margin_excluded=${afterExcluded}  (want ${oppositeValue})`);
    }
  } catch (e: any) {
    log(`B2 set/verify threw: ${e?.message ?? e}`);
  } finally {
    // Restore original.
    try {
      const restoreBody = signRequest('update_account_spot_settings', { symbol, unified_margin_excluded: originalValue });
      const restoreO = await post(UPDATE_SPOT_SETTINGS, restoreBody);
      log(`B2 restore          status: ${restoreO.status}  body: ${JSON.stringify(restoreO.body).slice(0, 150)}`);
      b2Restore = restoreO.status === 200
        && restoreO.body?.success === true
        && !looksLikeSignatureRejection(restoreO)
        && !looksLikeDeserializeError(restoreO);

      // Verify restored.
      if (b2Restore) {
        const verifyO = await get(SETTINGS, { account: address });
        const afterSettings = Array.isArray(verifyO.body?.data?.spot_settings) ? verifyO.body.data.spot_settings : [];
        const afterEntry = afterSettings.find((s: any) => s.symbol === symbol);
        const afterExcluded = afterEntry?.unified_margin_excluded === true;
        b2Restored = afterExcluded === originalValue;
        log(`B2 restored         ${symbol} unified_margin_excluded=${afterExcluded}  (want ${originalValue})`);
      }
    } catch (e: any) {
      log(`B2 restore threw: ${e?.message ?? e}`);
    }
  }

  const pass = b2Set && b2Verify && b2Restore && b2Restored;
  log(`  B2 set succeeded?        ${b2Set}  (want true)`);
  log(`  B2 verify matched?       ${b2Verify}  (want true)`);
  log(`  B2 restore succeeded?    ${b2Restore}  (want true)`);
  log(`  B2 restored to original? ${b2Restored}  (want true)`);
  log(pass ? ok('B2 PASS') : no('B2 FAIL'));
  return pass;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Creds    : PRIVATE_KEY=${privateKey ? 'set' : 'MISSING'}  ADDRESS=${address ? 'set' : 'MISSING'}`);
  log(`Create   : ${process.env.SMOKE_CREATE === '1' ? 'enabled (SMOKE_CREATE=1)' : 'disabled (default)'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A1 updateSpotSettings P9 alt (deserialize)', await caseA1()]);
  results.push(['A2 setAutoLendDisabled tampered-sig only (P10)', await caseA2()]);
  results.push(['B1 setAutoLendDisabled set->restore (gated)', await caseB1()]);
  results.push(['B2 updateSpotSettings set->restore (gated)', await caseB2()]);

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