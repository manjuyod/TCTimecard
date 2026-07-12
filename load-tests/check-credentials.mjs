import fs from 'node:fs';
import { parseIndexSelector, runCredentialChecks } from './credential-checker-lib.mjs';

const requiredEnv = (name) => {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const main = async () => {
  const baseUrl = requiredEnv('LOAD_TEST_BASE_URL').replace(/\/$/, '');
  const credentialsFile = requiredEnv('LOAD_TEST_CREDENTIALS_FILE');
  const resultsFile = process.env.CREDENTIAL_CHECK_RESULTS_FILE || 'credential-check-results.json';
  const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  if (!Array.isArray(credentials.tutors) || !Array.isArray(credentials.admins)) {
    throw new Error('credentials must contain tutors and admins arrays');
  }

  const tutorIndices = parseIndexSelector(
    process.env.CREDENTIAL_CHECK_TUTOR_INDICES,
    'tutor',
    credentials.tutors.length
  );
  const adminIndices = parseIndexSelector(
    process.env.CREDENTIAL_CHECK_ADMIN_INDICES,
    'admin',
    credentials.admins.length
  );
  if (tutorIndices.length + adminIndices.length === 0) {
    throw new Error('at least one credential index must be selected');
  }

  const maxConsecutiveFailures = Number(process.env.CREDENTIAL_CHECK_MAX_CONSECUTIVE_FAILURES || 4);
  const result = await runCredentialChecks({
    baseUrl,
    credentials,
    tutorIndices,
    adminIndices,
    maxConsecutiveFailures,
    fetchImpl: fetch
  });
  const output = {
    config: {
      baseUrl,
      tutorIndices,
      adminIndices,
      maxConsecutiveFailures
    },
    ...result
  };

  fs.writeFileSync(resultsFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
  if (result.invalid > 0 || result.errors > 0 || result.skipped > 0) process.exitCode = 1;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
