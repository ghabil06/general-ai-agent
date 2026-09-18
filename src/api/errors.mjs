/**
 * API error contract.
 *
 * Real implementation. Every failure the runtime API can produce is one of the
 * codes below, and every one of them is serialised as
 *
 *   { "error": { "code": "...", "message": "...", "details": { ... } } }
 *
 * with an HTTP status chosen by the code — never by the call site. That is the
 * property worth having: a handler cannot invent a status, and a client cannot
 * receive a code whose status it does not know.
 *
 * ┌─ the mapping is total ────────────────────────────────────────────────────┐
 * │ INVALID_REQUEST / INVALID_JSON / UNKNOWN_PROVIDER      400                │
 * │ UNKNOWN_AGENT / UNKNOWN_RUN / UNKNOWN_APPROVAL /       404                │
 * │ UNKNOWN_ROUTE                                                             │
 * │ METHOD_NOT_ALLOWED                                     405                │
 * │ BODY_TOO_LARGE                                         413                │
 * │ RUN_NOT_CANCELLABLE / APPROVAL_NOT_PENDING /           409                │
 * │ APPROVAL_MISMATCH / RUN_BUSY                                              │
 * │ PROVIDER_NOT_CONFIGURED / RUNTIME_UNAVAILABLE          503                │
 * │ INTERNAL                                               500                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `message` is safe to show a client: it never contains a credential (the
 * router redacts every response body anyway) and it never contains a raw stack.
 */

/** Canonical error codes. Stable strings — they are part of the API contract. */
export const API_ERROR_CODES = Object.freeze({
  /** the request body, query or parameter is not what the endpoint requires */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** the body is not valid JSON */
  INVALID_JSON: 'INVALID_JSON',
  /** the body exceeds the documented size limit */
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  /** no agent profile with that id */
  UNKNOWN_AGENT: 'UNKNOWN_AGENT',
  /** no run with that id has been persisted */
  UNKNOWN_RUN: 'UNKNOWN_RUN',
  /** no approval with that id */
  UNKNOWN_APPROVAL: 'UNKNOWN_APPROVAL',
  /** the path is under the runtime prefix but matches no route */
  UNKNOWN_ROUTE: 'UNKNOWN_ROUTE',
  /** the path matched a route, the method did not */
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  /** the run is already in a terminal state */
  RUN_NOT_CANCELLABLE: 'RUN_NOT_CANCELLABLE',
  /** the approval is not pending (already approved/rejected/expired/cancelled) */
  APPROVAL_NOT_PENDING: 'APPROVAL_NOT_PENDING',
  /** the approval describes a different tool or different arguments */
  APPROVAL_MISMATCH: 'APPROVAL_MISMATCH',
  /** the provider id is not one the runtime knows */
  UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
  /** the provider is known but has no credential/base URL configured */
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  /** the runtime could not be constructed, so the endpoint cannot serve */
  RUNTIME_UNAVAILABLE: 'RUNTIME_UNAVAILABLE',
  /** an unexpected failure; the message is the error's own, never a stack */
  INTERNAL: 'INTERNAL',
});

/** Code -> HTTP status. The only place a status is decided. */
export const API_STATUS_BY_CODE = Object.freeze({
  [API_ERROR_CODES.INVALID_REQUEST]: 400,
  [API_ERROR_CODES.INVALID_JSON]: 400,
  [API_ERROR_CODES.BODY_TOO_LARGE]: 413,
  [API_ERROR_CODES.UNKNOWN_AGENT]: 404,
  [API_ERROR_CODES.UNKNOWN_RUN]: 404,
  [API_ERROR_CODES.UNKNOWN_APPROVAL]: 404,
  [API_ERROR_CODES.UNKNOWN_ROUTE]: 404,
  [API_ERROR_CODES.METHOD_NOT_ALLOWED]: 405,
  [API_ERROR_CODES.RUN_NOT_CANCELLABLE]: 409,
  [API_ERROR_CODES.APPROVAL_NOT_PENDING]: 409,
  [API_ERROR_CODES.APPROVAL_MISMATCH]: 409,
  [API_ERROR_CODES.UNKNOWN_PROVIDER]: 400,
  [API_ERROR_CODES.PROVIDER_NOT_CONFIGURED]: 503,
  [API_ERROR_CODES.RUNTIME_UNAVAILABLE]: 503,
  [API_ERROR_CODES.INTERNAL]: 500,
});

/** @returns {number} the HTTP status for an error code, 500 when unknown. */
export function statusForCode(code) {
  return API_STATUS_BY_CODE[code] ?? 500;
}

/** @extends Error */
export class ApiError extends Error {
  /**
   * @param {string} code    one of API_ERROR_CODES
   * @param {string} message human-readable, safe for a client
   * @param {object} [details] structured context (never a secret)
   */
  constructor(code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = statusForCode(code);
    this.details = details;
  }

  /** @returns {{error: {code: string, message: string, details: object|null}}} */
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

/** Shorthand: `throw apiError('UNKNOWN_RUN', 'no run "run_1"')`. */
export function apiError(code, message, details = null) {
  return new ApiError(code, message, details);
}

/**
 * Map anything thrown inside a handler onto an ApiError.
 *
 * An ApiError passes through unchanged. A `TypeError` from a validation helper
 * is a 400 (it is the caller's shape that was wrong). Everything else is a 500
 * whose message is the error's own — the router never leaks a stack, and the
 * process never dies because one request was malformed.
 */
export function asApiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof TypeError || error instanceof RangeError) {
    return new ApiError(API_ERROR_CODES.INVALID_REQUEST, error.message);
  }
  return new ApiError(API_ERROR_CODES.INTERNAL, error?.message ?? String(error), {
    name: error?.name ?? 'Error',
  });
}

export default ApiError;
