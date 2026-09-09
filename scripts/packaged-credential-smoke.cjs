const { randomUUID } = require('node:crypto');

const modulePath = process.argv[2];
if (!modulePath) throw new Error('Packaged credential module path is required');
const { platformCredentialRoundTrip } = require(modulePath);
const id = randomUUID();
platformCredentialRoundTrip(
  `com.shellspan.packaged-migration-smoke.${id}`,
  `account-${id}`,
  `secret-${randomUUID()}-世界`,
).then((matched) => {
  if (!matched) throw new Error('Packaged credential round trip did not preserve the secret');
  console.log(`Packaged platform credential round trip passed on ${process.platform}.`);
});
