/**
 * JSON-schema-subset validator.
 *
 * Real implementation, no dependency, no `eval`. It exists so the tool executor
 * can reject bad arguments *before* a tool runs, deterministically and with a
 * useful message — the tool itself is never the first line of validation.
 *
 * Supported keywords:
 *
 *   type          'object' | 'array' | 'string' | 'number' | 'integer' |
 *                 'boolean' | 'null'
 *   required      string[]              (object)
 *   properties    { [key]: schema }     (object)
 *   additionalProperties  boolean       (object; extension, documented)
 *   items         schema                (array; single schema, not a tuple)
 *   enum          unknown[]             (deep equality)
 *   const         unknown               (deep equality)
 *   minimum       number                (inclusive)
 *   maximum       number                (inclusive)
 *   pattern       string                (regex, string values only)
 *
 * Annotation keywords are accepted and ignored: `description`, `title`,
 * `default`, `examples`, `$schema`, `x-*`.
 *
 * **Fail closed on anything else.** An unsupported keyword is reported as a
 * violation (`UNSUPPORTED_KEYWORD`) rather than silently ignored: a tool author
 * who writes `exclusiveMinimum` or `oneOf` must learn immediately that this
 * validator does not enforce it, because a silently-ignored constraint is a
 * constraint that is not enforced. An invalid schema (bad regex, `required` on
 * a non-object) is reported as `INVALID_SCHEMA`.
 *
 * `validate(value, schema)` returns a **list of violations**, each
 * `{ path, keyword, message }`. An empty list means valid. It never throws for
 * value or schema problems; it throws only if `schema` is not an object.
 */

import { deepClone } from '../util/canonical.mjs';

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'pattern',
]);

const IGNORED_ANNOTATION_KEYWORDS = new Set([
  'description',
  'title',
  'default',
  'examples',
  'example',
  '$schema',
  '$id',
  'deprecated',
  'readOnly',
  'writeOnly',
]);

const TYPE_NAMES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value; // 'object' | 'string' | 'number' | 'boolean' | 'undefined' | 'function'
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

/** JSON-ish deep equality via the canonical form. */
function deepEqual(a, b) {
  try {
    return JSON.stringify(deepClone(a)) === JSON.stringify(deepClone(b));
  } catch {
    return false;
  }
}

function describeValue(value) {
  const type = typeOf(value);
  if (type === 'string') return `"${value}"`;
  if (type === 'object') return `object with keys [${Object.keys(value).slice(0, 6).join(', ')}]`;
  if (type === 'array') return `array of ${value.length}`;
  return String(value);
}

/**
 * @param {unknown} value
 * @param {object}  schema
 * @param {object}  [options]
 * @param {string}  [options.path]  JSON path prefix for messages
 * @returns {Array<{path: string, keyword: string, message: string}>}
 */
export function validate(value, schema, { path = '$' } = {}) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError('validate: `schema` must be a plain object');
  }
  const violations = [];
  walk(value, schema, path, violations);
  return violations;
}

function push(violations, path, keyword, message) {
  violations.push({ path, keyword, message });
}

