/**
 * The runtime API layer, as a library.
 *
 *   import { createRuntime } from '../src/index.mjs';
 *   import { createRuntimeApi } from '../src/api/index.mjs';
 *
 *   const runtime = createRuntime({ storageDir: './data/state' });
 *   const api = createRuntimeApi({ runtime });
 *   const response = await api.handle({ method: 'GET', pathname: '/api/runtime/health' });
 *   // -> null (not a runtime route) | { status, headers, body: '<json>' }
 *
 * `server.mjs` mounts this behind `/api/runtime` and keeps every existing route
 * and static file byte-for-byte unchanged.
 */

export {
  createRuntimeApi,
  RUNTIME_API_PREFIX,
  API_VERSION,
  MAX_BODY_BYTES,
  ROUTES,
  matchSegments,
  splitPath,
  newRequestId,
} from './router.mjs';

export { ApiError, API_ERROR_CODES, API_STATUS_BY_CODE, apiError, asApiError, statusForCode } from './errors.mjs';

export {
  buildOfflinePlan,
  validateScriptAgainstSchemas,
  escalationArguments,
  readDatasetCases,
  SCRIPT_SOURCE,
  DATA_VAR,
} from './offline.mjs';

export {
  serializeAgent,
  serializeAgents,
  serializeTools,
  serializePolicies,
  serializeRunSummary,
  serializeApproval,
  serializeTrace,
  boundarySummary,
  isTerminalRunStatus,
  stateTimelineFrom,
  policyDecisionsFrom,
  toolCallsFrom,
  pendingApprovalIdFrom,
  escalationToolFor,
} from './serialize.mjs';

export { createAgentsHandler } from './handlers/agents.mjs';
export { createRunsHandler, MAX_INPUT_CHARS, DEFAULT_RUN_LIMIT, MAX_RUN_LIMIT } from './handlers/runs.mjs';
export { createApprovalsHandler, APPROVAL_FILTERS } from './handlers/approvals.mjs';
export { createToolsHandler } from './handlers/tools.mjs';
export { createPoliciesHandler } from './handlers/policies.mjs';
export { createEvaluationsHandler, defaultReportPath } from './handlers/evaluations.mjs';
export { createHealthHandler } from './handlers/health.mjs';
