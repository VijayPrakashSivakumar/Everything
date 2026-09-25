/* Confirms the VAPID keys belong together and that the public key matches the one the
   browser subscribes with (Everything/script.js → VAPID_PUBLIC_KEY).

   Usage:  node scripts/check-vapid.mjs
           → pastes the two keys when asked (nothing to quote on the command line)
           node scripts/check-vapid.mjs --public <key> --private <key>
           VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… node scripts/check-vapid.mjs
           Also reads api/.env.local or api/.env if you ran `vercel env pull`.

   A mismatch is the usual reason a push is rejected by the browser's push service. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function readArg(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function normalize(key) {
  return String(key || '').trim().replace(/=+$/, '');
}

/* web-push private keys are 32 raw bytes, public keys are 65 uncompressed bytes, both
   base64url encoded. Deriving the public key from the private one proves the pair. */
function publicKeyFromPrivate(privateKey) {
  try {
    const raw = Buffer.from(privateKey, 'base64url');
    if (raw.length !== 32) {
      return { error: `private key should decode to 32 bytes, got ${raw.length}` };
    }

    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(raw);

    return { publicKey: ecdh.getPublicKey().toString('base64url') };
  } catch (error) {
    return { error: error.message };
  }
}

function browserPublicKey() {
  try {
    const file = path.join(moduleDir, '..', 'script.js');
    const source = fs.readFileSync(file, 'utf8');
    const match = source.match(/VAPID_PUBLIC_KEY\s*=\s*"([^"]+)"/);

    return match ? match[1] : '';
  } catch (error) {
    return '';
  }
}

/* Reads VAPID_* from a pulled env file so the keys never have to be pasted into a shell. */
function envFileKeys() {
  const candidates = [
    path.join(moduleDir, '.env.local'),
    path.join(moduleDir, '.env'),
    path.join(moduleDir, '..', 'api', '.env.local'),
    path.join(moduleDir, '..', 'api', '.env'),
    path.join(moduleDir, '..', '.env.local'),
    path.join(moduleDir, '..', '.env')
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    try {
      const keys = {};
      for (const line of fs.readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^\s*VAPID_(PUBLIC|PRIVATE)_KEY\s*=\s*(.+?)\s*$/);
        if (match) keys['VAPID_' + match[1] + '_KEY'] = match[2].replace(/^["']|["']$/g, '');
      }

      if (keys.VAPID_PRIVATE_KEY) {
        console.log(`INFO  using keys from ${path.relative(process.cwd(), candidate)}`);
        return keys;
      }
    } catch (error) {
      /* unreadable file — just ignore it */
    }
  }

  return {};
}

/* Non-interactive callers (pipes, scripts) get the keys read from stdin directly, because
   readline cannot answer a second question after a piped stream ends. */
async function readPipedKeys() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  const lines = Buffer.concat(chunks)
    .toString('utf8')
    .split(/\r?\n/)
    .map(normalize)
    .filter(Boolean);

  if (lines.length > 1) return { publicKey: lines[0], privateKey: lines[1] };

  return { publicKey: '', privateKey: lines[0] || '' };
}

async function askForKeys() {
  if (!process.stdin.isTTY) {
    try {
      return await readPipedKeys();
    } catch (error) {
      return { publicKey: '', privateKey: '' };
    }
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const publicKey = normalize(
      await rl.question('Paste the VAPID public key (Enter to skip): '),
    );
    const privateKey = normalize(await rl.question('Paste the VAPID private key: '));

    return { publicKey, privateKey };
  } catch (error) {
    return { publicKey: '', privateKey: '' };
  } finally {
    rl.close();
  }
}

const fromFile = envFileKeys();

let publicKey = normalize(readArg('public') || process.env.VAPID_PUBLIC_KEY || fromFile.VAPID_PUBLIC_KEY);
let privateKey = normalize(readArg('private') || process.env.VAPID_PRIVATE_KEY || fromFile.VAPID_PRIVATE_KEY);

if (!publicKey || !privateKey) {
  const asked = await askForKeys();
  publicKey = publicKey || asked.publicKey;
  privateKey = privateKey || asked.privateKey;
}

const scriptKey = normalize(browserPublicKey());

if (!privateKey) {
  console.log('No private key given. Paste it when prompted, or pass --private <key>.');
  process.exit(1);
}

const derived = publicKeyFromPrivate(privateKey);

if (derived.error) {
  console.log('FAIL  that is not a usable VAPID private key:', derived.error);
  console.log(
    `      Received ${privateKey.length} characters — a real key is 43 (a public key is 87).`,
  );
  console.log('      Copy the value from Vercel → Settings → Environment Variables → VAPID_PRIVATE_KEY.');
  console.log('      Generate a new pair:  node node_modules/web-push/src/cli.js generate-vapid-keys --json');
  process.exit(1);
}

const derivedKey = normalize(derived.publicKey);
let failed = false;

if (publicKey) {
  const pairOk = derivedKey === publicKey;
  console.log(`${pairOk ? 'PASS' : 'FAIL'}  the public and private keys belong together`);
  if (!pairOk) {
    console.log('      derived public key:', derivedKey);
    console.log('      VAPID_PUBLIC_KEY :', publicKey);
    failed = true;
  }
} else {
  console.log('INFO  no --public / VAPID_PUBLIC_KEY given, skipping the pair check');
}

if (scriptKey) {
  const scriptOk = derivedKey === scriptKey;
  console.log(`${scriptOk ? 'PASS' : 'FAIL'}  it matches VAPID_PUBLIC_KEY in script.js`);
  if (!scriptOk) {
    console.log('      derived public key:', derivedKey);
    console.log('      script.js         :', scriptKey);
    console.log('      Fix by either pasting the matching private key into Vercel, or replacing');
    console.log('      VAPID_PUBLIC_KEY in script.js with the derived key above and redeploying.');
    failed = true;
  }
} else {
  console.log('INFO  could not read VAPID_PUBLIC_KEY from script.js');
}

console.log(`\nderived public key: ${derivedKey}`);
process.exit(failed ? 1 : 0);
