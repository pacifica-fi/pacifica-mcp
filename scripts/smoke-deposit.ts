/**
 * Deposit smoke test (depositUsdp / src/tools/deposit.ts).
 *
 * Imports the REAL exports from src/tools/deposit.ts + src/tools/onchain.ts so it
 * tests the shipped code path directly (not a mirror).
 *
 *   LAYER 0  offline structural/correctness   (always runs; no creds, no network)
 *     Case A  network config      resolveOnchainConfig: testnet fully known;
 *                                  mainnet errors with no program id, resolves with one.
 *     Case B  built instruction   buildDepositIx does not throw, derives the
 *                                  depositor USDC ATA + exchange vault (= central_state
 *                                  ATA, == the known vault), encodes amount * 1e6, and
 *                                  carries the IDL's full account set.
 *     Case C  no-key guard        depositUsdp without a key returns the error response.
 *     Case D  mainnet guard        depositUsdp on mainnet with no program id refuses
 *                                  (no network call), rather than guessing an address.
 *
 *   LAYER 1  live deposit         (gated: SMOKE_DEPOSIT=1 + PRIVATE_KEY; testnet)
 *     Case E  real deposit        tops the wallet up via mintUsdp if needed, deposits,
 *                                  and asserts the exchange /account balance increases
 *                                  (authoritative) and the wallet USDP balance falls.
 *
 * Run:  npm run smoke:deposit
 *       SMOKE_DEPOSIT=1 PRIVATE_KEY=<base58> npm run smoke:deposit
 *   (SOLANA_RPC_URL optional; defaults to the public devnet RPC, same as the server.)
 */
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { log, ok, no, privateKey, BASE_URL, get } from './signing-helpers.js';
import {
  resolveOnchainConfig,
  idlProgramId,
  deriveCentralState,
  loadIdl,
  makeProgram,
  TESTNET_USDC_MINT,
  MAINNET_USDC_MINT,
} from '../src/tools/onchain.js';
import { buildDepositIx, depositUsdp } from '../src/tools/deposit.js';
import { mintTestUsdp } from '../src/tools/faucet.js';

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const DEPOSIT_AMOUNT = Number(process.env.SMOKE_DEPOSIT_AMOUNT ?? '50');
const KNOWN_VAULT = '5SDFdHZGTZbyRYu54CgmRkCGnPHC5pYaN27p7XGLqnBs';
const KNOWN_CENTRAL_STATE = '2zPRq1Qvdq5A4Ld6WsH7usgCge4ApZRYfhhf5VAjfXxv';

// deterministic, network-free dummy keypair + its base58 secret (for offline build).
const dummyKeypair = Keypair.fromSeed(new Uint8Array(32).fill(7));
const dummySecret = bs58.encode(dummyKeypair.secretKey);

// run fn with PACIFICA_PROGRAM_ID forced to a value (or unset), then restore.
const withProgramIdEnv = <T>(value: string | undefined, fn: () => T): T => {
  const saved = process.env.PACIFICA_PROGRAM_ID;
  if (value === undefined) delete process.env.PACIFICA_PROGRAM_ID;
  else process.env.PACIFICA_PROGRAM_ID = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.PACIFICA_PROGRAM_ID;
    else process.env.PACIFICA_PROGRAM_ID = saved;
  }
};

// --- cases ------------------------------------------------------------------

// Case A: network config resolution for both networks.
const caseA = (): boolean => {
  log('\n=== Case A: network config (offline) ===');
  try {
    // testnet: fully known from the shipped IDL.
    const t = resolveOnchainConfig('https://test-api.pacifica.fi');
    if ('error' in t) { log(no(`Case A FAIL — testnet errored: ${t.error}`)); return false; }
    const testnetOk =
      t.network === 'testnet'
      && t.programId.toBase58() === idlProgramId()
      && t.usdcMint.toBase58() === TESTNET_USDC_MINT
      && t.centralState.toBase58() === KNOWN_CENTRAL_STATE;
    log(`  testnet: program=${t.programId.toBase58()} usdc=${t.usdcMint.toBase58()} cs=${t.centralState.toBase58()}`);
    log(`  testnet resolves correctly? ${testnetOk}`);

    // mainnet without a program id: must refuse (no guessing).
    const mNoCfg = withProgramIdEnv(undefined, () => resolveOnchainConfig('https://api.pacifica.fi'));
    const mainnetRefuses = 'error' in mNoCfg;
    log(`  mainnet w/o program id refuses? ${mainnetRefuses}`);

    // mainnet with a program id: resolves, real USDC mint, derived central_state.
    const mCfg = withProgramIdEnv(idlProgramId(), () => resolveOnchainConfig('https://api.pacifica.fi'));
    const mainnetOk = !('error' in mCfg)
      && mCfg.network === 'mainnet'
      && mCfg.usdcMint.toBase58() === MAINNET_USDC_MINT
      && mCfg.centralState.toBase58() === deriveCentralState(new PublicKey(idlProgramId())).toBase58();
    log(`  mainnet w/ program id resolves (real USDC + derived cs)? ${mainnetOk}`);

    const pass = testnetOk && mainnetRefuses && mainnetOk;
    log(pass ? ok('Case A PASS') : no('Case A FAIL'));
    return pass;
  } catch (e: any) {
    log(no(`Case A FAIL — ${e.message}`));
    return false;
  }
};

