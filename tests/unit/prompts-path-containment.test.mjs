/**
 * Prompt path containment: the prompts directory is one boundary, and it is the same boundary on every host.
 *
 * `prompts-render.test.mjs` pins one traversal input and one Windows path. This file pins each class of template
 * path that must NOT be read, and the ways a path may legitimately stay inside `prompts/`:
 *
 *   - a Windows-rooted path (`C:/x`, `C:\x`, `\\server\share\x`, `\x`) is `PROMPT_PATH_ESCAPE` on EVERY host. On a
 *     POSIX host `path.isAbsolute` calls those strings relative, so without the guard they resolve to a missing file
 *     INSIDE the prompts directory, the reader runs, and the caller sees `PROMPT_NOT_FOUND` instead of an escape;
 *   - traversal, POSIX-absolute and sibling-prefix paths are `PROMPT_PATH_ESCAPE` even when the target really exists:
 *     the fixtures plant real files exactly where a broken check would read them;
 *   - "refused" is proven by the file reader never running, not inferred from the error code.
 *
 * Isolation: every directory is a fresh `mkdtemp` under the OS temp dir and is removed afterwards. Nothing here reads
 * or writes the repo's `prompts/`, and nothing depends on the working directory. Expectations are computed with the
 * host's own `path` functions, so none of them is specific to one operating system.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createPromptRenderer, PromptRenderError, PROMPT_ERROR_CODES } from '../../src/prompts/render.mjs';
import { createRuntime } from '../../src/index.mjs';
import { testConfig } from '../helpers/runtime.mjs';
import { tempStorageDir, fixedClock, FIXTURES_DIR } from '../helpers/fixtures.mjs';

const { PATH_ESCAPE, NOT_FOUND } = PROMPT_ERROR_CODES;

// ── fixtures ────────────────────────────────────────────────────────────────

const cleanup = [];
const track = (dir) => {
  cleanup.push(dir);
  return dir;
};
after(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

const tmpRoot = track(fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-containment-')));
const promptsDir = path.join(tmpRoot, 'prompts');
const siblingDir = path.join(tmpRoot, 'prompts-evil'); // its name starts with the prompts directory's name

const PROMPT_REL = 'svc_03/invoice_agent.md'; // forward slashes work on every host
const PROMPT_ABS = path.join(promptsDir, 'svc_03', 'invoice_agent.md');
const PROMPT_TEXT = '# INVOICE UNDER REVIEW\n{{invoice_data}}\n';
const RENDERED_X = '# INVOICE UNDER REVIEW\nx\n';
const OUTSIDE_FILE = path.join(tmpRoot, 'outside.md'); // a real file one level above prompts/
const SIBLING_FILE = path.join(siblingDir, 'secret.md'); // a real file in the look-alike sibling directory

fs.mkdirSync(path.dirname(PROMPT_ABS), { recursive: true });
fs.mkdirSync(siblingDir, { recursive: true });
fs.writeFileSync(PROMPT_ABS, PROMPT_TEXT);
fs.writeFileSync(OUTSIDE_FILE, 'OUTSIDE-SECRET\n');
fs.writeFileSync(SIBLING_FILE, 'SIBLING-SECRET\n');

/** Windows drive-rooted paths, with forward slashes and with backslashes. */
const DRIVE_ROOTED = [
  'C:/Windows/System32/drivers/etc/hosts', // the literal prompts-render.test.mjs uses
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  'c:/windows/win.ini', // drive letters are case-insensitive
  'D:/prompts/svc_03/invoice_agent.md', // the right directory name, on the wrong drive
  'D:\\prompts\\svc_03\\invoice_agent.md',
];

/** UNC paths and paths rooted with a backslash but no drive letter. */
const UNC_OR_BACKSLASH_ROOTED = [
  '\\\\server\\share\\x.md', // UNC
  '//server/share/x.md', // UNC written with forward slashes
  '\\\\server\\share', // a UNC root with no file part
  '\\Windows\\win.ini', // rooted on the current drive
  '\\prompts\\svc_03\\invoice_agent.md', // rooted, and names the right directory
];

/** One of each hostile class, used wherever a test wants a representative sample. */
const HOSTILE_SAMPLE = [
  DRIVE_ROOTED[0],
  DRIVE_ROOTED[1],
  UNC_OR_BACKSLASH_ROOTED[0],
  UNC_OR_BACKSLASH_ROOTED[3],
  '/etc/passwd',
  OUTSIDE_FILE,
  '../outside.md',
  '../prompts-evil/secret.md',
];

