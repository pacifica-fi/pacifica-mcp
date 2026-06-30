import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { privateKey, SOLANA_RPC_URL, BASE_URL, type ApiResponse } from '../helpers.js';
import {
  BN,
  USDC_DECIMALS,
  ata,
  makeProgram,
  sendInstruction,
  resolveOnchainConfig,
} from './onchain.js';

export interface BuiltDepositIx {
  instruction: anchor.web3.TransactionInstruction;
  depositorUsdcAta: PublicKey;
  pacificaVault: PublicKey;
}

// Build (but do NOT send) the `deposit` instruction. Network-free: derives the
// depositor's USDC ATA and the exchange vault (= the central_state ATA), then
// encodes the instruction. `amount` is in whole USDC/USDP and scaled to base
// units (Math.round guards fractional inputs against BN's integer assertion).
// Uses .accountsPartial so Anchor resolves event_authority + program (matching
// scripts/fund-account.ts).
export async function buildDepositIx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  depositor: PublicKey,
  usdcMint: PublicKey,
  centralState: PublicKey,
  amount: number,
): Promise<BuiltDepositIx> {
  const depositorUsdcAta = ata(usdcMint, depositor);
  const pacificaVault = ata(usdcMint, centralState, true); // central_state is a PDA (off curve)

  const instruction = await program.methods
    .deposit(new BN(Math.round(amount * USDC_DECIMALS)))
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
export async function depositUsdp(opts: {
  privateKey: string | undefined;
  rpcUrl: string;
  baseUrl: string;
  amount: number;
}): Promise<ApiResponse> {
  if (!opts.privateKey) {
    return {
      content: [{
        type: 'text',
        text: 'Error: PRIVATE_KEY is required to deposit — agent keys are for API signing only.',
      }],
    };
  }

  const cfg = resolveOnchainConfig(opts.baseUrl);
  if ('error' in cfg) {
    return { content: [{ type: 'text', text: `Error: ${cfg.error}` }] };
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
    + '(selected by PACIFICA_BASE_URL); on MAINNET this moves REAL USDC.',
    {
      amount: z.number().positive()
        .describe('Amount of USDC/USDP to deposit into the exchange'),
    },
    async ({ amount }): Promise<ApiResponse> =>
      depositUsdp({ privateKey, rpcUrl: SOLANA_RPC_URL, baseUrl: BASE_URL, amount }),
  );
}