// Case B: built deposit instruction (offline, testnet config).
const caseB = async (): Promise<boolean> => {
  log('\n=== Case B: built deposit instruction (offline) ===');
  try {
    const programId = new PublicKey(idlProgramId());
    const { program, keypair } = makeProgram(dummySecret, 'http://127.0.0.1:8899', programId);
    const owner = keypair.publicKey;
    const usdcMint = new PublicKey(TESTNET_USDC_MINT);
    const centralState = deriveCentralState(programId);

    const { instruction, depositorUsdcAta, pacificaVault } =
      await buildDepositIx(program, owner, usdcMint, centralState, 50);

    const ataOk = depositorUsdcAta.equals(getAssociatedTokenAddressSync(usdcMint, owner));
    const vaultOk = pacificaVault.equals(getAssociatedTokenAddressSync(usdcMint, centralState, true))
      && pacificaVault.toBase58() === KNOWN_VAULT;
    const csOk = centralState.toBase58() === KNOWN_CENTRAL_STATE;

    const decoded = program.coder.instruction.decode(instruction.data);
    const amountOk = decoded?.name === 'deposit'
      && decoded?.data?.amount?.toString() === String(50 * 1_000_000);

    // account count must match the IDL's deposit account list (event_authority +
    // program are resolved by anchor).
    const idl = loadIdl() as any;
    const expectedCount = idl.instructions.find((i: any) => i.name === 'deposit').accounts.length;
    const keysOk = instruction.keys.length === expectedCount;

    log(`  built without throwing?        true`);
    log(`  depositor USDC ATA correct?    ${ataOk}  (${depositorUsdcAta.toBase58()})`);
    log(`  vault == central_state ATA?    ${vaultOk}  (${pacificaVault.toBase58()})`);
    log(`  central_state derived?         ${csOk}  (${centralState.toBase58()})`);
    log(`  decoded ${decoded?.name} amount=${decoded?.data?.amount?.toString()}  ok? ${amountOk}`);
    log(`  account count == IDL (${expectedCount})?     ${keysOk} (${instruction.keys.length})`);

    const pass = ataOk && vaultOk && csOk && amountOk && keysOk;
    log(pass ? ok('Case B PASS') : no('Case B FAIL'));
    return pass;
  } catch (e: any) {
    log(no(`Case B FAIL — threw: ${e.message}`));
    return false;
  }
};

// Case C: no-key guard.
const caseC = async (): Promise<boolean> => {
  log('\n=== Case C: no-key guard (offline) ===');
  try {
    const res = await depositUsdp({
      privateKey: undefined, rpcUrl: 'http://127.0.0.1:1', baseUrl: 'https://test-api.pacifica.fi', amount: 1,
    });
    const text = res?.content?.[0]?.text ?? '';
    log(`  response: ${text}`);
    const pass = /PRIVATE_KEY/.test(text);
    log(pass ? ok('Case C PASS') : no('Case C FAIL'));
    return pass;
  } catch (e: any) {
    log(no(`Case C FAIL — threw (should have returned an error response): ${e.message}`));
    return false;
  }
};

// Case D: mainnet without a configured program id must refuse (no network call).
const caseD = async (): Promise<boolean> => {
  log('\n=== Case D: mainnet-unconfigured guard (offline) ===');
  try {
    const res = await withProgramIdEnv(undefined, () => depositUsdp({
      privateKey: dummySecret, rpcUrl: 'http://127.0.0.1:1', baseUrl: 'https://api.pacifica.fi', amount: 1,
    }));
    const text = res?.content?.[0]?.text ?? '';
    log(`  response: ${text}`);
    const pass = /not.*set|PACIFICA_PROGRAM_ID|mainnet/i.test(text) && /Error/.test(text);
    log(pass ? ok('Case D PASS') : no('Case D FAIL'));
    return pass;
  } catch (e: any) {
    log(no(`Case D FAIL — threw (should have returned an error response): ${e.message}`));
    return false;
  }
};

