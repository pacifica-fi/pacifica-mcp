import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Connection, PublicKey, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { privateKey, SOLANA_RPC_URL, type ApiResponse } from '../helpers.js';

// @coral-xyz/anchor ships as CommonJS. Under this project's `module: NodeNext`
// ESM output, BN is reachable only via the default export — the namespace member
// `anchor.BN` is `undefined` at runtime even though the .d.ts declares it (so
// `tsc --noEmit` is happy but `new anchor.BN(...)` throws). Pull it off `default`,
// falling back to the namespace for bundlers/Node versions that do surface it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BN = ((anchor as any).default?.BN ?? (anchor as any).BN) as typeof anchor.BN;

const __dirname = dirname(fileURLToPath(import.meta.url));

// On-chain addresses for the testnet Pacifica Solana program.
export const USDP_MINT = 'USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM';
export const CENTRAL_STATE = '2zPRq1Qvdq5A4Ld6WsH7usgCge4ApZRYfhhf5VAjfXxv';

// Seed for the per-user PDA. This MUST match the IDL's declared `user_account`
// seed bytes (b"user_account", underscore — NOT "user-account"). A mismatch
// derives a different PDA and the program's seeds constraint rejects the mint.
// See scripts/fund-account.ts for the same gotcha against the live program.
export const USER_ACCOUNT_SEED = 'user_account';

// USDP has 6 decimals; the program takes a base-unit amount.
const USDP_DECIMALS = 1_000_000;

// The faucet is testnet-only (mint_test_usdc does not exist on the mainnet
// program). index.ts gates tool registration on this.
export const isFaucetEnabled = (baseUrl: string): boolean =>
  baseUrl.includes('test-api.pacifica.fi');

let cachedIdl: anchor.Idl | undefined;

// Load (and cache) the Anchor IDL shipped alongside this module. The path is
// resolved relative to the compiled file, so it works both from dist/ (after
// `npm run build` copies src/idl → dist/idl) and from src/ under tsx.
export function loadFaucetIdl(): anchor.Idl {
  if (!cachedIdl) {
    cachedIdl = JSON.parse(
      readFileSync(join(__dirname, '../idl/pacifica_solana.json'), 'utf-8'),
    ) as anchor.Idl;
  }
  return cachedIdl;
}

export interface BuiltMintIx {
  instruction: Transaction['instructions'][number];
  userAccount: PublicKey;
  userUsdcATA: PublicKey;
}

// Build (but do NOT send) the mint_test_usdc instruction. Network-free: only
// derives accounts and encodes the instruction, so it can be exercised offline
// by the smoke tests. `amount` is in whole USDP and is scaled to base units;
// Math.round guards fractional amounts (the tool's zod schema allows them)
// against BN's integer assertion.
export async function buildMintTestUsdcIx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  owner: PublicKey,
  amount: number,
): Promise<BuiltMintIx> {
  const [userAccount] = PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode(USER_ACCOUNT_SEED), owner.toBuffer()],
    program.programId,
  );

  const userUsdcATA = anchor.utils.token.associatedAddress({
    mint: new PublicKey(USDP_MINT),
    owner,
  });

  const instruction = await program.methods
    .mintTestUsdc(new BN(Math.round(amount * USDP_DECIMALS)))
    .accounts({
      user: owner,
      userAccount,
      userUsdcTestAccount: userUsdcATA,
      usdcTestMint: new PublicKey(USDP_MINT),
      centralState: new PublicKey(CENTRAL_STATE),
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, userAccount, userUsdcATA };
}

// Mint test USDP to the wallet that owns `privateKey`. Returns the standard MCP
// text response. Mints to the wallet's USDP token account only — it does NOT
// deposit into the exchange account (that is a separate on-chain `deposit`).
export async function mintTestUsdp(opts: {
  privateKey: string | undefined;
  rpcUrl: string;
  amount: number;
}): Promise<ApiResponse> {
  if (!opts.privateKey) {
    return {
      content: [{
        type: 'text',
        text: 'Error: PRIVATE_KEY is required to mint USDP — agent keys are for API signing only.',
      }],
    };
  }

  const keypair = Keypair.fromSecretKey(bs58.decode(opts.privateKey));
  const connection = new Connection(opts.rpcUrl, 'confirmed');
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new anchor.Program(loadFaucetIdl(), provider) as any;

  const { instruction } = await buildMintTestUsdcIx(program, keypair.publicKey, opts.amount);
  const signature = await provider.sendAndConfirm(new Transaction().add(instruction));

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ success: true, amount: opts.amount, signature }),
    }],
  };
}

export function registerFaucetTools(server: McpServer): void {
  server.tool(
    'mintUsdp',
    'Mint test USDP to the configured wallet (testnet only). Requires PRIVATE_KEY. Default amount is 10,000 USDP.',
    {
      amount: z.number().positive().default(10000)
        .describe('Amount of USDP to mint (default: 10,000)'),
    },
    async ({ amount }): Promise<ApiResponse> =>
      mintTestUsdp({ privateKey, rpcUrl: SOLANA_RPC_URL, amount }),
  );
}
