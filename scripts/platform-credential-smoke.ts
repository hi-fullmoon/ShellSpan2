import { randomUUID } from 'node:crypto';
import { platformCredentialRoundTrip } from '../electron/node-core/credential-store.ts';

const id = randomUUID();
const matched = await platformCredentialRoundTrip(
  `com.shellspan.migration-smoke.${id}`,
  `account-${id}`,
  `secret-${randomUUID()}-世界`,
);
if (!matched) throw new Error('Platform credential round trip did not preserve the secret');
console.log(`Platform credential round trip passed on ${process.platform}.`);
