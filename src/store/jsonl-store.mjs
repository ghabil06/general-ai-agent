/**
 * Append-only JSONL storage.
 *
 * Real implementation, on top of `node:fs` only. One file per collection, one
 * JSON object per line, no database and no dependency.
 *
 * Guarantees:
 *   - **Append-only.** Records are never rewritten in place, so a crash mid-run
 *     leaves every previously committed record intact.
 *   - **Survives restart.** Nothing is cached: `readAll()` always re-reads the
 *     file, so a second process (or the same process restarted) sees the
 *     records written earlier.
 *   - **Tolerant reads.** A corrupt or hand-edited line becomes a structured
 *     error entry in `errors[]` — it is reported, never thrown, and the
 *     remaining lines still parse. A run's history survives one bad byte.
 */

import fs from 'node:fs';
import path from 'node:path';

export class JsonlStore {
  /**
   * @param {object} options
   * @param {string} options.dir   directory holding the file
   * @param {string} options.name  collection name; file is `<name>.jsonl`
   * @param {string} [options.extension]
   */
  constructor({ dir, name, extension = 'jsonl' }) {
    if (!dir) throw new TypeError('JsonlStore: `dir` is required');
    if (!name) throw new TypeError('JsonlStore: `name` is required');
    this.dir = dir;
    this.name = name;
    this.path = path.join(dir, `${name}.${extension}`);
  }

  /** Create the directory on demand. Called before every write. */
  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Append one record. The record is serialised as a single line; an object
   * that cannot be serialised (circular, BigInt) is a programming error and
   * throws here rather than silently writing garbage.
   *
   * @param {object} record
   * @returns {object} the record as written
   */
  append(record) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      // Arrays are refused to keep writes symmetric with reads: `readAll()`
      // reports an array line as a corrupt record, so it must not be writable.
      throw new TypeError(`${this.name}.append: record must be a plain object, got ${Array.isArray(record) ? 'array' : typeof record}`);
    }
    this.ensureDir();
    let line;
    try {
      line = JSON.stringify(record);
    } catch (err) {
      throw new TypeError(`${this.name}.append: record is not serialisable: ${err.message}`);
    }
    fs.appendFileSync(this.path, `${line}\n`, 'utf8');
    return record;
  }

  appendMany(records) {
    for (const record of records) this.append(record);
    return records.length;
  }

  exists() {
    return fs.existsSync(this.path);
  }

  /**
   * Read every parseable record.
   *
   * @returns {{records: object[], errors: object[], corruptLines: number, lineCount: number, path: string}}
   *   `errors[]` entries: `{ ok: false, line, raw, error }`. `corruptLines` is
   *   the same count under the name `health()` and the verification script use.
   */
  readAll() {
    if (!this.exists()) return { records: [], errors: [], corruptLines: 0, lineCount: 0, path: this.path };

    const content = fs.readFileSync(this.path, 'utf8');
    const lines = content.split('\n');
    const records = [];
    const errors = [];
    let lineCount = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      if (raw.trim() === '') continue; // blank line — including the trailing newline
      lineCount += 1;

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        errors.push({ ok: false, line: i + 1, raw: raw.slice(0, 500), error: `invalid JSON: ${err.message}` });
        continue;
      }

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push({
          ok: false,
          line: i + 1,
          raw: raw.slice(0, 500),
          error: `expected a JSON object, got ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`,
        });
        continue;
      }

      records.push(parsed);
    }

    return { records, errors, corruptLines: errors.length, lineCount, path: this.path };
  }

  /** Records only. Use `readAll()` when you need the parse errors too. */
  readRecords() {
    return this.readAll().records;
  }

  /**
   * All records whose `field` equals `id`, oldest first.
   * @param {string} id
   * @param {string} [field]
   */
  listById(id, field = 'id') {
    return this.readRecords().filter((record) => record?.[field] === id);
  }

  /** Most recent record for `id`, or null. */
  latestById(id, field = 'id') {
    const matches = this.listById(id, field);
    return matches.length ? matches[matches.length - 1] : null;
  }

  /** Last `limit` records, oldest first. */
  readTail(limit = 20) {
    const records = this.readRecords();
    return records.slice(Math.max(0, records.length - limit));
  }

  count() {
    return this.readRecords().length;
  }

  /**
   * Collapse a collection keyed by `id` into latest-wins state. Used by the
   * approval store, where lifecycle updates are appended rather than rewritten.
   */
  reduceLatest(field = 'id') {
    const map = new Map();
    for (const record of this.readRecords()) {
      const key = record?.[field];
      if (key === undefined) continue;
      map.set(key, record);
    }
    return map;
  }
}

/** Convenience factory — `createJsonlStore({ dir, name })`. */
export function createJsonlStore(options) {
  return new JsonlStore(options);
}