// ── helpers ─────────────────────────────────────────────────────────────────

/** A renderer over the fixture directory whose reader records every path it is asked for, then really reads it. */
function instrumented() {
  const calls = [];
  const renderer = createPromptRenderer({
    promptsDir,
    readFile: (absolute) => {
      calls.push(absolute);
      return fs.readFileSync(absolute, 'utf8');
    },
  });
  return { renderer, calls };
}

const label = (input) => (typeof input === 'string' ? JSON.stringify(input) : `<${typeof input}> ${Object.prototype.toString.call(input)}`);

/** `call(renderer)` must throw a PromptRenderError with `code`, and the file reader must not have run at all. */
function assertRefused(input, code, { via = 'load', call = (renderer) => renderer.load(input) } = {}) {
  const { renderer, calls } = instrumented();
  assert.throws(
    () => call(renderer),
    (error) => {
      assert.ok(error instanceof PromptRenderError, `${via}(${label(input)}): expected a PromptRenderError, got ${error?.name}: ${error?.message}`);
      assert.equal(error.code, code, `${via}(${label(input)}) gave ${error.code}, expected ${code}`);
      return true;
    },
    `${via}(${label(input)}) must throw`,
  );
  assert.deepEqual(calls, [], `${via}(${label(input)}): the file reader must not run for a refused path`);
}

// ── the tests ───────────────────────────────────────────────────────────────

test('a Windows drive-rooted path is an escape on every host, with forward slashes or backslashes', () => {
  for (const input of DRIVE_ROOTED) assertRefused(input, PATH_ESCAPE);
});

test('a UNC path or a backslash-rooted path is an escape on every host', () => {
  for (const input of UNC_OR_BACKSLASH_ROOTED) assertRefused(input, PATH_ESCAPE);
});

test('a POSIX absolute path outside the prompts directory is an escape, even when the target file exists', () => {
  const outside = [
    '/etc/passwd',
    path.join(path.parse(tmpRoot).root, 'etc', 'hosts'), // an absolute path in the host's own flavour
    OUTSIDE_FILE, // absolute, and the file is really there
    promptsDir + path.sep + '..' + path.sep + 'outside.md', // absolute and not pre-normalised: it still names OUTSIDE_FILE
    tmpRoot, // the parent directory itself
  ];
  for (const input of outside) assertRefused(input, PATH_ESCAPE);
});

test('relative traversal out of the prompts directory is an escape, even when the target file exists', () => {
  const traversals = [
    '..',
    '../outside.md', // names OUTSIDE_FILE
    './../outside.md',
    '../../outside.md',
    'svc_03/../../outside.md', // starts inside, climbs out, and lands on OUTSIDE_FILE
    'svc_03/../..',
  ];
  for (const input of traversals) assertRefused(input, PATH_ESCAPE);
});

test("a sibling directory whose name merely starts with the prompts directory's name is an escape", () => {
  // Fixture check: a string-prefix test would wrongly accept this file, so the cases below can tell the two apart.
  assert.ok(SIBLING_FILE.startsWith(promptsDir), 'the sibling file shares the prompts directory as a string prefix');
  assert.equal(fs.readFileSync(SIBLING_FILE, 'utf8'), 'SIBLING-SECRET\n', 'and it is really there');

  for (const input of ['../prompts-evil/secret.md', SIBLING_FILE]) assertRefused(input, PATH_ESCAPE);
});

test('a path that stays inside the prompts directory still loads, relative or absolute', () => {
  const inside = [
    PROMPT_REL,
    `./${PROMPT_REL}`,
    'svc_03/../svc_03/invoice_agent.md',
    `../${path.basename(promptsDir)}/${PROMPT_REL}`, // leaves the directory and re-enters it: it resolves inside
    PROMPT_ABS, // an absolute path that points inside is allowed, as before
  ];
  for (const input of inside) {
    const { renderer, calls } = instrumented();
    assert.equal(renderer.load(input), PROMPT_TEXT, `${label(input)} is served from the prompts directory`);
    assert.deepEqual(calls, [PROMPT_ABS], `${label(input)} is read once, from the one resolved place`);
  }

  // The production path: an agent's prompt of record is a constant relative path, and it still renders.
  const { renderer } = instrumented();
  assert.ok(renderer.renderAgentPrompt('svc_03', { invoice_data: 'Invoice #1' }).text.includes('Invoice #1'));
});