function walk(value, schema, path, violations) {
  // --- schema self-check --------------------------------------------------
  for (const keyword of Object.keys(schema)) {
    if (SUPPORTED_KEYWORDS.has(keyword)) continue;
    if (IGNORED_ANNOTATION_KEYWORDS.has(keyword) || keyword.startsWith('x-')) continue;
    push(
      violations,
      path,
      'UNSUPPORTED_KEYWORD',
      `schema at ${path} uses unsupported keyword "${keyword}"; this validator only enforces ` +
        `${[...SUPPORTED_KEYWORDS].join(', ')}. Rewrite the schema or extend src/tools/schema.mjs.`,
    );
  }

  if (schema.type !== undefined) {
    if (typeof schema.type !== 'string' || !TYPE_NAMES.includes(schema.type)) {
      push(violations, path, 'INVALID_SCHEMA', `schema at ${path} has invalid "type" ${JSON.stringify(schema.type)}`);
      return;
    }
    if (!typeMatches(value, schema.type)) {
      push(
        violations,
        path,
        'type',
        `${path} must be of type ${schema.type} but received ${typeOf(value)} (${describeValue(value)})`,
      );
      return; // a type mismatch makes every other check noise
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    push(violations, path, 'const', `${path} must equal ${JSON.stringify(schema.const)} but is ${JSON.stringify(value)}`);
  }

  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      push(violations, path, 'INVALID_SCHEMA', `schema at ${path} has an empty or non-array "enum"`);
    } else if (!schema.enum.some((candidate) => deepEqual(value, candidate))) {
      push(
        violations,
        path,
        'enum',
        `${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')} but is ${JSON.stringify(value)}`,
      );
    }
  }

  if (typeof value === 'string') {
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== 'string') {
        push(violations, path, 'INVALID_SCHEMA', `schema at ${path} has a non-string "pattern"`);
      } else {
        let regex;
        try {
          regex = new RegExp(schema.pattern);
        } catch (err) {
          push(violations, path, 'INVALID_SCHEMA', `schema at ${path} has an invalid pattern: ${err.message}`);
        }
        if (regex && !regex.test(value)) {
          push(violations, path, 'pattern', `${path} must match /${schema.pattern}/ but is ${JSON.stringify(value)}`);
        }
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined) {
      if (typeof schema.minimum !== 'number') {
        push(violations, path, 'INVALID_SCHEMA', `schema at ${path} has a non-numeric "minimum"`);
      } else if (value < schema.minimum) {
        push(violations, path, 'minimum', `${path} must be >= ${schema.minimum} but is ${value}`);
      }
    }
    if (schema.maximum !== undefined) {
      if (typeof schema.maximum !== 'number') {
        push(violations, path, 'INVALID_SCHEMA', `schema at ${path} has a non-numeric "maximum"`);
      } else if (value > schema.maximum) {
        push(violations, path, 'maximum', `${path} must be <= ${schema.maximum} but is ${value}`);
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.items !== undefined) {
      if (schema.items === null || typeof schema.items !== 'object' || Array.isArray(schema.items)) {
        push(violations, path, 'INVALID_SCHEMA', `schema at ${path} has an invalid "items" (a single schema is supported)`);
      } else {
        value.forEach((item, index) => walk(item, schema.items, `${path}[${index}]`, violations));
      }
    }
  }

  if (typeOf(value) === 'object') {
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required)) {
        push(violations, path, 'INVALID_SCHEMA', `schema at ${path} has a non-array "required"`);
      } else {
        for (const key of schema.required) {
          if (value[key] === undefined) {
            push(violations, `${path}.${key}`, 'required', `${path}.${key} is required but was not provided`);
          }
        }
      }
    }

    if (schema.properties !== undefined) {
      if (schema.properties === null || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
        push(violations, path, 'INVALID_SCHEMA', `schema at ${path} has a non-object "properties"`);
      } else {
        for (const [key, childSchema] of Object.entries(schema.properties)) {
          if (value[key] === undefined) continue; // absence is `required`'s business
          walk(value[key], childSchema, `${path}.${key}`, violations);
        }
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          push(
            violations,
            `${path}.${key}`,
            'additionalProperties',
            `${path}.${key} is not an allowed property (allowed: ${[...allowed].join(', ') || 'none'})`,
          );
        }
      }
    } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      push(
        violations,
        path,
        'INVALID_SCHEMA',
        `schema at ${path} has a non-boolean "additionalProperties"; only true/false are supported`,
      );
    }
  }
}

/** Convenience predicate. */
export function isValid(value, schema) {
  return validate(value, schema).length === 0;
}

/** Human-readable strings, one per violation. */
export function formatViolations(violations) {
  return violations.map((violation) => violation.message);
}

/** @throws {Error} with `.violations` attached when invalid. */
export function validateOrThrow(value, schema, { label = 'value' } = {}) {
  const violations = validate(value, schema);
  if (violations.length) {
    const error = new Error(`${label} failed schema validation: ${formatViolations(violations).join('; ')}`);
    error.name = 'SchemaValidationError';
    error.violations = violations;
    throw error;
  }
  return true;
}
