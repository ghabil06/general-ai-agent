/**
 * Prompt rendering.
 *
 * Real implementation, and the ONLY place in `src/` that turns a prompt file
 * into a string a model will read. It does exactly what `README.md` §"Feeding
 * the prompt to n8n" tells a workflow author to do, in code:
 *
 *     system_prompt = body.replace(/[{]{2}\s*invoice_data\s*[}]{2}/g, invoice_text)
 *
 * The placeholder syntax therefore allows inner whitespace (`{{ invoice_data }}`
 * is the same placeholder as `{{invoice_data}}`), and every occurrence is
 * substituted, not just the first.
 *
 * ── What "strict" means here ────────────────────────────────────────────────
 * The README's warning is that a failed substitution sends the literal
 * characters `{{invoice_data}}` to the model, which reads them as prose. So a
 * render that would produce a prompt with an unresolvable placeholder is an
 * ERROR, never a prompt:
 *
 *   1. the template must contain at least one `{{placeholder}}`
 *      -> `PLACEHOLDER_MISSING`
 *   2. every placeholder must be given a value
 *      -> `PLACEHOLDER_VALUE_EMPTY` (absent / null / '' / {} / [])
 *      -> `PLACEHOLDER_VALUE_INVALID` (not convertible to a non-empty string)
 *   3. no `{{...}}` may survive the substitution
 *      -> `PLACEHOLDER_UNRESOLVED`
 *   4. a template path may not escape the prompts directory; a Windows-rooted path
 *      (`C:/x`, `C:\x`, `\\server\share`, `\x`) counts as an escape on EVERY host,
 *      not only on Windows
 *      -> `PROMPT_PATH_ESCAPE`
 *
 * The four prompt files are read, never written. `prompts/` is a source of
 * truth this module depends on and does not own.
 */

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config/index.mjs';

/** The one placeholder pattern, shared by `findPlaceholders` and `render`. */
export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * The prompt of record and its data placeholder, per agent. Mirrors the
 * `datasetPath`/`promptPath` pairing in `src/config/agents.mjs`; the dataset
 * files are what the eval harness fills the placeholder from.
 */
export const AGENT_PROMPTS = Object.freeze({
  svc_03: Object.freeze({
    templatePath: 'svc_03/invoice_agent.md',
    guardrailPath: 'svc_03/guardrail.md',
    placeholder: 'invoice_data',
    dataVar: 'invoice_data',
    marker: '# INVOICE UNDER REVIEW',
  }),
  svc_04: Object.freeze({
    templatePath: 'svc_04/security_triage_agent.md',
    guardrailPath: null,
    placeholder: 'alert_data',
    dataVar: 'alert_data',
    marker: '# ALERT UNDER REVIEW',
  }),
  svc_06: Object.freeze({
    templatePath: 'svc_06/paper_trading_agent.md',
    guardrailPath: null,
    placeholder: 'market_data',
    dataVar: 'market_data',
    marker: '# ORDER REQUEST AND ACCOUNT STATE',
  }),
});

export const PROMPT_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'PROMPT_NOT_FOUND',
  READ_FAILED: 'PROMPT_READ_FAILED',
  PATH_ESCAPE: 'PROMPT_PATH_ESCAPE',
  PLACEHOLDER_MISSING: 'PLACEHOLDER_MISSING',
  PLACEHOLDER_VALUE_EMPTY: 'PLACEHOLDER_VALUE_EMPTY',
  PLACEHOLDER_VALUE_INVALID: 'PLACEHOLDER_VALUE_INVALID',
  PLACEHOLDER_UNRESOLVED: 'PLACEHOLDER_UNRESOLVED',
  UNKNOWN_AGENT: 'PROMPT_UNKNOWN_AGENT',
});

export class PromptRenderError extends Error {
  constructor(code, message, { templatePath = null, placeholder = null, value = undefined } = {}) {
    super(`${code}: ${message}`);
    this.name = 'PromptRenderError';
    this.code = code;
    this.templatePath = templatePath;
    this.placeholder = placeholder;
    this.value = value;
  }
}

/** Every placeholder name in a template, in order of first appearance. */
export function findPlaceholders(template) {
  const found = [];
  const pattern = new RegExp(PLACEHOLDER_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(String(template ?? ''))) !== null) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/** The regex the README documents, for one placeholder name. */
