/**
 * The runtime HTTP API — a router, not a framework.
 *
 * ┌─ why hand-rolled ──────────────────────────────────────────────────────────┐
 * │ `server.mjs` is a plain `node:http` server and stays one. This module adds │
 * │ a table of routes, a request id, one error shape and one response writer;  │
 * │ it adds no dependency, no middleware chain and no static-file behaviour.   │
 * │ It is a LIBRARY: `handle()` is a pure function from a parsed request to a  │
 * │ serialised response, so `tests/integration/api.test.mjs` can drive it      │
 * │ through a real socket and `verify:runtime` can drive it in-process.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Contract:
 *
 *   handle({ method, pathname, searchParams, rawBody, tooLarge, requestId })
 *     -> null                                     (not a runtime route: the
 *                                                  caller keeps its own routing,
 *                                                  so `server.mjs`'s static and
 *                                                  legacy behaviour is untouched)
 *     -> { status, headers, body }                (already serialised JSON)
 *
 * Properties, all of them enforced here rather than by each handler:
 *
 *   - **Every response is redacted.** The body passes through
 *     `src/observability/redact.mjs` on the way out, so no endpoint can leak a
 *     credential even by accident, whatever a handler puts in a field.
 *   - **Every error is `{ error: { code, message, details } }`.** A handler
 *     throws an `ApiError`; anything else is mapped by `asApiError()`. The
 *     process never dies because a request was malformed.
 *   - **Unknown runtime route is a 404 JSON, never a static file.** A path under
 *     the prefix that matches nothing returns a structured 404, so a mistyped
 *     API path cannot receive `index.html` with a 200.
 *   - **A wrong method is a 405 with `Allow`.** A path that exists with a
 *     different verb is not a 404.
 *   - **A request id is echoed.** Generated here, returned in `X-Request-Id` and
 *     in every body as `requestId`, so an operator can correlate a console
 *     action with a server log line.
 *   - **The body is bounded.** `MAX_BODY_BYTES`; over it is a 413. The caller
 *     enforces the read limit (it owns the socket) and reports `tooLarge`.
 */

import { redact } from '../observability/redact.mjs';
import { API_ERROR_CODES, ApiError, apiError, asApiError } from './errors.mjs';
import { createAgentsHandler } from './handlers/agents.mjs';
import { createRunsHandler } from './handlers/runs.mjs';
import { createApprovalsHandler } from './handlers/approvals.mjs';
import { createToolsHandler } from './handlers/tools.mjs';
import { createPoliciesHandler } from './handlers/policies.mjs';
import { createEvaluationsHandler } from './handlers/evaluations.mjs';
import { createHealthHandler } from './handlers/health.mjs';

/** Every runtime route lives under this prefix. */
export const RUNTIME_API_PREFIX = '/api/runtime';

/** API contract version. Distinct from RUNTIME_VERSION, which is the core's. */
export const API_VERSION = '1.0.0';

/** Largest accepted request body in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * The route table. `segments` are matched against the path after the prefix;
 * a `:name` segment captures a parameter. Order matters only in that the first
 * match wins, and no two patterns overlap.
 */
export const ROUTES = Object.freeze([
  { method: 'GET', segments: ['health'], call: (handlers, context) => handlers.health.get(context) },
  { method: 'GET', segments: ['agents'], call: (handlers, context) => handlers.agents.list(context) },
  { method: 'POST', segments: ['agents', ':id', 'runs'], call: (handlers, context) => handlers.runs.start(context) },
  { method: 'GET', segments: ['runs'], call: (handlers, context) => handlers.runs.list(context) },
  { method: 'GET', segments: ['runs', ':id'], call: (handlers, context) => handlers.runs.detail(context) },
  { method: 'GET', segments: ['runs', ':id', 'events'], call: (handlers, context) => handlers.runs.events(context) },
  { method: 'POST', segments: ['runs', ':id', 'cancel'], call: (handlers, context) => handlers.runs.cancel(context) },
  { method: 'GET', segments: ['approvals'], call: (handlers, context) => handlers.approvals.list(context) },
  { method: 'POST', segments: ['approvals', ':id', 'approve'], call: (handlers, context) => handlers.approvals.approve(context) },
  { method: 'POST', segments: ['approvals', ':id', 'reject'], call: (handlers, context) => handlers.approvals.reject(context) },
  { method: 'GET', segments: ['tools'], call: (handlers, context) => handlers.tools.list(context) },
  { method: 'GET', segments: ['policies'], call: (handlers, context) => handlers.policies.list(context) },
  { method: 'GET', segments: ['evaluations'], call: (handlers, context) => handlers.evaluations.latest(context) },
]);

/** `['runs', ':id', 'events']` + `['runs','run_1','events']` -> `{id:'run_1'}` */
export function matchSegments(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i];
    if (expected.startsWith(':')) {
      if (!segments[i]) return null;
      params[expected.slice(1)] = decodeURIComponent(segments[i]);
      continue;
    }
    if (expected !== segments[i]) return null;
  }
  return params;
}

/** Split a pathname into decoded segments, ignoring a trailing slash. */
export function splitPath(pathname) {
  return String(pathname ?? '')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** A short, opaque request id. No clock, no counter to collide on restart. */
export function newRequestId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `req_${Date.now().toString(36)}${random}`;
}

/**
 * @param {object} options
 * @param {object} options.runtime      from createRuntime()
 * @param {object} [options.now]        clock injection
 * @param {string} [options.reportPath] where `eval:runtime` wrote its report
 * @param {string} [options.apiVersion]
 */
