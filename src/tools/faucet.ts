import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { privateKey, SOLANA_RPC_URL, type ApiResponse } from '../helpers.js';
import {
  BN,
  USDC_DECIMALS,
  TESTNET_USDC_MINT,
  ata,
  idlProgramId,
  makeProgram,
  sendInstruction,
} from './onchain.js';

// Re-exported for stability: the shared module owns IDL loading now.
export { loadIdl as loadFaucetIdl } from './onchain.js';

// Testnet on-chain addresses. USDP is the testnet collateral mint; CENTRAL_STATE
// is the program's central_state PDA (kept as a constant for back-compat — it is
// also derivable from the program id via onchain.deriveCentralState).
export const USDP_MINT = TESTNET_USDC_MINT;
export const CENTRAL_STATE = '2zPRq1Qvdq5A4Ld6WsH7usgCge4ApZRYfhhf5VAjfXxv';

// Seed for the per-user PDA. This MUST match the IDL's declared `user_account`
// seed bytes (b"user_account", underscore — NOT "user-account"). A mismatch
// derives a different PDA and the program's seeds constraint rejects the mint.
export const USER_ACCOUNT_SEED = 'user_account';

// The faucet is testnet-only (mint_test_usdc does not exist on the mainnet
// program). index.ts gates tool registration on this.
export const isFaucetEnabled = (baseUrl: string): boolean =>
  baseUrl.includes('test-api.pacifica.fi');

export interface BuiltMintIx {
  instruction: anchor.web3.TransactionInstruction;
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

  const userUsdcATA = ata(new PublicKey(USDP_MINT), owner);

  const instruction = await program.methods
    .mintTestUsdc(new BN(Math.round(amount * USDC_DECIMALS)))
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
// deposit into the exchange account (see depositUsdp for that).
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

  const { program, keypair, provider } =
    makeProgram(opts.privateKey, opts.rpcUrl, new PublicKey(idlProgramId()));
  const { instruction } = await buildMintTestUsdcIx(program, keypair.publicKey, opts.amount);
  const signature = await sendInstruction(provider, instruction);

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
