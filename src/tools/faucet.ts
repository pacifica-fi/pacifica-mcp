import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { privateKey, SOLANA_RPC_URL, type ApiResponse } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL = JSON.parse(
  readFileSync(join(__dirname, '../idl/pacifica_solana.json'), 'utf-8')
) as anchor.Idl;

// On-chain addresses for the testnet Pacifica Solana program.
const USDP_MINT = 'USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM';
const CENTRAL_STATE = '2zPRq1Qvdq5A4Ld6WsH7usgCge4ApZRYfhhf5VAjfXxv';

export function registerFaucetTools(server: McpServer): void {
  server.tool(
    'mintUsdp',
    'Mint test USDP to the configured wallet (testnet only). Requires PRIVATE_KEY. Default amount is 10,000 USDP.',
    {
      amount: z.number().positive().default(10000)
        .describe('Amount of USDP to mint (default: 10,000)')
    },
    async ({ amount }): Promise<ApiResponse> => {
      if (!privateKey) {
        return {
          content: [{
            type: 'text',
            text: 'Error: PRIVATE_KEY is required to mint USDP — agent keys are for API signing only.'
          }]
        };
      }

      const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
      const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
      const wallet = new anchor.Wallet(keypair);
      const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const program = new anchor.Program(IDL, provider) as any;

      const [userAccount] = PublicKey.findProgramAddressSync(
        [anchor.utils.bytes.utf8.encode('user-account'), keypair.publicKey.toBuffer()],
        program.programId,
      );

      const userUsdcATA = anchor.utils.token.associatedAddress({
        mint: new PublicKey(USDP_MINT),
        owner: keypair.publicKey,
      });

      const signature: string = await program.methods
        .mintTestUsdc(new anchor.BN(amount * 1_000_000))
        .accounts({
          user: keypair.publicKey,
          userAccount,
          userUsdcTestAccount: userUsdcATA,
          usdcTestMint: new PublicKey(USDP_MINT),
          centralState: new PublicKey(CENTRAL_STATE),
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, amount, signature })
        }]
      };
    }
  );
}