export function placeholderPattern(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new TypeError(`placeholderPattern: invalid placeholder name ${JSON.stringify(name)}`);
  }
  return new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
}

/**
 * Convert a value to the string that will be substituted.
 *
 * Strings are used as-is (no trimming — leading indentation in a dataset case is
 * the dataset author's choice). Everything else is serialised, and anything
 * that serialises to nothing is "empty".
 *
 * @returns {{text: string, empty: boolean, reason: string|null}}
 */
export function stringifyPlaceholderValue(value) {
  if (value === undefined) return { text: '', empty: true, reason: 'no value was provided' };
  if (value === null) return { text: '', empty: true, reason: 'value is null' };
  if (typeof value === 'string') {
    return { text: value, empty: value.trim().length === 0, reason: value.trim().length === 0 ? 'value is an empty string' : null };
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return { text: String(value), empty: false, reason: null };
  }
  if (typeof value === 'object') {
    let text;
    try {
      text = JSON.stringify(value);
    } catch (err) {
      return { text: '', empty: true, reason: `value is not serialisable: ${err.message}` };
    }
    const structural = Array.isArray(value) ? '[]' : '{}';
    if (text === structural) {
      return { text: '', empty: true, reason: `value is an empty ${Array.isArray(value) ? 'array' : 'object'}` };
    }
    return { text, empty: false, reason: null };
  }
  return { text: '', empty: true, reason: `value of type ${typeof value} cannot be rendered` };
}

/** Substitute every placeholder in a template string. Pure — no filesystem. */
export function renderTemplate(template, values = {}, { templatePath = '<string>', requirePlaceholders = true } = {}) {
  const text = String(template ?? '');
  const placeholders = findPlaceholders(text);

  if (!placeholders.length && requirePlaceholders) {
    throw new PromptRenderError(
      PROMPT_ERROR_CODES.PLACEHOLDER_MISSING,
      `template "${templatePath}" contains no {{placeholder}}. A prompt that is meant to carry data must have one ` +
        `(e.g. {{invoice_data}}); a prompt that carries no data must be loaded, not rendered`,
      { templatePath },
    );
  }

  let rendered = text;
  const substitutions = {};

  for (const name of placeholders) {
    const { text: replacement, empty, reason } = stringifyPlaceholderValue(values[name]);
    if (empty) {
      const code =
        values[name] === undefined || values[name] === null
          ? PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY
          : PROMPT_ERROR_CODES.PLACEHOLDER_VALUE_EMPTY;
      throw new PromptRenderError(
        code,
        `cannot render "${templatePath}": {{${name}}} resolved to nothing (${reason}). A prompt must never be sent ` +
          'with an empty data section, and must never be sent with the literal placeholder text left in it',
        { templatePath, placeholder: name, value: values[name] },
      );
    }
    rendered = rendered.replace(placeholderPattern(name), () => replacement);
    substitutions[name] = { characters: replacement.length, empty: false };
  }

  const leftover = findPlaceholders(rendered);
  if (leftover.length) {
    throw new PromptRenderError(
      PROMPT_ERROR_CODES.PLACEHOLDER_UNRESOLVED,
      `rendering "${templatePath}" left ${leftover.map((name) => `{{${name}}}`).join(', ')} unsubstituted. ` +
        'Sending a raw placeholder to a model means the model reads the braces as prose',
      { templatePath, placeholder: leftover[0] },
    );
  }

  return { text: rendered, placeholders, substitutions, templatePath };
}

/**
 * @param {object}   [options]
 * @param {string}   [options.promptsDir]  default `<repo>/prompts`
 * @param {string}   [options.repoRoot]
 * @param {Function} [options.readFile]
 */
