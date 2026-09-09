import { createRequire } from 'node:module';
import process from 'node:process';

const providerRaw = process.env.SHELLSPAN_LIVE_LLM_PROVIDER_JSON;
const bodyRaw = process.env.SHELLSPAN_LIVE_LLM_BODY_JSON;
const apiKey = process.env.SHELLSPAN_LIVE_LLM_API_KEY;

if (!providerRaw || !bodyRaw) {
  process.stdout.write(
    'SKIP Node LLM live smoke: SHELLSPAN_LIVE_LLM_PROVIDER_JSON and SHELLSPAN_LIVE_LLM_BODY_JSON are not configured.\n',
  );
  process.exit(0);
}

const require = createRequire(import.meta.url);
const { streamProvider } = require('../dist-electron/node-core/llm-runtime.js');

const provider = JSON.parse(providerRaw);
const body = JSON.parse(bodyRaw);
const result = await streamProvider({
  provider,
  body,
  apiKey,
  retryPolicy: {
    maxAttempts: 1,
    initialDelayMs: 0,
    maxDelayMs: 0,
    maxServerDelayMs: 0,
    jitterRatio: 0,
  },
});
if (!result.content.length) throw new Error('Node LLM live smoke returned no content');
process.stdout.write(
  `PASS Node LLM live smoke: ${result.content.length} normalized block(s), usage ${
    result.usage.totalTokens ?? 'unreported'
  } total token(s).\n`,
);
