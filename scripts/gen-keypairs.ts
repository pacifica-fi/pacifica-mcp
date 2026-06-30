/**
 * gen-keypairs.ts -- print N fresh Solana keypairs in .envrc.local format.
 *
 * Each keypair prints its base58 public address and base58 64-byte secret key,
 * matching the ADDRESS / PRIVATE_KEY fields in .envrc.local.example. Two keypairs
 * (the default) cover the main account + the maker rig used by smoke:3e.
 *
 * Throwaway TESTNET accounts only -- fund them before the signed smoke suites do
 * anything (see scripts/fund-account.ts).
 *
 * Run:  npm run gen:keys [count]
 */
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

const count = Number(process.argv[2] ?? '2');
if (!Number.isInteger(count) || count < 1) throw new Error(`invalid count: ${process.argv[2]}`);

for (let i = 1; i <= count; i++) {
  const kp = Keypair.generate();
  console.log(`# account ${i}`);
  console.log(`ADDRESS=${kp.publicKey.toBase58()}`);
  console.log(`PRIVATE_KEY=${bs58.encode(kp.secretKey)}`);
  console.log();
}
