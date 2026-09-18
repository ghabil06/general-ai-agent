/**
 * Tool registry: definition validation, lookup, and the model-facing projection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RISK_LEVELS,
  SIDE_EFFECTS,
  ToolDefinitionError,
  createToolRegistry,
  defineTool,
  validateToolArguments,
} from '../../src/tools/registry.mjs';

function tool(overrides = {}) {
  return {
    name: 'example_tool',
    description: 'An example tool used by the registry tests.',
    inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    riskLevel: 'low',
    sideEffect: 'none',
    execute: async ({ value }) => ({ ok: true, value }),
    ...overrides,
  };
}

test('defineTool freezes a well-formed definition and defaults sideEffect', () => {
  const defined = defineTool(tool({ sideEffect: undefined }));
  assert.equal(Object.isFrozen(defined), true);
  assert.equal(defined.sideEffect, 'read');
  assert.equal(defined.destructive, false);
  assert.equal(defined.escalation, false);
  assert.deepEqual([...defined.permissions], []);
  assert.equal(defined.timeoutMs, null);
});

test('defineTool rejects malformed definitions with a typed error', () => {
  const cases = [
    [tool({ name: 'NotSnakeCase' }), /lower_snake_case/],
    [tool({ name: '9leading' }), /lower_snake_case/],
    [tool({ description: 'short' }), /description/],
    [tool({ inputSchema: null }), /inputSchema/],
    [tool({ riskLevel: 'extreme' }), /riskLevel/],
    [tool({ sideEffect: 'teleport' }), /sideEffect/],
    [tool({ execute: 'not a function' }), /execute/],
    [tool({ permissions: 'po:read' }), /permissions\/dataAccess/],
  ];
  for (const [definition, pattern] of cases) {
    assert.throws(() => defineTool(definition), (error) => {
      assert.ok(error instanceof ToolDefinitionError);
      assert.match(error.message, pattern);
      return true;
    });
  }
  assert.deepEqual(RISK_LEVELS, ['low', 'medium', 'high', 'critical']);
  assert.deepEqual(SIDE_EFFECTS, ['none', 'read', 'write', 'external', 'destructive']);
});

test('destructive side effect sets the shorthand flag', () => {
  const defined = defineTool(tool({ name: 'delete_everything', sideEffect: 'destructive', riskLevel: 'critical' }));
  assert.equal(defined.destructive, true);
});

test('register / get / has / list / names behave, and duplicates are refused', () => {
  const registry = createToolRegistry();
  assert.equal(registry.size, 0);
  registry.register(tool({ name: 'alpha' }));
  registry.register(tool({ name: 'beta' }));

  assert.equal(registry.has('alpha'), true);
  assert.equal(registry.has('gamma'), false);
  assert.equal(registry.get('gamma'), null);
  assert.equal(registry.get('alpha').name, 'alpha');
  assert.deepEqual(registry.names(), ['alpha', 'beta']);
  assert.equal(registry.size, 2);
  assert.throws(() => registry.require('gamma'), /not registered/);
  assert.equal(registry.require('beta').name, 'beta');
  assert.throws(() => registry.register(tool({ name: 'alpha' })), /already registered/);
  assert.throws(() => registry.require('nope'), (error) => {
    assert.ok(error instanceof ToolDefinitionError);
    assert.match(error.message, /not registered/);
    assert.equal(error.tool, 'nope');
    return true;
  });
});

test('construction validates each tool once', () => {
  assert.throws(() => createToolRegistry({ tools: [tool({ riskLevel: 'nope' })] }), ToolDefinitionError);
  const registry = createToolRegistry({ tools: [defineTool(tool({ name: 'frozen_one' }))] });
  assert.equal(registry.size, 1);
});

test('forProfile returns the profile tools in the profile order and tolerates unknowns', () => {
  const registry = createToolRegistry({ tools: [tool({ name: 'a' }), tool({ name: 'b' }), tool({ name: 'c' })] });
  const profile = { id: 'svc_test', tools: ['c', 'missing', 'a'] };
  assert.deepEqual(
    registry.forProfile(profile).map((entry) => entry.name),
    ['c', 'a'],
  );
  assert.deepEqual(registry.forProfile({}), []);
  assert.deepEqual(registry.forProfile(null), []);
});

test('toModelTools exposes only name, description and inputSchema', () => {
  const registry = createToolRegistry({
    tools: [tool({ name: 'secretive', riskLevel: 'critical', sideEffect: 'destructive', permissions: ['x:y'], requiresConfirmation: true })],
  });
  const [modelTool] = registry.toModelTools();
  assert.deepEqual(Object.keys(modelTool).sort(), ['description', 'inputSchema', 'name']);
  assert.equal(modelTool.riskLevel, undefined);
  assert.equal(modelTool.permissions, undefined);

  const filtered = registry.toModelTools({ names: ['secretive', 'absent'] });
  assert.equal(filtered.length, 1);
});

test('describe reports the fields the policy kernel and docs care about', () => {
  const registry = createToolRegistry({
    tools: [tool({ name: 'described', riskLevel: 'medium', sideEffect: 'write', permissions: ['p:1'], dataAccess: ['d/1'], requiresConfirmation: true, escalation: true })],
  });
  const [description] = registry.describe();
  assert.equal(description.name, 'described');
  assert.equal(description.riskLevel, 'medium');
  assert.equal(description.sideEffect, 'write');
  assert.equal(description.requiresConfirmation, true);
  assert.deepEqual(description.permissions, ['p:1']);
  assert.deepEqual(description.dataAccess, ['d/1']);
});

test('validateToolArguments runs the declared input schema', () => {
  const defined = defineTool(tool());
  assert.deepEqual(validateToolArguments(defined, { value: 1 }), []);
  const violations = validateToolArguments(defined, {});
  assert.equal(violations.length, 1);
  assert.equal(violations[0].keyword, 'required');
  // undefined args are treated as {} rather than crashing
  assert.equal(validateToolArguments(defined, undefined).length, 1);
});
