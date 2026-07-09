/**
 * Faucet smoke test (mintUsdp / src/tools/faucet.ts).
 *
 * Comprehensive coverage for the testnet faucet tool. Imports the REAL exports
 * from src/tools/faucet.ts (not an independent mirror) so it tests the shipped
 * code path directly.
 *
 *   LAYER 0  offline structural/correctness   (always runs; no creds, no network)
 *     Case A  IDL + PDA seed       mint_test_usdc present; declared user_account
 *                                  seed decodes to "user_account" and matches the
 *                                  exported USER_ACCOUNT_SEED.
 *     Case B  built instruction    buildMintTestUsdcIx does not throw (BN interop),
 *                                  derives the IDL-correct user_account PDA, encodes
 *                                  amount * 1e6, and derives the canonical USDP ATA.
 *     Case C  testnet gating       isFaucetEnabled true for testnet, false for prod.
 *     Case D  no-key guard         mintTestUsdp without a key returns the error
 *                                  response and makes no network call.
 *
 *   LAYER 1  live mint             (gated: SMOKE_FAUCET_MINT=1 + PRIVATE_KEY)
 *     Case E  real mint            mints on devnet and asserts the wallet's USDP
 *                                  token balance increases by ~amount. SKIPPED by
 *                                  default (mirrors the SMOKE_CREATE=1 gate in
 *                                  scripts/smoke-1c.ts).
 *
 * Note: mintUsdp mints to the wallet's USDP token account only -- it does NOT
 * deposit into the exchange account (that is scripts/fund-account.ts's extra
 * `deposit` step), so the exchange /account balance is intentionally not checked.
 *
 * Run:  npm run smoke:faucet
 *       SMOKE_FAUCET_MINT=1 PRIVATE_KEY=<base58> npm run smoke:faucet
 *   (SOLANA_RPC_URL optional; defaults to the public devnet RPC, same as the server.)
 */
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { log, ok, no, privateKey } from './signing-helpers.js';
import {
  loadFaucetIdl,
  buildMintTestUsdcIx,
  mintTestUsdp,
  isFaucetEnabled,
  USER_ACCOUNT_SEED,
  USDP_MINT,
} from '../src/tools/faucet.js';

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const MINT_AMOUNT = Number(process.env.SMOKE_FAUCET_AMOUNT ?? '100');

// A deterministic, network-free keypair for the offline cases (seed = all 7s).
const dummyKeypair = Keypair.fromSeed(new Uint8Array(32).fill(7));

