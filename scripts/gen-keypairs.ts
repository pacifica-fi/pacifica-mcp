import bs58 from 'bs58';
import nacl from 'tweetnacl';

function generate(label: string) {
  const kp = nacl.sign.keyPair();
  console.log(`${label}`);
  console.log(`  address:     ${bs58.encode(kp.publicKey)}`);
  console.log(`  private key: ${bs58.encode(kp.secretKey)}`);
  console.log();
}

generate('Main wallet');
generate('Agent wallet');
