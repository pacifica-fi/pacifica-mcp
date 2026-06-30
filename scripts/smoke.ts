/**
 * Live signing smoke test (Tier 0a).
 *
 * Fires a signed POST against the Pacifica testnet to prove that the request
 * signing scheme and POST body shape used by src/index.ts are accepted by the
 * live API. This is a DIFFERENTIAL test: it sends two requests --
 *   1. a correctly-signed body, and
 *   2. the same body with one byte of the signature corrupted.
 * The scheme is confirmed only if the API does NOT reject (1) for a signature
 * reason AND DOES reject (2). A lone 200 is not trusted, since it could mean the
 * endpoint never really verified the signature.
 *
 * The signing helpers come from scripts/signing-helpers.ts, which keeps a copy of
 * the src/index.ts signing scheme that is independent of the server (so this test
 * can catch a regression there). Keep that file in sync if the scheme changes.
 *
 * Run:  PRIVATE_KEY=... ADDRESS=... npm run smoke
 *   (PACIFICA_BASE_URL optional; defaults to testnet, same as the server.)
 */
import {
  BASE_URL, privateKey, address,
  signRequest, tamperSignature, post,
  looksLikeSignatureRejection,
} from './signing-helpers.js';

// The operation under test: cancelAllOrders. Non-destructive -- if no BTC orders
// are open it cancels nothing, but the request still requires a valid signature.
const OP_TYPE = 'cancel_all_orders';
const OP_PATH = '/api/v1/orders/cancel_all';
// Note: exclude_reduce_only is a required boolean per the live API (the running
// cancelAllOrders tool in src/index.ts omits it -- a separate Tier-1 bug).
const OP_PAYLOAD: Record<string, any> = { symbol: 'BTC', all_symbols: false, exclude_reduce_only: false };

const main = async () => {
  if (!privateKey || !address) {
    console.error('Missing creds. Set PRIVATE_KEY (base58 secret) and ADDRESS (pubkey).');
    console.error('e.g.  PRIVATE_KEY=... ADDRESS=... npm run smoke');
    process.exit(2);
  }

  console.log(`Base URL : ${BASE_URL}`);
  console.log(`Operation: ${OP_TYPE} ${OP_PATH}`);
  console.log(`Payload  : ${JSON.stringify(OP_PAYLOAD)}\n`);

  // 1. correctly-signed request
  const good = signRequest(OP_TYPE, OP_PAYLOAD);
  const goodOutcome = await post(OP_PATH, good);
  console.log('--- correctly signed ---');
  console.log(`status: ${goodOutcome.status}`);
  console.log(`body  : ${JSON.stringify(goodOutcome.body)}\n`);

  // 2. same request, corrupted signature
  const bad = { ...good, signature: tamperSignature(good.signature) };
  const badOutcome = await post(OP_PATH, bad);
  console.log('--- tampered signature ---');
  console.log(`status: ${badOutcome.status}`);
  console.log(`body  : ${JSON.stringify(badOutcome.body)}\n`);

  // verdict
  const goodRejected = looksLikeSignatureRejection(goodOutcome);
  const badRejected = looksLikeSignatureRejection(badOutcome);
  console.log('=== verdict ===');
  console.log(`correctly-signed rejected for signature reason? ${goodRejected}  (want: false)`);
  console.log(`tampered rejected for signature reason?         ${badRejected}  (want: true)`);

  if (!goodRejected && badRejected) {
    console.log('\nPASS — signing scheme accepted; tampering correctly rejected.');
    process.exit(0);
  }
  console.log('\nFAIL — see statuses/bodies above. The keyword heuristic may also');
  console.log('need adjusting to the exact error text Pacifica returns.');
  process.exit(1);
};

main();