// Case E: live testnet deposit. Gated; SKIPPED unless SMOKE_DEPOSIT=1 + PRIVATE_KEY.
const caseE = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case E: live deposit (testnet) ===');
  if (process.env.SMOKE_DEPOSIT !== '1' || !privateKey) {
    log('SKIPPED (set SMOKE_DEPOSIT=1 and PRIVATE_KEY to include)');
    return 'SKIP';
  }

  const connection = new Connection(RPC, 'confirmed');
  const owner = Keypair.fromSecretKey(bs58.decode(privateKey)).publicKey;
  const usdpAta = getAssociatedTokenAddressSync(new PublicKey(TESTNET_USDC_MINT), owner);

  // best-effort devnet SOL for gas.
  const sol = await connection.getBalance(owner);
  if (sol < 0.02 * LAMPORTS_PER_SOL) {
    log('  airdropping 1 devnet SOL for gas...');
    try {
      const sig = await connection.requestAirdrop(owner, 1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    } catch (e: any) {
      log(`  airdrop failed (${String(e.message).slice(0, 60)}...) — proceeding with ${sol / LAMPORTS_PER_SOL} SOL`);
    }
  }

  const walletBal = async (): Promise<number> => {
    try { return Number((await connection.getTokenAccountBalance(usdpAta)).value.amount); }
    catch { return 0; }
  };
  const exchangeBal = async (): Promise<number> => {
    const o = await get('/api/v1/account', { account: owner.toBase58() });
    const b = Number(o.body?.data?.balance ?? 'NaN');
    return Number.isFinite(b) ? b : 0;
  };

  // ensure the wallet holds enough USDP to deposit (mint a buffer if short).
  if (await walletBal() < DEPOSIT_AMOUNT * 1_000_000) {
    log(`  wallet short on USDP — minting ${DEPOSIT_AMOUNT * 2} first...`);
    try { await mintTestUsdp({ privateKey, rpcUrl: RPC, amount: DEPOSIT_AMOUNT * 2 }); }
    catch (e: any) { log(no(`Case E FAIL — pre-mint threw: ${e.message}`)); return false; }
  }

  const walletBefore = await walletBal();
  const exchBefore = await exchangeBal();
  log(`  wallet USDP before: ${walletBefore / 1_000_000}   exchange balance before: ${exchBefore}`);

  let signature: string;
  try {
    const res = await depositUsdp({ privateKey, rpcUrl: RPC, baseUrl: BASE_URL, amount: DEPOSIT_AMOUNT });
    const parsed = JSON.parse(res.content[0].text);
    signature = parsed.signature;
    log(`  deposit signature: ${signature}  (network: ${parsed.network})`);
    if (!signature || typeof signature !== 'string') { log(no('Case E FAIL — no signature returned')); return false; }
  } catch (e: any) {
    log(no(`Case E FAIL — deposit threw: ${e.message}`));
    return false;
  }

  // poll the exchange balance (authoritative: deposit credits the exchange account).
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const exchAfter = await exchangeBal();
    log(`  exchange balance after: ${exchAfter}`);
    if (exchAfter - exchBefore >= DEPOSIT_AMOUNT * 0.99) {
      const walletAfter = await walletBal();
      const walletDropped = (walletBefore - walletAfter) >= DEPOSIT_AMOUNT * 1_000_000 * 0.99;
      log(`  wallet USDP after: ${walletAfter / 1_000_000}  (dropped by ~deposit? ${walletDropped})`);
      const pass = walletDropped;
      log(pass ? ok('Case E PASS — exchange credited and wallet debited') : no('Case E FAIL — wallet did not drop'));
      return pass;
    }
  }
  log(no('Case E FAIL — exchange balance did not reflect the deposit within 60s'));
  return false;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`RPC      : ${RPC}`);
  log(`Base URL : ${BASE_URL}`);
  log(`Creds    : PRIVATE_KEY=${privateKey ? 'set' : 'MISSING'}  SMOKE_DEPOSIT=${process.env.SMOKE_DEPOSIT ?? '0'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A network config', caseA()]);
  results.push(['B built instruction', await caseB()]);
  results.push(['C no-key guard', await caseC()]);
  results.push(['D mainnet guard', await caseD()]);
  results.push(['E live deposit', await caseE()]);

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