export function createRuntimeApi({ runtime, now = () => Date.now(), reportPath = null, apiVersion = API_VERSION } = {}) {
  if (!runtime?.runStore || !runtime?.createRun) {
    throw new TypeError('createRuntimeApi: a runtime from createRuntime() is required');
  }

  const handlers = {
    agents: createAgentsHandler({ runtime, now }),
    runs: createRunsHandler({ runtime, now }),
    approvals: createApprovalsHandler({ runtime, now }),
    tools: createToolsHandler({ runtime, now }),
    policies: createPoliciesHandler({ runtime, now }),
    evaluations: createEvaluationsHandler({ runtime, now, reportPath }),
    health: createHealthHandler({ runtime, now, apiVersion }),
  };

  /** The response envelope: JSON, redacted, with the request id echoed. */
  function respond(status, body, requestId, extraHeaders = {}) {
    const payload = body === null || body === undefined ? {} : body;
    const redacted = redact({ ...payload, requestId });
    return {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Request-Id': requestId,
        ...extraHeaders,
      },
      body: `${JSON.stringify(redacted, null, 2)}\n`,
    };
  }

  function errorResponse(error, requestId, extraHeaders = {}) {
    const apiFailure = asApiError(error);
    return respond(apiFailure.status, apiFailure.toJSON(), requestId, extraHeaders);
  }

  /** Parse the body for a method that carries one. */
  function parseBody(rawBody) {
    if (rawBody === undefined || rawBody === null || rawBody === '') return {};
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch (error) {
      throw apiError(API_ERROR_CODES.INVALID_JSON, `the request body is not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        `the request body must be a JSON object, got ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed}`,
      );
    }
    return parsed;
  }

  /**
   * @param {object} request
   * @param {string} request.method
   * @param {string} request.pathname
   * @param {URLSearchParams|object} [request.searchParams]
   * @param {string} [request.rawBody]
   * @param {boolean} [request.tooLarge]
   * @param {string} [request.requestId]
   * @returns {Promise<null|{status: number, headers: object, body: string}>}
   */
  async function handle(request = {}) {
    const method = String(request.method ?? 'GET').toUpperCase();
    /**
     * Accept a bare pathname (how `server.mjs` calls this, with the query split
     * out) AND a raw `req.url` with the query still attached, because
     * `api.handle({ pathname: req.url })` is a plausible thing for a caller to
     * write and silently routing `/runs?limit=5` to UNKNOWN_ROUTE is not.
     */
    const rawPath = String(request.pathname ?? '/');
    const queryIndex = rawPath.indexOf('?');
    const pathname = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
    const inlineQuery = queryIndex === -1 ? '' : rawPath.slice(queryIndex + 1);
    if (pathname !== RUNTIME_API_PREFIX && !pathname.startsWith(`${RUNTIME_API_PREFIX}/`)) return null;

    const requestId = request.requestId ?? newRequestId();
    const segments = splitPath(pathname.slice(RUNTIME_API_PREFIX.length));
    const searchParams =
      request.searchParams instanceof URLSearchParams
        ? request.searchParams
        : new URLSearchParams(request.searchParams ?? {});
    if (inlineQuery) {
      for (const [key, value] of new URLSearchParams(inlineQuery).entries()) {
        if (!searchParams.has(key)) searchParams.append(key, value);
      }
    }
    const query = Object.fromEntries(searchParams.entries());

    if (request.tooLarge === true) {
      return errorResponse(
        apiError(API_ERROR_CODES.BODY_TOO_LARGE, `the request body exceeds the ${MAX_BODY_BYTES} byte limit`, {
          limitBytes: MAX_BODY_BYTES,
        }),
        requestId,
      );
    }

    const matches = [];
    for (const route of ROUTES) {
      const params = matchSegments(route.segments, segments);
      if (params) matches.push({ route, params });
    }
    if (!matches.length) {
      return errorResponse(
        apiError(API_ERROR_CODES.UNKNOWN_ROUTE, `no runtime route matches ${method} ${pathname}`, {
          prefix: RUNTIME_API_PREFIX,
          knownRoutes: ROUTES.map((route) => `${route.method} ${RUNTIME_API_PREFIX}/${route.segments.join('/')}`),
        }),
        requestId,
      );
    }

    const selected = matches.find((candidate) => candidate.route.method === method);
    if (!selected) {
      const allowed = [...new Set(matches.map((candidate) => candidate.route.method))].sort();
      return errorResponse(
        apiError(API_ERROR_CODES.METHOD_NOT_ALLOWED, `${method} is not allowed on ${pathname}`, { allowed }),
        requestId,
        { Allow: allowed.join(', ') },
      );
    }

    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : parseBody(request.rawBody);
      const result = await selected.route.call(handlers, {
        runtime,
        params: selected.params,
        query,
        body,
        requestId,
        now,
      });
      if (!result || typeof result !== 'object' || typeof result.status !== 'number') {
        throw new ApiError(API_ERROR_CODES.INTERNAL, 'the handler returned no response');
      }
      return respond(result.status, result.body, requestId);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }

  return {
    prefix: RUNTIME_API_PREFIX,
    apiVersion,
    handlers,
    routes: ROUTES.map((route) => `${route.method} ${RUNTIME_API_PREFIX}/${route.segments.join('/')}`),
    /** Route inventory, used by the health payload and the verification report. */
    describe: () => ({
      prefix: RUNTIME_API_PREFIX,
      apiVersion,
      maxBodyBytes: MAX_BODY_BYTES,
      routes: ROUTES.map((route) => ({ method: route.method, path: `${RUNTIME_API_PREFIX}/${route.segments.join('/')}` })),
    }),
    handle,
  };
}

export default createRuntimeApi;
