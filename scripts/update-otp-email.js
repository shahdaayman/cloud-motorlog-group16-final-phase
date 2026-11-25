/**
 * Run from the Motorlog project root after copying this file to scripts/ and
 * otp.html to email/.  Updates only the existing pool's MFA email message.
 * Does not recreate user pools, change client IDs, or disable MFA.
 */
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const {
  CognitoIdentityProviderClient,
  GetUserPoolMfaConfigCommand,
  SetUserPoolMfaConfigCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

async function main() {
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const poolId = process.env.COGNITO_USER_POOL_ID;
  if (!endpoint || !/^http:\/\/(localhost|127\.0\.0\.1):4566\/?$/.test(endpoint)) {
    throw new Error('This script only updates local Floci on http://localhost:4566.');
  }
  if (!poolId || !/^us-[\w-]+_\w+$/.test(poolId)) {
    throw new Error('COGNITO_USER_POOL_ID is missing or invalid in your .env file.');
  }

  const body = fs.readFileSync(path.resolve(__dirname, '../email/otp.html'), 'utf8');
  if ((body.match(/\{####\}/g) || []).length !== 1) {
    throw new Error('The email HTML must contain exactly one {####} Cognito code placeholder.');
  }
  if (Buffer.byteLength(body, 'utf8') > 20000) {
    throw new Error('The email template must remain under Cognito\'s 20,000-character message limit.');
  }

  const client = new CognitoIdentityProviderClient({
    endpoint,
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const existing = await client.send(new GetUserPoolMfaConfigCommand({ UserPoolId: poolId }));
  if (!['ON', 'OPTIONAL'].includes(existing.MfaConfiguration)) {
    throw new Error(`MFA is currently '${existing.MfaConfiguration}'. Refusing to alter its mode.`);
  }

  const update = {
    UserPoolId: poolId,
    MfaConfiguration: existing.MfaConfiguration,
    EmailMfaConfiguration: {
      ...(existing.EmailMfaConfiguration || {}),
      Subject: 'Your Motorlog verification code',
      Message: body,
    },
  };
  // Preserve other factors, if configured, rather than removing them.
  for (const factor of ['SmsMfaConfiguration','SoftwareTokenMfaConfiguration','WebAuthnConfiguration']) {
    if (existing[factor]) update[factor] = existing[factor];
  }
  await client.send(new SetUserPoolMfaConfigCommand(update));
  console.log('Updated email MFA design in Floci user pool:', poolId);
  console.log('MFA mode preserved:', existing.MfaConfiguration);
  console.log('Sign out and sign in again to generate a fresh code and inspect the email.');
}
main().catch((error) => {
  console.error('Update failed:', error.name, error.message);
  process.exitCode = 1;
});
