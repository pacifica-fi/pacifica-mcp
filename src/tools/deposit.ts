import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { privateKey, SOLANA_RPC_URL, BASE_URL, type ApiResponse } from '../helpers.js';
import {
  BN,
  ata,
  makeProgram,
  sendInstruction,
  resolveOnchainConfig,
  toBaseUnits,
} from './onchain.js';
import {
  amountString,
  checkCeiling,
  DRY_RUN,
  dryRunResult,
  MAX_DEPOSIT_AMOUNT,
  refuse,
} from '../limits.js';

export interface BuiltDepositIx {
  instruction: anchor.web3.TransactionInstruction;
  depositorUsdcAta: PublicKey;
  pacificaVault: PublicKey;
}

// Build (but do NOT send) the `deposit` instruction. Network-free: derives the
// depositor's USDC ATA and the exchange vault (= the central_state ATA), then
// encodes the instruction.
//
// `amount` is a decimal string in whole USDC/USDP, converted to base units by
// `toBaseUnits` in exact integer arithmetic. It used to be a `number` scaled with
// `Math.round(amount * USDC_DECIMALS)`, which made the number of base units actually
// transferred depend on binary floating-point rounding — see the comment on
// `toBaseUnits` for why that is not a theoretical concern for amounts with cents.
//
// Uses .accountsPartial so Anchor resolves event_authority + program (matching
// scripts/fund-account.ts).
export async function buildDepositIx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  depositor: PublicKey,
  usdcMint: PublicKey,
  centralState: PublicKey,
  amount: string,
): Promise<BuiltDepositIx> {
  const depositorUsdcAta = ata(usdcMint, depositor);
  const pacificaVault = ata(usdcMint, centralState, true); // central_state is a PDA (off curve)

  // BN is constructed from the decimal *string* of the bigint: passing a JS number back
  // in would reintroduce the 2^53 ceiling this conversion exists to avoid.
  const instruction = await program.methods
    .deposit(new BN(toBaseUnits(amount).toString()))
    .accountsPartial({
      depositor,
      depositorUsdcAccount: depositorUsdcAta,
      centralState,
      pacificaVault,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      usdcTestMint: usdcMint,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  return { instruction, depositorUsdcAta, pacificaVault };
}

// Deposit the wallet's USDC/USDP into the Pacifica exchange account. Returns the
// standard MCP text response. Requires PRIVATE_KEY (signs an on-chain tx). On
// mainnet this moves REAL USDC and requires PACIFICA_PROGRAM_ID to be configured.
//
// The two configuration failures below now return `isError: true`. Without it the model
// reads "Error: PRIVATE_KEY is required" as a successful tool call whose result happens
// to mention an error, and may go on to reason as though the deposit had settled.
export async function depositUsdp(opts: {
  privateKey: string | undefined;
  rpcUrl: string;
  baseUrl: string;
  amount: string;
}): Promise<ApiResponse> {
  if (!opts.privateKey) {
    return {
      content: [{
        type: 'text',
        text: 'Error: PRIVATE_KEY is required to deposit — agent keys are for API signing only.',
      }],
      isError: true,
    };
  }

  const cfg = resolveOnchainConfig(opts.baseUrl);
  if ('error' in cfg) {
    return { content: [{ type: 'text', text: `Error: ${cfg.error}` }], isError: true };
  }

  const tooLarge = checkCeiling(opts.amount, MAX_DEPOSIT_AMOUNT, {
    label: 'Deposit amount',
    envVar: 'PACIFICA_MAX_DEPOSIT_AMOUNT',
  });
  if (tooLarge) return refuse(tooLarge);

  if (DRY_RUN) {
    return dryRunResult('deposit', {
      amount: opts.amount,
      base_units: toBaseUnits(opts.amount).toString(),
      network: cfg.network,
      program_id: cfg.programId.toBase58(),
      usdc_mint: cfg.usdcMint.toBase58(),
    });
  }

  const { program, keypair, provider } = makeProgram(opts.privateKey, opts.rpcUrl, cfg.programId);
  const { instruction } = await buildDepositIx(
    program, keypair.publicKey, cfg.usdcMint, cfg.centralState, opts.amount,
  );
  const signature = await sendInstruction(provider, instruction);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ success: true, amount: opts.amount, network: cfg.network, signature }),
    }],
  };
}

export function registerDepositTools(server: McpServer): void {
  server.tool(
    'depositUsdp',
    'Deposit the wallet\'s USDC/USDP into the Pacifica exchange account (the balance used for '
    + 'trading). Requires PRIVATE_KEY (signs an on-chain Solana transaction). The funds must '
    + 'already be in the wallet (on testnet, use mintUsdp first). Works on testnet and mainnet '
    + '(selected by PACIFICA_BASE_URL); on MAINNET this moves REAL USDC. The amount is a decimal '
    + 'string with at most 6 decimal places.',
    {
      amount: amountString
        .describe("Amount of USDC/USDP to deposit into the exchange, as a decimal string, e.g. '25.5'"),
    },
    async ({ amount }): Promise<ApiResponse> =>
      depositUsdp({ privateKey, rpcUrl: SOLANA_RPC_URL, baseUrl: BASE_URL, amount }),
  );
}
