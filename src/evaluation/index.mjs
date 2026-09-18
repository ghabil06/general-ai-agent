/**
 * Evaluation harness — public entry point.
 *
 *   import { evaluateAgent, runSuite, FIXTURE_KIND } from './src/evaluation/index.mjs';
 *
 *   const oracle = await runSuite({ agentId: 'svc_03', fixture: FIXTURE_KIND.ORACLE });
 *   const report = await evaluateAgent({ agentId: 'svc_03' });   // + suites + deterministic sub-suites
 *
 * `scripts/eval-runtime.mjs` is the CLI over this module and is what
 * `npm run eval:runtime` executes.
 */

export {
  runSuite,
  runCase,
  runAgentBothFixtures,
  createEvaluationRuntime,
  loadDatasetFile,
  scenarioDataset,
  scenarioScript,
  isInjectionCase,
  FIXTURE_AGENTS,
  ESCALATION_TOOL,
  FIXTURE_KIND,
  DOCUMENTED,
  LATENCY_BOUND_MS,
  TOKEN_BOUND,
} from './runner.mjs';

export {
  evaluateAgent,
  buildSuites,
  runDeterministicSubSuites,
  SUITE_DEFINITIONS,
} from './suites.mjs';

export {
  oracleDecision,
  naiveDecision,
  naiveAutopilotDecision,
  naiveAnalystDecision,
  naiveTraderDecision,
  deriveToolCalls,
  plannedSteps,
  nonTerminatingPlan,
  oracleScript,
  naiveScript,
  scriptFor,
  renderCasePrompt,
  dataSection,
} from './mock-scripts.mjs';

export {
  assertActionMatches,
  assertToolSelection,
  assertExpectedTools,
  assertToolArguments,
  assertNoArgumentRejections,
  assertPolicyConsistent,
  assertUnsafeProposalDenied,
  assertInjectionDetected,
  assertGroundedInEvidence,
  assertCompleted,
  assertPlanExecuted,
  assertMemoryRetrieval,
  assertContextQuality,
  assertLatency,
  assertCost,
  assertRegression,
  allPassed,
  extractDecision,
  balancedBlocks,
  VALID_ACTIONS,
  AUTONOMOUS_ACTION,
  ESCALATION_ACTION,
  EXPECTED_VERDICT,
} from './assertions.mjs';

export { tempStorageDir, fixedClock } from './storage.mjs';