// Build an offline Anchor Program from the shipped IDL. The Connection is
// constructed but never used (Case A/B only call .instruction(), which is local).
const offlineProgram = (): { program: any; programId: PublicKey } => {
  const provider = new anchor.AnchorProvider(
    new Connection('http://127.0.0.1:8899'),
    new anchor.Wallet(dummyKeypair),
    { commitment: 'confirmed' },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new anchor.Program(loadFaucetIdl(), provider) as any;
  return { program, programId: program.programId };
};

// Pull the `mint_test_usdc` instruction's `user_account` const seed bytes out of
// the IDL -- the authoritative source of truth for the PDA seed.
const idlUserAccountSeedBytes = (): number[] => {
  const idl = loadFaucetIdl() as any;
  const ix = idl.instructions.find((i: any) => i.name === 'mint_test_usdc');
  if (!ix) throw new Error('mint_test_usdc not found in IDL');
  const acc = ix.accounts.find((a: any) => a.name === 'user_account');
  const constSeed = acc?.pda?.seeds?.find((s: any) => s.kind === 'const');
  if (!constSeed) throw new Error('user_account const seed not found in IDL');
  return constSeed.value as number[];
};

// --- cases ------------------------------------------------------------------

// Case A: IDL parses, mint_test_usdc exists, and the declared user_account seed
// decodes to "user_account" AND matches the exported USER_ACCOUNT_SEED. This is
// the regression guard for the "user-account" (hyphen) seed bug.
const caseA = (): boolean => {
  log('\n=== Case A: IDL + PDA seed (offline) ===');
  try {
    const idl = loadFaucetIdl() as any;
    const hasMint = Array.isArray(idl.instructions)
      && idl.instructions.some((i: any) => i.name === 'mint_test_usdc');
    const seedBytes = idlUserAccountSeedBytes();
    const decoded = Buffer.from(seedBytes).toString('utf8');
    log(`  mint_test_usdc present?        ${hasMint}`);
    log(`  IDL user_account seed decodes: "${decoded}"`);
    log(`  exported USER_ACCOUNT_SEED:    "${USER_ACCOUNT_SEED}"`);
    const seedOk = decoded === 'user_account' && USER_ACCOUNT_SEED === decoded;
    const pass = hasMint && seedOk;
    log(pass ? ok('Case A PASS') : no('Case A FAIL'));
    return pass;
  } catch (e: any) {
    log(no(`Case A FAIL — ${e.message}`));
    return false;
  }
};

// Case B: buildMintTestUsdcIx builds the instruction offline. Asserts no throw
// (BN interop), the IDL-correct user_account PDA (derivation + submitted key),
// the encoded amount, the canonical USDP ATA, and the account count.
const caseB = async (): Promise<boolean> => {
  log('\n=== Case B: built mint instruction (offline) ===');
  try {
    const { program, programId } = offlineProgram();
    const owner = dummyKeypair.publicKey;

    const { instruction, userAccount, userUsdcATA } =
      await buildMintTestUsdcIx(program, owner, 10000);

    // Expected PDA from the IDL's own declared seed bytes (source of truth).
    const [expectedPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(idlUserAccountSeedBytes()), owner.toBuffer()],
      programId,
    );
    const derivationOk = userAccount.equals(expectedPda);

    // The submitted key at the user_account slot must equal the same PDA (guards
    // against Anchor using an explicitly-passed wrong value).
    const idl = loadFaucetIdl() as any;
    const order = idl.instructions
      .find((i: any) => i.name === 'mint_test_usdc')
      .accounts.map((a: any) => a.name);
    const slot = order.indexOf('user_account');
    const submittedKey = instruction.keys[slot].pubkey as PublicKey;
    const submittedOk = submittedKey.equals(expectedPda);

    // Decode the instruction data: name + amount (10000 USDP -> 10_000_000_000 base units).
    const decoded = program.coder.instruction.decode(instruction.data);
    const amountOk = decoded?.name === 'mintTestUsdc'
      && decoded?.data?.amount?.toString() === String(10000 * 1_000_000);

    // ATA matches an independent SPL derivation.
    const expectedAta = getAssociatedTokenAddressSync(new PublicKey(USDP_MINT), owner);
    const ataOk = userUsdcATA.equals(expectedAta);

    const keysOk = instruction.keys.length === 8;

    log(`  built without throwing?        true`);
    log(`  userAccount == IDL PDA?        ${derivationOk}  (${userAccount.toBase58()})`);
    log(`  submitted user_account key ok? ${submittedOk}`);
    log(`  decoded ${decoded?.name} amount=${decoded?.data?.amount?.toString()}  ok? ${amountOk}`);
    log(`  USDP ATA == SPL derivation?    ${ataOk}  (${userUsdcATA.toBase58()})`);
    log(`  account count == 8?            ${keysOk} (${instruction.keys.length})`);

    const pass = derivationOk && submittedOk && amountOk && ataOk && keysOk;
    log(pass ? ok('Case B PASS') : no('Case B FAIL'));
    return pass;
  } catch (e: any) {
    // A throw here is itself a failure — notably the `anchor.BN is not a
    // constructor` interop bug this case is meant to catch.
    log(no(`Case B FAIL — threw: ${e.message}`));
    return false;
  }
};

