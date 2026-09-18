/**
 * Lazy JSON fixture loader for the built-in tools.
 *
 * Real implementation. Fixtures are read from `data/fixtures/` on first use and
 * cached in-process. Nothing is read at import time, so importing a tool never
 * touches the filesystem — which keeps module loading side-effect free and
 * makes `node --test` able to import every module without a fixture present.
 */

import fs from 'node:fs';
import path from 'node:path';

export class FixtureError extends Error {
  constructor(code, message, { fixture } = {}) {
    super(`${code}: ${message}`);
    this.name = 'FixtureError';
    this.code = code;
    this.fixture = fixture ?? null;
  }
}

export const FIXTURE_ERROR_CODES = Object.freeze({
  NOT_FOUND: 'FIXTURE_NOT_FOUND',
  MALFORMED: 'FIXTURE_MALFORMED',
});

/**
 * @param {object}   options
 * @param {string}   options.fixturesDir  absolute path to `data/fixtures`
 * @param {object}   [options.fsImpl]     injectable fs (for tests)
 */
export function createFixtureLoader({ fixturesDir, fsImpl = fs } = {}) {
  if (typeof fixturesDir !== 'string' || !fixturesDir) {
    throw new TypeError('createFixtureLoader: `fixturesDir` is required');
  }

  const cache = new Map();

  function filePath(name) {
    return path.join(fixturesDir, `${name}.json`);
  }

  /**
   * @param {string} name fixture stem, e.g. 'po_database'
   * @returns {object} parsed fixture (shared reference — treat as read-only)
   */
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const file = filePath(name);
    let raw;
    try {
      raw = fsImpl.readFileSync(file, 'utf8');
    } catch (err) {
      throw new FixtureError(FIXTURE_ERROR_CODES.NOT_FOUND, `cannot read fixture "${file}": ${err.message}`, {
        fixture: name,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new FixtureError(FIXTURE_ERROR_CODES.MALFORMED, `fixture "${file}" is not valid JSON: ${err.message}`, {
        fixture: name,
      });
    }
    cache.set(name, parsed);
    return parsed;
  }

  return {
    fixturesDir,
    load,
    has: (name) => fs.existsSync(filePath(name)),
    pathFor: filePath,
    /** Drop the cache — used by tests that rewrite a fixture. */
    clear: () => cache.clear(),
  };
}
