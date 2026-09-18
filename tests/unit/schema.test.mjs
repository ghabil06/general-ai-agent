/**
 * Schema validator: accept/reject cases, unsupported keywords, invalid schemas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validate, isValid, formatViolations, validateOrThrow } from '../../src/tools/schema.mjs';

const keywords = (violations) => violations.map((violation) => violation.keyword);
const messages = (violations) => formatViolations(violations);

test('a valid object produces no violations', () => {
  const schema = {
    type: 'object',
    properties: {
      poNumber: { type: 'string', pattern: '^#?[0-9]+$' },
      amount: { type: 'number', minimum: 0, maximum: 500 },
      tags: { type: 'array', items: { type: 'string' } },
      currency: { type: 'string', enum: ['USD', 'EUR'] },
    },
    required: ['poNumber', 'amount'],
  };
  assert.deepEqual(validate({ poNumber: '#990', amount: 450, tags: ['a'], currency: 'USD' }, schema), []);
  assert.equal(isValid({ poNumber: '990', amount: 0 }, schema), true);
});

test('missing required keys are reported by path', () => {
  const schema = { type: 'object', required: ['poNumber', 'amount'], properties: { poNumber: { type: 'string' } } };
  const violations = validate({}, schema);
  assert.deepEqual(keywords(violations), ['required', 'required']);
  assert.deepEqual(
    violations.map((violation) => violation.path),
    ['$.poNumber', '$.amount'],
  );
  assert.match(messages(violations)[0], /\$\.poNumber is required/);
});

test('type mismatches are reported and stop deeper checks', () => {
  const schema = { type: 'object', properties: { amount: { type: 'number', minimum: 10 } } };
  const violations = validate({ amount: '450' }, schema);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].keyword, 'type');
  assert.match(violations[0].message, /must be of type number but received string/);
});

test('integer, boolean and array types are distinguished', () => {
  const schema = {
    type: 'object',
    properties: {
      level: { type: 'integer' },
      halted: { type: 'boolean' },
      ticks: { type: 'array', items: { type: 'integer' } },
      nullableThing: { type: 'null' },
    },
  };
  assert.deepEqual(validate({ level: 12, halted: false, ticks: [1, 2], nullableThing: null }, schema), []);
  assert.equal(validate({ level: 12.5 }, schema)[0].path, '$.level');
  assert.equal(validate({ halted: 'true' }, schema)[0].path, '$.halted');
  assert.equal(validate({ ticks: [1, 'x'] }, schema)[0].path, '$.ticks[1]');
  // 3 is an integer, which is also a number
  assert.deepEqual(validate({ level: 3 }, { type: 'object', properties: { level: { type: 'number' } } }), []);
});

test('enum and const use deep equality', () => {
  const schema = {
    type: 'object',
    properties: {
      action: { enum: ['auto_approve', 'request_human_approval'] },
      side: { const: 'buy' },
      payload: { const: { a: 1, b: [1, 2] } },
    },
  };
  assert.deepEqual(validate({ action: 'auto_approve', side: 'buy', payload: { b: [1, 2], a: 1 } }, schema), []);

  const rejected = validate({ action: 'auto_approve_override', side: 'sell', payload: { a: 1 } }, schema);
  assert.deepEqual(keywords(rejected).sort(), ['const', 'const', 'enum']);
  assert.match(rejected.find((v) => v.keyword === 'enum').message, /must be one of/);
});

test('pattern applies to strings only, and an invalid pattern is a schema error', () => {
  const schema = { type: 'object', properties: { ip: { type: 'string', pattern: '^([0-9]{1,3}\\.){3}[0-9]{1,3}$' } } };
  assert.deepEqual(validate({ ip: '10.20.0.31' }, schema), []);
  assert.equal(validate({ ip: '10.20.0' }, schema)[0].keyword, 'pattern');

  const bad = validate({ ip: 'x' }, { type: 'object', properties: { ip: { type: 'string', pattern: '([' } } });
  assert.equal(bad[0].keyword, 'INVALID_SCHEMA');
  assert.match(bad[0].message, /invalid pattern/);
});

test('minimum and maximum are inclusive bounds on numbers', () => {
  const schema = { type: 'object', properties: { qty: { type: 'number', minimum: 1, maximum: 100 } } };
  assert.deepEqual(validate({ qty: 1 }, schema), []);
  assert.deepEqual(validate({ qty: 100 }, schema), []);
  assert.equal(validate({ qty: 0.99 }, schema)[0].keyword, 'minimum');
  assert.equal(validate({ qty: 100.01 }, schema)[0].keyword, 'maximum');
  assert.match(validate({ qty: 0 }, schema)[0].message, /must be >= 1 but is 0/);
});

test('additionalProperties: false rejects unknown keys, and is documented as an extension', () => {
  const schema = {
    type: 'object',
    properties: { ticker: { type: 'string' } },
    additionalProperties: false,
  };
  assert.deepEqual(validate({ ticker: 'AAPL' }, schema), []);
  const violations = validate({ ticker: 'AAPL', realAccount: true }, schema);
  assert.deepEqual(keywords(violations), ['additionalProperties']);
  assert.match(violations[0].message, /not an allowed property/);
});

test('unsupported keywords fail closed instead of being ignored', () => {
  const violations = validate({ a: 'x' }, { type: 'object', properties: { a: { type: 'string', minLength: 3 } } });
  assert.deepEqual(keywords(violations), ['UNSUPPORTED_KEYWORD']);
  assert.match(violations[0].message, /only enforces/);

  const oneOf = validate({}, { oneOf: [{ type: 'object' }] });
  assert.equal(oneOf[0].keyword, 'UNSUPPORTED_KEYWORD');
  assert.match(oneOf[0].message, /oneOf/);
});

test('annotation keywords are accepted and ignored', () => {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Thing',
    description: 'a described thing',
    default: {},
    examples: [{}],
    'x-internal': true,
    type: 'object',
    properties: { a: { type: 'string', description: 'the a value' } },
  };
  assert.deepEqual(validate({ a: 'x' }, schema), []);
});

test('malformed schema fragments are INVALID_SCHEMA, not silent passes', () => {
  assert.equal(validate({}, { required: 'poNumber' })[0].keyword, 'INVALID_SCHEMA');
  assert.equal(validate({}, { type: 'object', properties: [] })[0].keyword, 'INVALID_SCHEMA');
  assert.equal(validate([], { type: 'array', items: [{ type: 'string' }] })[0].keyword, 'INVALID_SCHEMA');
  assert.equal(validate({}, { type: 'float' })[0].keyword, 'INVALID_SCHEMA');
  assert.equal(validate({ a: 1 }, { enum: [] })[0].keyword, 'INVALID_SCHEMA');
});

test('empty schema accepts anything, non-object schema throws', () => {
  assert.deepEqual(validate('anything', {}), []);
  assert.throws(() => validate({}, null), TypeError);
  assert.throws(() => validate({}, []), TypeError);
});

test('validateOrThrow attaches the violations', () => {
  assert.throws(
    () => validateOrThrow({}, { type: 'object', required: ['a'] }, { label: 'args' }),
    (error) => {
      assert.equal(error.name, 'SchemaValidationError');
      assert.match(error.message, /args failed schema validation/);
      assert.equal(error.violations.length, 1);
      return true;
    },
  );
  assert.equal(validateOrThrow({}, { type: 'object' }), true);
});

test('every violation carries a human-readable message and a path', () => {
  const violations = validate({ ip: 'nope', count: -1 }, {
    type: 'object',
    required: ['missing'],
    properties: { ip: { type: 'string', pattern: '^[0-9.]+$' }, count: { type: 'integer', minimum: 0 } },
  });
  assert.equal(violations.length, 3);
  for (const violation of violations) {
    assert.equal(typeof violation.path, 'string');
    assert.equal(typeof violation.keyword, 'string');
    assert.ok(violation.message.length > 10);
  }
});
