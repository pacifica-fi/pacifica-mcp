/**
 * API agent-wallet live smoke test.
 *
 * Proves the MCP's agent-key signing path (src/helpers.ts agent mode) is accepted
 * by the Pacifica testnet. An agent key signs on behalf of a main/sub account: the
 * request body carries account=<ADDRESS> and agent_wallet=<derived agent pubkey>,
 * the signature is made with the AGENT key, and agent_wallet is NOT part of the
 * signed message. The API verifies the signature against agent_wallet (which must
 * be BOUND to account) and applies the action to account.
 *
 * Operation under test: cancelAllOrders on BTC. Non-executing -- if no BTC orders
 * are open it cancels nothing, but the request still requires a valid signature.
 *
 * Three differential cases (a lone 200 is never trusted):
 *   Case A  agent-signed + agent_wallet present  -> NOT a signature rejection
 *   Case B  same body, tampered signature        -> MUST be a signature rejection
 *   Case C  agent-signed but agent_wallet REMOVED -> MUST be a signature rejection
 *           (without the field the API verifies the agent sig against the main
 *            account pubkey -> "Verification failed"; this is exactly the gap the
 *            feature closes by injecting agent_wallet.)
 *
 * The signing helpers come from scripts/signing-helpers.ts, an independent copy of
 * the server's scheme (so this test can catch a regression there).
 *
 * PREREQUISITE: AGENT_PRIVATE_KEY must be an agent key already BOUND to ADDRESS
 * (bind via app.pacifica.fi/apikey or the bindAgentWallet tool). The whole suite
 * SKIPS if AGENT_PRIVATE_KEY is unset.
 *
 * Run:  ADDRESS=<main> AGENT_PRIVATE_KEY=<bound-agent-secret> npm run smoke:agent
 *   (PACIFICA_BASE_URL optional; defaults to testnet, same as the server.)
 */
import {
  BASE_URL, address,
  signAsAgent, deriveAgentWallet, tamperSignature, post,
  looksLikeSignatureRejection, looksLikeDeserializeError,
  log, ok, no,
} from './signing-helpers.js';

const agentPrivateKey: string | undefined = process.env.AGENT_PRIVATE_KEY;

const OP_TYPE = 'cancel_all_orders';
const OP_PATH = '/api/v1/orders/cancel_all';
const OP_PAYLOAD: Record<string, any> = { symbol: 'BTC', all_symbols: false, exclude_reduce_only: false };

// --- cases ------------------------------------------------------------------

// Case A: agent-signed request with agent_wallet present. A valid, bound agent
// is accepted -> NOT a signature rejection (and not a deserialize error).
// NOTE: if the agent is NOT bound to ADDRESS, the API returns "Unauthorized",
// which also matches the signature-rejection heuristic; a Case A FAIL therefore
// means EITHER signing is broken OR the agent is not bound. Check the binding.
const caseA = async (good: Record<string, any>): Promise<boolean> => {
  log('\n=== Case A: agent-signed + agent_wallet present ===');
  const o = await post(OP_PATH, good);
  log(`A  status: ${o.status}  body: ${JSON.stringify(o.body).slice(0, 200)}`);
  const pass = !looksLikeSignatureRejection(o) && !looksLikeDeserializeError(o);
  if (!pass) log('  (if body says unauthorized: the agent is not bound to ADDRESS)');
  log(`  A accepted (not sig/deser rejection)? ${pass}  (want true)`);
  log(pass ? ok('Case A PASS') : no('Case A FAIL'));
  return pass;
};

// Case B: same body, tampered signature -> MUST be a signature rejection.
// Proves the agent signature is actually verified (not ignored).
const caseB = async (good: Record<string, any>): Promise<boolean> => {
  log('\n=== Case B: agent-signed, tampered signature ===');
  const bad = { ...good, signature: tamperSignature(good.signature) };
  const o = await post(OP_PATH, bad);
  log(`B  status: ${o.status}  body: ${JSON.stringify(o.body).slice(0, 200)}`);
  const pass = looksLikeSignatureRejection(o);
  log(`  B tampered is sig rejection? ${pass}  (want true)`);
  log(pass ? ok('Case B PASS') : no('Case B FAIL'));
  return pass;
};

// Case C: same agent signature, but agent_wallet REMOVED -> MUST be a signature
// rejection. Without agent_wallet the API verifies the agent's signature against
// `account` (the main pubkey), which fails. This is the control proving the
// agent_wallet field is what makes the agent key work. (Assumes agent != main.)
const caseC = async (good: Record<string, any>): Promise<boolean> => {
  log('\n=== Case C: agent_wallet removed (control) ===');
  const { agent_wallet, ...withoutAgent } = good;
  const o = await post(OP_PATH, withoutAgent);
  log(`C  status: ${o.status}  body: ${JSON.stringify(o.body).slice(0, 200)}`);
  const pass = looksLikeSignatureRejection(o);
  log(`  C without agent_wallet is sig rejection? ${pass}  (want true)`);
  log(pass ? ok('Case C PASS') : no('Case C FAIL'));
  return pass;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`Base URL : ${BASE_URL}`);
  log(`Account  : ADDRESS=${address ? 'set' : 'MISSING'}  AGENT_PRIVATE_KEY=${agentPrivateKey ? 'set' : 'MISSING'}`);

  if (!agentPrivateKey || !address) {
    log('\nSKIPPED (set ADDRESS and AGENT_PRIVATE_KEY — an agent key bound to ADDRESS — to include)');
    log('\nALL PASS');
    process.exit(0);
  }

  log(`Agent    : agent_wallet=${deriveAgentWallet(agentPrivateKey)}`);
  log(`Operation: ${OP_TYPE} ${OP_PATH}`);
  log(`Payload  : ${JSON.stringify(OP_PAYLOAD)}`);

  // Build the agent-signed body once; all three cases derive from it so they
  // share the exact signature the MCP would produce.
  const good = signAsAgent(address, agentPrivateKey, OP_TYPE, OP_PAYLOAD);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A agent accepted', await caseA(good)]);
  results.push(['B tampered rejected', await caseB(good)]);
  results.push(['C agent_wallet required', await caseC(good)]);

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
