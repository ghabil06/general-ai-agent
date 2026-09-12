#!/usr/bin/env node
/**
 * Shadow-week replay: post historical invoices through the SVC_03 webhook.
 *
 * One invoice per request, sequentially, so the agent, the guardrail and the
 * audit log see shadow traffic exactly the way live traffic will arrive.
 * Needs Node 18+ (global fetch) and nothing else.
 *
 *   node n8n_exports/replay_history.mjs \
 *     --url https://n8n.example.com/webhook/svc_03-invoice \
 *     --file last_month.jsonl
 *
 * The URL can also come from SVC_03_WEBHOOK_URL. Input is JSONL: one invoice
 * object per line, blank lines and # comments allowed. Row shape is the
 * webhook contract from n8n_exports/README.md — invoice_text is required;
 * amount is strongly recommended (without it the guardrail falls back to the
 * first $ figure in the text and the audit row records amount_source =
 * 'regex_from_text').
 *
 * --dry-run validates the file and prints what would be posted, no network.
 * Exit code 0 = every row posted (or validated, in --dry-run), 1 = anything
 * failed. Warnings (missing invoice_ref, unexpected keys) do not fail the run
 * but are printed so they can be fixed before the real replay.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const KNOWN_KEYS = new Set(['invoice_text', 'invoice_ref', 'vendor', 'amount']);
const REQUEST_TIMEOUT_MS = 30_000;

function usage(exitCode) {
  console.log(`Usage:
  node n8n_exports/replay_history.mjs --url <webhook-url> --file <invoices.jsonl> [--delay <ms>]
  node n8n_exports/replay_history.mjs --dry-run --file <invoices.jsonl>

Options:
  --url      Production webhook URL of the imported SVC_03 workflow.
             Falls back to the SVC_03_WEBHOOK_URL environment variable.
             Not needed with --dry-run.
  --file     JSONL file of historical invoices (see replay_sample.jsonl).
  --dry-run  Validate only; post nothing.
  --delay    Pause between posts in ms (default 250). Be polite to the
             webhook: n8n queues executions, it does not need a burst.
  --help     Show this message.`);
  process.exit(exitCode);
}

let args;
try {
  args = parseArgs({
    options: {
      url: { type: 'string' },
      file: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      delay: { type: 'string', default: '250' },
      help: { type: 'boolean', default: false },
    },
  });
} catch (err) {
  console.error(`FAIL ${err.message}`);
  usage(1);
}

if (args.values.help) usage(0);

const url = args.values.url || process.env.SVC_03_WEBHOOK_URL || '';
const file = args.values.file || '';
const dryRun = args.values['dry-run'];
const delay = Number(args.values.delay);

if (!file) {
  console.error('FAIL --file is required (JSONL of historical invoices)');
  usage(1);
}
if (!dryRun && !url) {
  console.error('FAIL --url (or the SVC_03_WEBHOOK_URL env var) is required unless --dry-run is used');
  usage(1);
}
if (!Number.isFinite(delay) || delay < 0) {
  console.error('FAIL --delay must be a non-negative number of milliseconds');
  process.exit(1);
}

// --- load and validate --------------------------------------------------------

let lines;
try {
  lines = readFileSync(file, 'utf8').split(/\r?\n/);
} catch (err) {
  console.error(`FAIL cannot read ${file}: ${err.message}`);
  process.exit(1);
}

const rows = [];
let hardFailures = 0;

lines.forEach((line, idx) => {
  const lineNumber = idx + 1;
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;

  let row;
  try {
    row = JSON.parse(trimmed);
  } catch (err) {
    console.error(`FAIL line ${lineNumber}: not valid JSON — ${err.message}`);
    hardFailures++;
    return;
  }
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    console.error(`FAIL line ${lineNumber}: each line must be a JSON object`);
    hardFailures++;
    return;
  }
  if (typeof row.invoice_text !== 'string' || !row.invoice_text.trim()) {
    console.error(`FAIL line ${lineNumber}: invoice_text is required (the prompt is built from it)`);
    hardFailures++;
    return;
  }
  if ('amount' in row && (typeof row.amount !== 'number' || !Number.isFinite(row.amount))) {
    console.error(`FAIL line ${lineNumber}: amount must be a number — send it as a JSON number (450.00, not "450.00"), or omit it`);
    hardFailures++;
    return;
  }
  if (!('amount' in row)) {
    console.log(`WARN  line ${lineNumber}: no structured amount — the guardrail will fall back to the first $ figure in the text and the audit row will record amount_source = 'regex_from_text'`);
  }
  if (!row.invoice_ref) {
    console.log(`WARN  line ${lineNumber}: no invoice_ref — the parity review matches audit rows to the team's records by invoice_ref`);
  }
  for (const key of Object.keys(row)) {
    if (!KNOWN_KEYS.has(key)) console.log(`WARN  line ${lineNumber}: unknown key "${key}" — the webhook contract is invoice_text, invoice_ref, vendor, amount`);
  }

  rows.push({ lineNumber, payload: row });
});

if (hardFailures) {
  console.error(`\n${hardFailures} invalid row(s) — nothing was posted. Fix the file and rerun.`);
  process.exit(1);
}
if (!rows.length) {
  console.error('FAIL no invoice rows found in the file (only blank lines or # comments)');
  process.exit(1);
}

// --- dry run: stop here --------------------------------------------------------

if (dryRun) {
  for (const { lineNumber, payload } of rows) {
    console.log(`would POST line ${lineNumber}  ${payload.invoice_ref || '(no invoice_ref)'}  amount: ${'amount' in payload ? payload.amount : '(regex fallback)'}`);
  }
  console.log(`\nOK dry-run: ${rows.length} row(s) validated, nothing posted.`);
  process.exit(0);
}

// --- replay --------------------------------------------------------------------

console.log(`Replaying ${rows.length} invoice(s) to ${url} (${delay}ms pause between posts)\n`);

let posted = 0;
let failed = 0;

for (const [i, { lineNumber, payload }] of rows.entries()) {
  const ref = payload.invoice_ref || '(no invoice_ref)';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      posted++;
      console.log(`  ok   line ${lineNumber}  ${ref}  (${res.status})`);
    } else {
      failed++;
      const body = await res.text().catch(() => '');
      console.error(`FAIL   line ${lineNumber}  ${ref}  HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }
  } catch (err) {
    failed++;
    console.error(`FAIL   line ${lineNumber}  ${ref}  ${err.name === 'TimeoutError' ? `no response within ${REQUEST_TIMEOUT_MS}ms` : err.message}`);
  }
  if (i < rows.length - 1) await new Promise((r) => setTimeout(r, delay));
}

console.log(`\n${posted} posted, ${failed} failed, of ${rows.length} row(s).`);
if (failed) {
  console.error('Some invoices did not make it through — rerun just those rows.');
  process.exit(1);
}
console.log('Every decision is now in agents.audit_log. Score it with the parity queries in n8n_exports/README.md.');
