/**
 * fund-account.ts -- TESTNET-ONLY exchange-account funding helper (NOT an MCP tool).
 *
 * Replicates the perp-frontend faucet flow (app/faucet/page.tsx +
 * services/solanaProgram/{mint,deposit}.ts) for a headless keypair:
 *   1. devnet SOL airdrop for gas (skipped if balance sufficient)
 *   2. mintTestUsdc(amount)  -- Anchor ix, mints test USDC to the wallet ATA
 *   3. deposit(amount)       -- Anchor ix, moves USDC into the exchange account
 *      (minting alone does NOT create exchange balance)
 *   4. verify: GET {PACIFICA_BASE_URL}/api/v1/account?account=<pubkey> until the
 *      balance reflects the deposit (poll with timeout).
 *
 * Inherently testnet-only: mintTestUsdc does not exist on the mainnet program.
 * IDL: scripts/pacifica-solana-idl.json, copied verbatim from
 * perp-frontend/constants/envs/idls/testnet_program_idl.json.
 *
 * Run:  FUND_PRIVATE_KEY=<base58 secret> npx tsx scripts/fund-account.ts [amountUsdc]
 *   (defaults: amount 10000 -- the frontend's per-mint amount;
 *    SOLANA_RPC_URL optional, defaults to the Helius devnet RPC from
 *    perp-frontend/constants/envs/testnet.ts)
 */
import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import axios from 'axios';

// anchor ships as CommonJS; under NodeNext ESM the namespace member `anchor.BN`
// is undefined (BN lives on the default export). Pull it off `default`, falling
// back to the namespace for environments that do surface it.
const BN = (anchor as any).default?.BN ?? (anchor as any).BN;

// Constants from perp-frontend/constants/envs/testnet.ts:3-10
const RPC = process.env.SOLANA_RPC_URL
  ?? 'https://api.devnet.solana.com';
const CENTRAL_STATE = new PublicKey('2zPRq1Qvdq5A4Ld6WsH7usgCge4ApZRYfhhf5VAjfXxv');
const PACIFICA_VAULT = new PublicKey('5SDFdHZGTZbyRYu54CgmRkCGnPHC5pYaN27p7XGLqnBs');
const USDC_MINT = new PublicKey('USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM');
const BASE_URL = process.env.PACIFICA_BASE_URL ?? 'https://test-api.pacifica.fi';

const idl = JSON.parse(readFileSync(new URL('./pacifica-solana-idl.json', import.meta.url), 'utf8'));

const main = async () => {
  const secret = process.env.FUND_PRIVATE_KEY;
  if (!secret) throw new Error('FUND_PRIVATE_KEY not set');
  const amountUsdc = Number(process.argv[2] ?? '10000');
  const keypair = Keypair.fromSecretKey(bs58.decode(secret));
  const connection = new Connection(RPC, 'confirmed');
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const program = new anchor.Program(idl, provider);
  const userUsdcATA = anchor.utils.token.associatedAddress({ mint: USDC_MINT, owner: keypair.publicKey });

  // 1. gas -- top up below 0.05 SOL, but a rate-limited faucet is only fatal when
  // the balance can't even cover the two transaction fees (~0.00002 SOL).
  const MIN_FEE_LAMPORTS = 0.002 * LAMPORTS_PER_SOL;
  const sol = await connection.getBalance(keypair.publicKey);
  if (sol < 0.05 * LAMPORTS_PER_SOL) {
    console.log('airdropping 1 devnet SOL...');
    try {
      const sig = await connection.requestAirdrop(keypair.publicKey, 1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
    } catch (e: any) {
      if (sol < MIN_FEE_LAMPORTS) throw new Error(`airdrop failed and balance ${sol / LAMPORTS_PER_SOL} SOL is insufficient for fees: ${e.message}`);
      console.log(`airdrop failed (${String(e.message).slice(0, 60)}...) -- proceeding, ${sol / LAMPORTS_PER_SOL} SOL covers fees`);
    }
  }

  // 2. mintTestUsdc -- account set per the IDL (NOT perp-frontend mint.ts: the
  // frontend derives user_account with seed 'user-account' (hyphen) and passes an
  // un-destructured tuple, which anchor 0.30's resolver silently ignores and
  // re-derives from the IDL's real seed 'user_account' (underscore). We pass the
  // correct PDA explicitly via accountsPartial and let the resolver fill the rest
  // (ATAs, token programs, event_authority).
  const [userAccount] = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode('user_account'), keypair.publicKey.toBuffer()],
    program.programId,
  );
  const bn = new BN(amountUsdc * 1_000_000); // 6 decimals
  await program.methods.mintTestUsdc(bn).accountsPartial({
    user: keypair.publicKey, userAccount, userUsdcTestAccount: userUsdcATA,
    usdcTestMint: USDC_MINT, centralState: CENTRAL_STATE,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).rpc();
  console.log(`minted ${amountUsdc} test USDC`);

  // 3. deposit -- IDL names the mint account usdc_test_mint (the plan's reference
  // sketch said usdcMint); pacifica_vault is the central_state ATA per IDL seeds.
  await program.methods.deposit(bn).accountsPartial({
    depositor: keypair.publicKey, depositorUsdcAccount: userUsdcATA,
    centralState: CENTRAL_STATE, pacificaVault: PACIFICA_VAULT,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    usdcTestMint: USDC_MINT, systemProgram: SystemProgram.programId,
  }).rpc();
  console.log(`deposited ${amountUsdc} USDC into the exchange`);

  // 4. verify on the exchange side (poll up to ~60s)
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const res = await axios.get(`${BASE_URL}/api/v1/account`, {
      params: { account: keypair.publicKey.toBase58() }, validateStatus: () => true,
    });
    const bal = Number(res.data?.data?.balance ?? 'NaN');
    console.log(`exchange balance: ${res.data?.data?.balance ?? res.status}`);
    if (Number.isFinite(bal) && bal >= amountUsdc * 0.99) { console.log('FUNDED ✓'); return; }
  }
  throw new Error('exchange balance did not reflect the deposit within 60s');
};

main().catch((e) => { console.error(e); process.exit(1); });
