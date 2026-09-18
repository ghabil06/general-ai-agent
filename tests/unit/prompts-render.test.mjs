/**
 * Prompt rendering: the happy path, and every way a render must refuse.
 *
 * The prompt files in `prompts/` are the repository's prompts of record and are
 * read, never written, by this test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createPromptRenderer,
  renderTemplate,
  findPlaceholders,
  placeholderPattern,
  stringifyPlaceholderValue,
  PromptRenderError,
  PROMPT_ERROR_CODES,
  AGENT_PROMPTS,
} from '../../src/prompts/render.mjs';
import { loadAgent } from '../../src/agents/index.mjs';
import { loadDataset } from '../helpers/fixtures.mjs';

const renderer = createPromptRenderer();

test('the placeholder syntax allows inner whitespace, exactly as the README documents', () => {
  const pattern = placeholderPattern('invoice_data');
  assert.equal('{{invoice_data}}'.replace(pattern, 'X'), 'X');
  assert.equal('{{ invoice_data }}'.replace(pattern, 'X'), 'X');
  assert.equal('{{  invoice_data  }}'.replace(pattern, 'X'), 'X');
  assert.equal('{{invoice_text}}'.replace(pattern, 'X'), '{{invoice_text}}', 'a different name is left alone');
  assert.deepEqual(findPlaceholders('a {{one}} b {{ two }} c {{one}}'), ['one', 'two'], 'names are de-duplicated, in order');
});

test('the SVC_03 prompt of record renders with the invoice substituted and no braces left', () => {
  const invoice = 'Invoice #777. Amount: $123.45. PO #990 verified.';
  const rendered = renderer.renderDetailed(AGENT_PROMPTS.svc_03.templatePath, { invoice_data: invoice });

  assert.ok(rendered.text.includes(invoice), 'the data is present verbatim');
  assert.ok(rendered.text.includes('# INVOICE UNDER REVIEW'), 'the section marker survives');
  assert.equal(rendered.text.includes('{{'), false, 'no placeholder syntax survives the render');
  assert.deepEqual(rendered.placeholders, ['invoice_data']);
  assert.equal(rendered.relativePath, 'svc_03/invoice_agent.md');
  assert.ok(rendered.characters > 1_000, 'the full prompt is rendered, not a fragment');
});

test('every agent with a prompt of record renders from its own dataset case', () => {
  const datasets = {
    svc_03: ['invoices_dataset.json', 'invoice_data'],
    svc_04: ['security_alerts_dataset.json', 'alert_data'],
    svc_06: ['trading_dataset.json', 'market_data'],
  };
  for (const [agentId, [file, dataVar]] of Object.entries(datasets)) {
    const [firstCase] = loadDataset(file);
    const text = renderer.renderAgentPrompt(agentId, firstCase.vars).text;
    assert.ok(text.includes(firstCase.vars[dataVar]), `${agentId}: the case data is in the prompt`);
    assert.equal(text.includes('{{'), false, `${agentId}: no braces survive`);
    // The marker the promptfoo fixtures slice on must be present, or the
    // existing offline providers would throw.
    assert.ok(text.includes(AGENT_PROMPTS[agentId].marker), `${agentId}: ${AGENT_PROMPTS[agentId].marker} is present`);
  }
});

test('the guardrail prompt loads raw, having no placeholder to fill', () => {
  const text = renderer.load(AGENT_PROMPTS.svc_03.guardrailPath);
  assert.match(text, /Compliance Guardrail/);
  assert.deepEqual(findPlaceholders(text), []);
  // It is NOT rendered: rendering it would demand a placeholder that does not exist.
  assert.throws(() => renderer.render(AGENT_PROMPTS.svc_03.guardrailPath, {}), (error) => {
    assert.equal(error.code, PROMPT_ERROR_CODES.PLACEHOLDER_MISSING);
    return true;
  });
});

test('an empty or missing value is refused, never sent as literal braces', () => {
  const template = 'DATA:\n{{x}}\nEND';
  const cases = [
    [undefined, PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY, 'absent'],
    [null, PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY, 'null'],
    ['', PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY, 'empty string'],
    ['   \n  ', PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY, 'whitespace only'],
    [{}, PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY, 'empty object'],
    [[], PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY, 'empty array'],
  ];
  for (const [value, code, label] of cases) {
    assert.throws(
      () => renderTemplate(template, { x: value }, { templatePath: 'test.md' }),
      (error) => {
        assert.equal(error.code, code, label);
        assert.equal(error.placeholder, 'x');
        assert.match(error.message, /\{\{x\}\}/, 'the message names the placeholder');
        return true;
      },
      `${label} must be refused`,
    );
  }
});

test('the exact prompt-of-record failure is refused: a missing placeholder value', () => {
  assert.throws(() => renderer.render(AGENT_PROMPTS.svc_03.templatePath, {}), (error) => {
    assert.ok(error instanceof PromptRenderError);
    assert.equal(error.code, PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY);
    assert.equal(error.templatePath, 'svc_03/invoice_agent.md');
    assert.match(error.message, /must never be sent with the literal placeholder text left in it/);
    return true;
  });
});

test('a template with no placeholder is refused when rendered, not loaded', () => {
  assert.throws(() => renderTemplate('no placeholders here', {}, { templatePath: 'plain.md' }), (error) => {
    assert.equal(error.code, PROMPT_ERROR_CODES.PLACEHOLDER_MISSING);
    return true;
  });
  // ...and the same rule does not block loading raw text.
  assert.equal(renderTemplate('plain text', {}, { templatePath: 'plain.md', requirePlaceholders: false }).text, 'plain text');
});

test('a leftover placeholder is refused rather than sent to a model', () => {
  // {{a}} is given a value that itself contains {{b}}, which nothing declared.
  assert.throws(() => renderTemplate('X {{a}}', { a: 'see {{b}}' }, { templatePath: 'nested.md' }), (error) => {
    assert.equal(error.code, PROMPT_ERROR_CODES.PLACEHOLDER_UNRESOLVED);
    assert.equal(error.placeholder, 'b');
    return true;
  });
});

test('a path outside prompts/ is refused: a caller cannot render arbitrary files', () => {
  assert.throws(() => renderer.load('../../package.json'), (error) => {
    assert.equal(error.code, PROMPT_ERROR_CODES.PATH_ESCAPE);
    return true;
  });
  assert.throws(() => renderer.load('C:/Windows/System32/drivers/etc/hosts'), (error) => {
    assert.equal(error.code, PROMPT_ERROR_CODES.PATH_ESCAPE);
    return true;
  });
});

test('a template that does not exist reports NOT_FOUND with the path it tried', () => {
  assert.throws(() => renderer.load('svc_03/nope.md'), (error) => {
    assert.equal(error.code, PROMPT_ERROR_CODES.NOT_FOUND);
    assert.match(error.message, /svc_03\/nope\.md/);
    return true;
  });
});

test('any values are substituted, once each, without touching the prompt files', () => {
  const absolute = path.resolve('prompts', AGENT_PROMPTS.svc_03.templatePath);
  const before = fs.readFileSync(absolute, 'utf8');
  renderer.render(AGENT_PROMPTS.svc_03.templatePath, { invoice_data: 'x'.repeat(10) });
  const after = fs.readFileSync(absolute, 'utf8');
  assert.equal(before, after, 'rendering must never write to the prompt of record');
  assert.equal(findPlaceholders(after).length, 1, 'the placeholder is still in the file');
});

test('placeholder value conversion is explicit and documented', () => {
  assert.deepEqual(stringifyPlaceholderValue('abc'), { text: 'abc', empty: false, reason: null });
  assert.equal(stringifyPlaceholderValue(42).text, '42');
  assert.equal(stringifyPlaceholderValue(false).text, 'false');
  assert.equal(stringifyPlaceholderValue({ a: 1 }).text, '{"a":1}');
  assert.equal(stringifyPlaceholderValue([1, 2]).text, '[1,2]');
  assert.equal(stringifyPlaceholderValue(undefined).empty, true);
  assert.equal(stringifyPlaceholderValue({}).empty, true);
  const circular = {};
  circular.self = circular;
  assert.equal(stringifyPlaceholderValue(circular).empty, true);
});

test('an agent with no prompt of record still yields its system instructions', () => {
  const general = loadAgent('general');
  assert.equal(general.prompts.system, null, 'the general agent has no prompt file');
  assert.match(general.prompts.systemFor({}), /Larptech General Purpose Agent/);
  assert.equal(general.prompts.promptSource, 'src/agents/general/index.mjs#GENERAL_SYSTEM_PROMPT');
  // The renderer refuses it, because there is no file — the agent answers in code.
  assert.throws(() => renderer.renderAgentPrompt('general', {}), (error) => {
    assert.equal(error.code, PROMPT_ERROR_CODES.UNKNOWN_AGENT);
    return true;
  });
});