export function createPromptRenderer({ promptsDir = path.join(REPO_ROOT, 'prompts'), repoRoot = REPO_ROOT, readFile } = {}) {
  const read = readFile ?? ((absolute) => fs.readFileSync(absolute, 'utf8'));

  /** Resolve a template path, refusing anything outside `promptsDir`. */
  function resolveTemplate(templatePath) {
    if (typeof templatePath !== 'string' || !templatePath.trim()) {
      throw new PromptRenderError(PROMPT_ERROR_CODES.NOT_FOUND, `invalid template path ${JSON.stringify(templatePath)}`, {
        templatePath,
      });
    }
    // `C:/x`, `C:\x`, `\\server\share` and `\x` are absolute on Windows, but on a POSIX host `path.isAbsolute` calls
    // them relative, so they would resolve to a (missing) file INSIDE promptsDir and be reported as NOT_FOUND instead
    // of an escape. They are never a valid template name on any host, so refuse them everywhere and keep the verdict
    // independent of the OS. On Windows `path.isAbsolute` already is `path.win32.isAbsolute`: nothing changes there.
    if (!path.isAbsolute(templatePath) && path.win32.isAbsolute(templatePath)) {
      throw new PromptRenderError(
        PROMPT_ERROR_CODES.PATH_ESCAPE,
        `template "${templatePath}" is a Windows-rooted path (drive, UNC or backslash-rooted); template paths are ` +
          'relative to the prompts directory, so a caller cannot render arbitrary files as a system prompt',
        { templatePath },
      );
    }
    const absolute = path.isAbsolute(templatePath) ? templatePath : path.resolve(promptsDir, templatePath);
    const within = path.relative(promptsDir, absolute);
    if (within.startsWith('..') || path.isAbsolute(within)) {
      throw new PromptRenderError(
        PROMPT_ERROR_CODES.PATH_ESCAPE,
        `template "${templatePath}" resolves outside the prompts directory (${promptsDir}); prompts are read from ` +
          'one directory so a caller cannot render arbitrary files as a system prompt',
        { templatePath },
      );
    }
    return { absolute, relative: within.split(path.sep).join('/') };
  }

  /** Raw template text. Used for prompts that carry no data (e.g. the guardrail). */
  function load(templatePath) {
    const { absolute, relative } = resolveTemplate(templatePath);
    try {
      return read(absolute);
    } catch (err) {
      const code = err?.code === 'ENOENT' ? PROMPT_ERROR_CODES.NOT_FOUND : PROMPT_ERROR_CODES.READ_FAILED;
      throw new PromptRenderError(code, `cannot read prompt "${relative}" at ${absolute}: ${err.message}`, {
        templatePath: relative,
      });
    }
  }

  /** @returns {string} the rendered system prompt */
  function render(templatePath, values = {}, options = {}) {
    return renderDetailed(templatePath, values, options).text;
  }

  /** @returns {{text: string, placeholders: string[], substitutions: object, relativePath: string, characters: number}} */
  function renderDetailed(templatePath, values = {}, { requirePlaceholders = true } = {}) {
    const template = load(templatePath);
    const { relative } = resolveTemplate(templatePath);
    const outcome = renderTemplate(template, values, { templatePath: relative, requirePlaceholders });
    return { ...outcome, relativePath: relative, characters: outcome.text.length };
  }

  /** Render the prompt of record for an agent from a dataset `vars` object. */
  function renderAgentPrompt(agentId, vars = {}, options = {}) {
    const spec = AGENT_PROMPTS[agentId];
    if (!spec) {
      throw new PromptRenderError(
        PROMPT_ERROR_CODES.UNKNOWN_AGENT,
        `no prompt of record for agent "${agentId}" (known: ${Object.keys(AGENT_PROMPTS).join(', ')})`,
      );
    }
    return renderDetailed(spec.templatePath, { [spec.placeholder]: vars[spec.dataVar] }, options);
  }

  return {
    promptsDir,
    load,
    render,
    renderDetailed,
    renderAgentPrompt,
    placeholdersOf(templatePath) {
      return findPlaceholders(load(templatePath));
    },
    /** Path of the prompt of record for an agent, relative to the repo root. */
    promptPathFor(agentId) {
      const spec = AGENT_PROMPTS[agentId];
      if (!spec) return null;
      return `prompts/${spec.templatePath}`;
    },
    guardrailPathFor(agentId) {
      const spec = AGENT_PROMPTS[agentId];
      return spec?.guardrailPath ? `prompts/${spec.guardrailPath}` : null;
    },
    describe() {
      return {
        promptsDir,
        repoRoot,
        agents: Object.entries(AGENT_PROMPTS).map(([agentId, spec]) => ({
          agentId,
          templatePath: spec.templatePath,
          placeholder: spec.placeholder,
          guardrailPath: spec.guardrailPath,
        })),
      };
    },
  };
}
