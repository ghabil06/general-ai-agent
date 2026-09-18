/**
 * Secret redaction: the key-based guarantee, the value-based heuristic, and the
 * fact that it is actually applied to event payloads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REDACTED,
  SECRET_KEY_WORDS,
  isSecretKey,
  isSecretValue,
  redact,
  redactShallow,
} from '../../src/observability/redact.mjs';
import { createEventBus } from '../../src/observability/events.mjs';
import { createMemorySink } from '../../src/observability/events.mjs';

test('every secret-looking key word is recognised in every key style', () => {
  assert.deepEqual(SECRET_KEY_WORDS.includes('apikey'), true);
  const secretKeys = [
    'apiKey',
    'api_key',
    'API-KEY',
    'X-Api-Key',
    'apikey',
    'authorization',
    'Authorization',
    'accessToken',
    'access_token',
    'token',
    'refreshToken',
    'password',
    'passwd',
    'userPassword',
    'clientSecret',
    'secret',
    'cookie',
    'Set-Cookie',
    'cookieHeader',
    'credentials',
    'privateKey',
  ];
  for (const key of secretKeys) {
    assert.equal(isSecretKey(key), true, `${key} should be treated as secret`);
  }
});

test('telemetry keys are NOT redacted — token usage must survive', () => {
  // Plural `tokens` always means a usage counter in this codebase, so it is
  // exempt on purpose. Losing cost accounting would make the budgets
  // unauditable, which is a real harm; there is no credential spelled
  // `totalTokens`.
  const innocent = ['totalTokens', 'maxTokens', 'promptTokens', 'completionTokens', 'tokensUsed', 'tokens', 'note', 'key', 'keys', 'keyName'];
  for (const key of innocent) {
    assert.equal(isSecretKey(key), false, `${key} must not be redacted`);
  }

  // The other direction is deliberately conservative: a key containing the
  // *singular* word `token` loses its value even when the value is a count.
  assert.equal(isSecretKey('tokenCount'), true, 'over-redaction of a count is accepted');
  assert.equal(redact({ usage: { totalTokens: 42, maxTokens: 100 }, tokenCount: 42 }).usage.totalTokens, 42);
  assert.equal(redact({ tokenCount: 42 }).tokenCount, REDACTED);
});

test('redact() strips the value of any secret key, anywhere in the tree', () => {
  const payload = {
    ok: true,
    headers: { Authorization: 'Bearer abc', 'x-api-key': 'sk-live-1234567890' },
    providers: {
      openai: { apiKey: 'sk-proj-abcdefgh', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
      anthropic: { api_key: 'sk-ant-abcdefgh', apiKeyPresent: true },
    },
    auth: { password: 'hunter2', cookie: 'session=1', secret: 'shh', token: 't' },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    nested: [{ apiKey: 'sk-one' }, { deeper: { refreshToken: 'rt', keep: 'yes' } }],
  };

  const safe = redact(payload);

  assert.equal(safe.headers.Authorization, REDACTED);
  assert.equal(safe.headers['x-api-key'], REDACTED);
  assert.equal(safe.providers.openai.apiKey, REDACTED);
  assert.equal(safe.providers.anthropic.api_key, REDACTED);
  assert.equal(safe.auth.password, REDACTED);
  assert.equal(safe.auth.cookie, REDACTED);
  assert.equal(safe.auth.secret, REDACTED);
  assert.equal(safe.auth.token, REDACTED);
  assert.equal(safe.nested[0].apiKey, REDACTED);

  // non-secret data is untouched
  assert.equal(safe.providers.openai.model, 'gpt-4o-mini');
  // Deliberate over-redaction: the key `apiKeyPresent` contains the word
  // `apiKey`, so its (boolean) value goes too. The conservative direction is
  // the correct one — see the module docstring.
  assert.equal(safe.providers.anthropic.apiKeyPresent, REDACTED);
  assert.deepEqual(safe.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  assert.equal(safe.nested[1].deeper.refreshToken, REDACTED);
  assert.equal(safe.nested[1].deeper.keep, 'yes');

  // the input is not mutated
  assert.equal(payload.providers.openai.apiKey, 'sk-proj-abcdefgh');
  assert.equal(JSON.stringify(safe).includes('sk-proj-abcdefgh'), false);
});

test('the value heuristic catches credential-shaped strings under innocent keys', () => {
  const samples = [
    'sk-proj-1234567890abcdef',
    'sk-ant-api03-abcdefghij',
    'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6',
    'xoxb-1234567890-abcdefghij',
    'ghp_abcdefghijklmnop',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----',
  ];
  for (const sample of samples) {
    assert.equal(isSecretValue(sample), true, `${sample} should look like a credential`);
    assert.equal(redact({ note: sample }).note, REDACTED);
  }
  assert.equal(isSecretValue('a normal sentence'), false);
  assert.equal(isSecretValue('990'), false);
  assert.equal(redact({ note: 'invoice #990 total $450.00' }).note, 'invoice #990 total $450.00');
});

test('redaction is defensive: cycles, Errors, Dates, Maps and Sets survive', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  const cyclicSafe = redact(cyclic);
  assert.equal(cyclicSafe.self, '[Circular]');

  const withExtras = redact({
    error: Object.assign(new Error('boom'), { code: 'E_FAIL', apiKey: 'sk-1' }),
    when: new Date('2026-01-15T15:30:00Z'),
    map: new Map([['apiKey', 'sk-2'], ['keep', 'yes']]),
    set: new Set(['a', 'b']),
    nothing: null,
    num: 1,
  });
  assert.equal(withExtras.error.message, 'boom');
  assert.equal(withExtras.error.code, 'E_FAIL');
  assert.equal(withExtras.when, '2026-01-15T15:30:00.000Z');
  assert.equal(withExtras.map.apiKey, REDACTED);
  assert.equal(withExtras.map.keep, 'yes');
  assert.deepEqual(withExtras.set, ['a', 'b']);
  assert.equal(withExtras.nothing, null);
});

test('redactShallow covers the envelope keys without deep-cloning', () => {
  const safe = redactShallow({ token: 't', tool: 'query_po_database', args: { apiKey: 'sk-3' } });
  assert.equal(safe.token, REDACTED);
  assert.equal(safe.tool, 'query_po_database');
  assert.equal(safe.args.apiKey, REDACTED, 'values are still deep-redacted');
});

test('event payloads are redacted before any sink sees them', () => {
  const sink = createMemorySink();
  const events = createEventBus({ runId: 'run_x', sinks: [sink], now: () => 1 });

  events.emit('model.called', {
    provider: 'openai',
    model: 'gpt-4o-mini',
    headers: { authorization: 'Bearer sk-secret-value' },
    apiKey: 'sk-secret-value',
    usage: { totalTokens: 42 },
  });

  const [event] = sink.events;
  assert.equal(event.payload.apiKey, REDACTED);
  assert.equal(event.payload.headers.authorization, REDACTED);
  assert.equal(event.payload.usage.totalTokens, 42);
  assert.equal(JSON.stringify(sink.events).includes('sk-secret-value'), false);

  // and the envelope itself is frozen
  assert.equal(Object.isFrozen(event), true);
  assert.throws(() => {
    event.payload = {};
  }, TypeError);
});

test('a sink that throws is recorded, never propagated', () => {
  const events = createEventBus({
    sinks: [
      {
        name: 'exploding',
        write() {
          throw new Error('disk full');
        },
      },
    ],
  });
  assert.doesNotThrow(() => events.emit('run.started', {}));
  assert.equal(events.sinkErrors.length, 1);
  assert.match(events.sinkErrors[0].message, /disk full/);
});
