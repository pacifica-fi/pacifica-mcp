// scripts/gen-keypairs.ts — generate a main wallet and an agent wallet.
//
// The original version printed both secret keys to stdout. For a key that authorises
// orders, transfers and withdrawals on a perpetuals account, stdout is a poor place to
// put it: it lands in the terminal scrollback, in `~/.bash_history`-adjacent session
// logs, in any tmux/screen capture, in the CI job log if this is ever run from a
// workflow, and in whatever copy the user makes when pasting "the output" into a chat
// or an issue. None of those are revocable.
//
// So secrets are written to files instead, one per wallet, created with mode 0600 and
// never overwritten; only the public address and the file path are printed. Printing to
// stdout is still possible, but has to be asked for explicitly.
//
// Usage:
//   npx tsx scripts/gen-keypairs.ts [--out <dir>]   # default ./keys
//   npx tsx scripts/gen-keypairs.ts --print-secret   # echo to stdout instead
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const printSecret = args.includes('--print-secret');
const outIndex = args.indexOf('--out');
const outDir = resolve(outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : 'keys');

interface Generated {
  label: string;
  address: string;
  secret: string;
}

const generate = (label: string): Generated => {
  const kp = nacl.sign.keyPair();
  return { label, address: bs58.encode(kp.publicKey), secret: bs58.encode(kp.secretKey) };
};

const wallets = [generate('Main wallet'), generate('Agent wallet')];

if (printSecret) {
  // Explicitly requested. The warning goes to stderr so it is still visible when
  // stdout is being piped somewhere.
  console.error(
    'WARNING: --print-secret writes private keys to stdout. They will remain in your\n' +
    '         terminal scrollback and in any log capturing this process. Rotate these\n' +
    '         keys if that is not what you intended.',
  );
  for (const { label, address, secret } of wallets) {
    console.log(label);
    console.log(`  address:     ${address}`);
    console.log(`  private key: ${secret}`);
    console.log();
  }
} else {
  // `recursive: true` makes the directory only if absent; 0700 keeps it owner-only on
  // POSIX. On Windows the mode argument is ignored by the filesystem — the ACL inherited
  // from the parent directory applies instead, which is why the note below is printed
  // rather than assumed.
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  for (const { label, address, secret } of wallets) {
    const slug = label.toLowerCase().replace(/\s+/g, '-');
    const file = resolve(outDir, `${slug}.key`);
    // `wx` fails if the file exists: silently overwriting a key file would destroy the
    // only copy of a key that may already be funded and bound to an account.
    writeFileSync(file, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    console.log(label);
    console.log(`  address:     ${address}`);
    console.log(`  private key: written to ${file} (mode 0600)`);
    console.log();
  }

  console.log('Load them into the environment without echoing the value, e.g.:');
  console.log(`  export PRIVATE_KEY="$(cat ${resolve(outDir, 'main-wallet.key')})"`);
  console.log(`  export AGENT_PRIVATE_KEY="$(cat ${resolve(outDir, 'agent-wallet.key')})"`);
  console.log();
  console.log('Keep this directory out of version control and off shared storage.');
  console.log('On Windows, verify the folder ACL — the 0600/0700 modes above are a POSIX');
  console.log('concept and are not enforced by NTFS.');
}