test('invalid input types and empty paths are refused before any file access', () => {
  const invalid = ['', '   ', '\t\n', null, undefined, 42, true, {}, [], [PROMPT_REL], () => PROMPT_REL, Symbol('path')];
  for (const input of invalid) assertRefused(input, NOT_FOUND);
});

test('every public entry point that takes a template path gives the same verdict', () => {
  const entryPoints = [
    ['load', (renderer, p) => renderer.load(p), (out) => assert.equal(out, PROMPT_TEXT)],
    ['render', (renderer, p) => renderer.render(p, { invoice_data: 'x' }), (out) => assert.equal(out, RENDERED_X)],
    [
      'renderDetailed',
      (renderer, p) => renderer.renderDetailed(p, { invoice_data: 'x' }),
      (out) => {
        assert.equal(out.text, RENDERED_X);
        assert.equal(out.relativePath, 'svc_03/invoice_agent.md');
      },
    ],
    ['placeholdersOf', (renderer, p) => renderer.placeholdersOf(p), (out) => assert.deepEqual(out, ['invoice_data'])],
  ];

  for (const [via, invoke, expectServed] of entryPoints) {
    for (const input of HOSTILE_SAMPLE) assertRefused(input, PATH_ESCAPE, { via, call: (renderer) => invoke(renderer, input) });

    const { renderer, calls } = instrumented();
    expectServed(invoke(renderer, PROMPT_REL));
    assert.deepEqual(calls, [PROMPT_ABS], `${via}: a legitimate path is read once`);
  }
});

test("the runtime's renderPrompt() facade applies the same boundary", () => {
  // The facade builds its own renderer, so there is no spy here: refusal is asserted by the error code alone.
  const storageDir = track(tempStorageDir('prompts-containment-rt-'));
  const runtime = createRuntime({
    config: testConfig({ storageDir }),
    storageDir,
    fixturesDir: FIXTURES_DIR,
    now: fixedClock(),
    echoEvents: false,
    promptsDir,
  });

  assert.equal(runtime.renderPrompt(PROMPT_REL, { invoice_data: 'x' }), RENDERED_X, 'a legitimate path is served');
  for (const input of HOSTILE_SAMPLE) {
    assert.throws(
      () => runtime.renderPrompt(input, { invoice_data: 'x' }),
      (error) => {
        assert.ok(error instanceof PromptRenderError, `renderPrompt(${label(input)}): expected a PromptRenderError, got ${error?.name}`);
        assert.equal(error.code, PATH_ESCAPE, `renderPrompt(${label(input)}) gave ${error.code}, expected ${PATH_ESCAPE}`);
        return true;
      },
      `renderPrompt(${label(input)}) must throw`,
    );
  }
});

test('the file reader runs for allowed paths only, once each, and never for a refused path', () => {
  const { renderer, calls } = instrumented();
  // [input, the one place the reader may be asked for it, or null when it must be refused]
  const sequence = [
    [DRIVE_ROOTED[0], null],
    [PROMPT_REL, PROMPT_ABS],
    [UNC_OR_BACKSLASH_ROOTED[0], null],
    ['../outside.md', null],
    [PROMPT_ABS, PROMPT_ABS],
    [OUTSIDE_FILE, null],
    ['', null],
    [`./${PROMPT_REL}`, PROMPT_ABS],
    ['../prompts-evil/secret.md', null],
    [null, null],
    [UNC_OR_BACKSLASH_ROOTED[3], null],
  ];

  for (const [input, expectedRead] of sequence) {
    const before = calls.length;
    if (expectedRead) {
      assert.equal(renderer.load(input), PROMPT_TEXT, `${label(input)} is allowed`);
      assert.equal(calls.length, before + 1, `${label(input)}: exactly one read`);
    } else {
      assert.throws(
        () => renderer.load(input),
        (error) => error instanceof PromptRenderError,
        `${label(input)} must be refused with a PromptRenderError`,
      );
      assert.equal(calls.length, before, `${label(input)}: the file reader must not run for a refused path`);
    }
  }

  assert.deepEqual(
    calls,
    sequence.filter(([, read]) => read).map(([, read]) => read),
    'the reader was asked for the allowed paths, in order, and for nothing else',
  );
});
