// Shared Solana plumbing for the on-chain MCP tools (faucet mint + exchange
// deposit). Centralizes IDL loading, the anchor BN interop shim, program/provider
// construction, instruction sending, ATA derivation, and per-network config so
// faucet.ts and deposit.ts do not duplicate it.
import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// @coral-xyz/anchor ships as CommonJS. Under this project's `module: NodeNext`
// ESM output, BN is reachable only via the default export — the namespace member
// `anchor.BN` is `undefined` at runtime even though the .d.ts declares it (so
// `tsc --noEmit` is happy but `new anchor.BN(...)` throws). Pull it off `default`,
// falling back to the namespace for bundlers/Node versions that do surface it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BN = ((anchor as any).default?.BN ?? (anchor as any).BN) as typeof anchor.BN;

const __dirname = dirname(fileURLToPath(import.meta.url));

// All token amounts on Pacifica use 6 decimals (USDC/USDP); the programs take a
// base-unit u64.
export const USDC_DECIMALS = 1_000_000;

// Pacifica bridge/exchange program ids (perp-backend common/src/constants.rs,
// BRIDGE_PROGRAM_ID). The testnet id also comes from the shipped IDL via
// idlProgramId(); the mainnet program is deployed at a different address.
export const MAINNET_PROGRAM_ID = 'PCFA5iYgmqK6MqPhWNKg7Yv7auX7VZ4Cx7T1eJyrAMH';

// Testnet on-chain addresses (the shipped IDL is the testnet program).
export const TESTNET_USDC_MINT = 'USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM';
// Mainnet circle USDC.
export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let cachedIdl: anchor.Idl | undefined;

// Load (and cache) the Anchor IDL shipped alongside this module. The path is
// resolved relative to the compiled file, so it works both from dist/ (after
// `npm run build` copies src/idl → dist/idl) and from src/ under tsx.
export function loadIdl(): anchor.Idl {
  if (!cachedIdl) {
    cachedIdl = JSON.parse(
      readFileSync(join(__dirname, '../idl/pacifica_solana.json'), 'utf-8'),
    ) as anchor.Idl;
  }
  return cachedIdl;
}

// The program id baked into the shipped (testnet) IDL.
export function idlProgramId(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (loadIdl() as any).address as string;
}

// central_state is a PDA seeded only by b"central_state" + the program id, so it
// follows from the program id (no need to hardcode it per network).
export function deriveCentralState(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [anchor.utils.bytes.utf8.encode('central_state')],
    programId,
  )[0];
}

// Associated token account for an arbitrary owner. `offCurve` must be true when
// the owner is a PDA (e.g. central_state for the exchange vault).
export function ata(mint: PublicKey, owner: PublicKey, offCurve = false): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, offCurve);
}

export type PacificaNetwork = 'testnet' | 'mainnet';

export interface OnchainConfig {
  network: PacificaNetwork;
  programId: PublicKey;
  usdcMint: PublicKey;
  centralState: PublicKey;
}

// Resolve the on-chain parameters for the active deployment from the REST base
// URL, with env overrides as the configuration/safety seam:
//   PACIFICA_PROGRAM_ID  - program id (defaults: shipped IDL on testnet,
//                          MAINNET_PROGRAM_ID on mainnet)
//   PACIFICA_USDC_MINT   - collateral mint (defaults per network)
// Returns a string error (instead of throwing) if an override is not valid
// base58, so the caller can surface it without risking a wrong-account send.
export function resolveOnchainConfig(baseUrl: string): OnchainConfig | { error: string } {
  const isTestnet = baseUrl.includes('test-api.pacifica.fi');
  const network: PacificaNetwork = isTestnet ? 'testnet' : 'mainnet';

  const programIdStr = process.env.PACIFICA_PROGRAM_ID
    ?? (isTestnet ? idlProgramId() : MAINNET_PROGRAM_ID);

  const usdcMintStr = process.env.PACIFICA_USDC_MINT
    ?? (isTestnet ? TESTNET_USDC_MINT : MAINNET_USDC_MINT);

  let programId: PublicKey;
  let usdcMint: PublicKey;
  try {
    programId = new PublicKey(programIdStr);
    usdcMint = new PublicKey(usdcMintStr);
  } catch {
    return { error: `Invalid PACIFICA_PROGRAM_ID or PACIFICA_USDC_MINT: not a valid base58 public key.` };
  }

  return { network, programId, usdcMint, centralState: deriveCentralState(programId) };
}

export interface ProgramHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any;
  keypair: Keypair;
  provider: anchor.AnchorProvider;
}

// Build an Anchor program bound to `programId` and signing with `privateKey`.
// Clones the IDL and overrides its `address` so the same instruction ABI can
// target either network.
export function makeProgram(privateKey: string, rpcUrl: string, programId: PublicKey): ProgramHandle {
  const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
  const connection = new Connection(rpcUrl, 'confirmed');
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  const idl = { ...loadIdl(), address: programId.toBase58() } as anchor.Idl;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new anchor.Program(idl, provider) as any;
  return { program, keypair, provider };
}

// Send a single built instruction and confirm it. Returns the tx signature.
export async function sendInstruction(
  provider: anchor.AnchorProvider,
  instruction: Transaction['instructions'][number],
): Promise<string> {
  return provider.sendAndConfirm(new Transaction().add(instruction));
}