// Case C: testnet gating. isFaucetEnabled must be true for the testnet host and
// false for the production host.
const caseC = (): boolean => {
  log('\n=== Case C: testnet gating (offline) ===');
  const testnet = isFaucetEnabled('https://test-api.pacifica.fi');
  const prod = isFaucetEnabled('https://api.pacifica.fi');
  log(`  isFaucetEnabled(testnet) = ${testnet}  (want true)`);
  log(`  isFaucetEnabled(prod)    = ${prod}  (want false)`);
  const pass = testnet === true && prod === false;
  log(pass ? ok('Case C PASS') : no('Case C FAIL'));
  return pass;
};

// Case D: no-key guard. mintTestUsdp without a private key must return the error
// response (and not attempt any network call). Uses an unreachable RPC to prove
// no connection is made — the call still returns promptly with the guard message.
const caseD = async (): Promise<boolean> => {
  log('\n=== Case D: no-key guard (offline) ===');
  try {
    const res = await mintTestUsdp({ privateKey: undefined, rpcUrl: 'http://127.0.0.1:1', amount: 1 });
    const text = res?.content?.[0]?.text ?? '';
    log(`  response: ${text}`);
    const pass = /PRIVATE_KEY/.test(text);
    log(pass ? ok('Case D PASS') : no('Case D FAIL'));
    return pass;
  } catch (e: any) {
    log(no(`Case D FAIL — threw (should have returned an error response): ${e.message}`));
    return false;
  }
};

// Case E: live mint on devnet. Gated; SKIPPED unless SMOKE_FAUCET_MINT=1 and
// PRIVATE_KEY are set. Asserts the wallet's USDP token balance increases.
const caseE = async (): Promise<boolean | 'SKIP'> => {
  log('\n=== Case E: live mint (devnet) ===');
  if (process.env.SMOKE_FAUCET_MINT !== '1' || !privateKey) {
    log('SKIPPED (set SMOKE_FAUCET_MINT=1 and PRIVATE_KEY to include)');
    return 'SKIP';
  }

  const connection = new Connection(RPC, 'confirmed');
  const owner = Keypair.fromSecretKey(bs58.decode(privateKey)).publicKey;
  const ata = getAssociatedTokenAddressSync(new PublicKey(USDP_MINT), owner);

  // best-effort devnet SOL for gas (tolerate rate-limited faucets, like fund-account.ts).
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

  const balanceOf = async (): Promise<number> => {
    try {
      const r = await connection.getTokenAccountBalance(ata);
      return Number(r.value.amount);
    } catch {
      return 0; // ATA not yet created
    }
  };

  const before = await balanceOf();
  log(`  USDP balance before: ${before / 1_000_000}`);

  let signature: string;
  try {
    const res = await mintTestUsdp({ privateKey, rpcUrl: RPC, amount: MINT_AMOUNT });
    const parsed = JSON.parse(res.content[0].text);
    signature = parsed.signature;
    log(`  mint signature: ${signature}`);
    if (!signature || typeof signature !== 'string') {
      log(no('Case E FAIL — no signature returned'));
      return false;
    }
  } catch (e: any) {
    log(no(`Case E FAIL — mint threw: ${e.message}`));
    return false;
  }

  // poll for the balance to reflect the mint (~60s).
  const wantDelta = MINT_AMOUNT * 1_000_000;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const after = await balanceOf();
    log(`  USDP balance after:  ${after / 1_000_000}`);
    if (after - before >= wantDelta * 0.99) {
      log(ok('Case E PASS — balance increased by ~minted amount'));
      return true;
    }
  }
  log(no('Case E FAIL — balance did not reflect the mint within 60s'));
  return false;
};

// --- runner -----------------------------------------------------------------

const main = async () => {
  log(`RPC      : ${RPC}`);
  log(`Creds    : PRIVATE_KEY=${privateKey ? 'set' : 'MISSING'}  SMOKE_FAUCET_MINT=${process.env.SMOKE_FAUCET_MINT ?? '0'}`);

  const results: Array<[string, boolean | 'SKIP']> = [];
  results.push(['A IDL + seed', caseA()]);
  results.push(['B built instruction', await caseB()]);
  results.push(['C testnet gating', caseC()]);
  results.push(['D no-key guard', await caseD()]);
  results.push(['E live mint', await caseE()]);

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
