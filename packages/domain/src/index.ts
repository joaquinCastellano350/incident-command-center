import type {
  MonitoringAlertInput,
  DeploymentEventInput,
  OperationalJudgments,
  PolicyRuleResult,
  WorkflowActionType,
} from '@incident-command-center/contracts';

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export interface MonitoringProviderPort<TPayload = unknown> {
  receive(payload: TPayload): Promise<void>;
}

export interface PagingProviderPort<TPage = unknown> {
  page(page: TPage): Promise<{ providerReference: string }>;
}

export interface OperationalJudgmentResult<TJudgments> {
  judgments: TJudgments;
  incidentMatches: Array<{
    candidateIncidentId: string;
    judgment: {
      choice: 'same_incident' | 'related_distinct' | 'unrelated';
      probabilities: Array<{
        outcome: 'same_incident' | 'related_distinct' | 'unrelated';
        probability: number;
      }>;
    };
  }>;
  mode: 'live' | 'recorded' | 'deterministic';
  configuredModel: string;
  resolvedModel: string;
  providerRequestId: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retryCount: number;
}

export interface OperationalJudgmentProviderPort<TSignal, TJudgments> {
  evaluate(signal: TSignal): Promise<OperationalJudgmentResult<TJudgments>>;
}

function distribution<const TChoices extends readonly string[]>(
  choice: TChoices[number],
  alternatives: TChoices,
  confidence: number,
) {
  const remainder = (1 - confidence) / (alternatives.length - 1);
  return {
    choice,
    probabilities: Array.from(alternatives, (outcome) => ({
      outcome: outcome as TChoices[number],
      probability: outcome === choice ? confidence : remainder,
    })),
  };
}

export const NORTHSTAR_SERVICE_DOMAINS = {
  'checkout-api': 'payments',
  'payment-processor': 'payments',
  'identity-api': 'authentication',
  'session-service': 'authentication',
  'order-service': 'fulfillment',
  'fulfillment-worker': 'fulfillment',
  'api-gateway': 'platform',
  'event-router': 'platform',
} as const;

export function evaluateMonitoringAlertDeterministically(
  signal: MonitoringAlertInput,
): OperationalJudgments {
  const canonicalPaymentFailure =
    signal.metric === 'payment_authorization_failure_rate' &&
    signal.service === 'checkout-api' &&
    signal.observedValue >= 10;
  const owner:
    | (typeof NORTHSTAR_SERVICE_DOMAINS)[keyof typeof NORTHSTAR_SERVICE_DOMAINS]
    | 'unknown' = Object.hasOwn(NORTHSTAR_SERVICE_DOMAINS, signal.service)
    ? NORTHSTAR_SERVICE_DOMAINS[
        signal.service as keyof typeof NORTHSTAR_SERVICE_DOMAINS
      ]
    : 'unknown';

  return {
    priorityAssessment: distribution(
      canonicalPaymentFailure ? 'P1' : 'P2',
      ['P0', 'P1', 'P2', 'P3'],
      canonicalPaymentFailure ? 0.98 : 0.85,
    ),
    customerReach: distribution(
      canonicalPaymentFailure ? 'widespread' : 'subset',
      ['single', 'subset', 'widespread', 'unknown'],
      canonicalPaymentFailure ? 0.97 : 0.8,
    ),
    regionalReach: distribution(
      'single_region',
      ['single_region', 'multi_region', 'global', 'not_applicable', 'unknown'],
      0.99,
    ),
    serviceBreadth: distribution(
      'single_service',
      ['single_service', 'multi_service', 'platform_wide', 'unknown'],
      0.96,
    ),
    primaryOwningDomain: distribution(
      owner,
      ['payments', 'authentication', 'fulfillment', 'platform', 'unknown'],
      owner === 'unknown' ? 0.5 : 0.99,
    ),
    evidenceSufficiency: {
      yesProbability: canonicalPaymentFailure ? 0.99 : 0.9,
    },
  };
}

export function evaluateDeploymentEventDeterministically(
  signal: DeploymentEventInput,
): OperationalJudgments {
  const owner = Object.hasOwn(NORTHSTAR_SERVICE_DOMAINS, signal.service)
    ? NORTHSTAR_SERVICE_DOMAINS[
        signal.service as keyof typeof NORTHSTAR_SERVICE_DOMAINS
      ]
    : 'unknown';
  return {
    priorityAssessment: distribution('P3', ['P0', 'P1', 'P2', 'P3'], 0.97),
    customerReach: distribution(
      'unknown',
      ['single', 'subset', 'widespread', 'unknown'],
      0.95,
    ),
    regionalReach: distribution(
      'single_region',
      ['single_region', 'multi_region', 'global', 'not_applicable', 'unknown'],
      0.97,
    ),
    serviceBreadth: distribution(
      'single_service',
      ['single_service', 'multi_service', 'platform_wide', 'unknown'],
      0.97,
    ),
    primaryOwningDomain: distribution(
      owner,
      ['payments', 'authentication', 'fulfillment', 'platform', 'unknown'],
      owner === 'unknown' ? 0.5 : 0.97,
    ),
    evidenceSufficiency: { yesProbability: 0.2 },
  };
}

export interface AutomationDecision {
  rules: PolicyRuleResult[];
  authorizedActions: WorkflowActionType[];
  thresholds: typeof AUTOMATION_THRESHOLDS;
}

export const AUTOMATION_THRESHOLDS = {
  priorityChoiceProbability: 0.95,
  impactChoiceProbability: 0.95,
  ownershipChoiceProbability: 0.95,
  evidenceSufficiencyYesProbability: 0.95,
} as const;

function selectedProbability(judgment: {
  choice: string;
  probabilities: Array<{ outcome: string; probability: number }>;
}): number {
  return (
    judgment.probabilities.find(
      (probability) => probability.outcome === judgment.choice,
    )?.probability ?? 0
  );
}

export function decideAutomation(
  judgments: OperationalJudgments,
  hasCorroboratingFact: boolean,
  noMatchConfirmed = true,
): AutomationDecision {
  const priority = judgments.priorityAssessment.choice;
  const owner = judgments.primaryOwningDomain.choice;
  const sufficientEvidence =
    judgments.evidenceSufficiency.yesProbability >=
    AUTOMATION_THRESHOLDS.evidenceSufficiencyYesProbability;
  const confidentPriority =
    selectedProbability(judgments.priorityAssessment) >=
    AUTOMATION_THRESHOLDS.priorityChoiceProbability;
  const knownImpact =
    judgments.customerReach.choice !== 'unknown' &&
    judgments.regionalReach.choice !== 'unknown' &&
    judgments.serviceBreadth.choice !== 'unknown';
  const confidentImpact = [
    judgments.customerReach,
    judgments.regionalReach,
    judgments.serviceBreadth,
  ].every(
    (judgment) =>
      selectedProbability(judgment) >=
      AUTOMATION_THRESHOLDS.impactChoiceProbability,
  );
  const confidentOwner =
    selectedProbability(judgments.primaryOwningDomain) >=
    AUTOMATION_THRESHOLDS.ownershipChoiceProbability;
  const createIncident =
    priority !== 'P3' &&
    confidentPriority &&
    sufficientEvidence &&
    knownImpact &&
    confidentImpact &&
    noMatchConfirmed;
  const assignOwner = createIncident && owner !== 'unknown' && confidentOwner;
  const pageOnCall =
    assignOwner &&
    (priority === 'P0' || priority === 'P1') &&
    hasCorroboratingFact;
  const rules: PolicyRuleResult[] = [
    {
      ruleId: 'incident-creation-evidence-and-impact',
      action: 'create_incident',
      outcome: createIncident ? 'authorized' : 'denied',
      explanation: createIncident
        ? 'Priority and impact Choice probabilities are at least 0.95, all impact dimensions are known, Evidence Sufficiency is at least 0.95, and no candidate Incident matches.'
        : 'Incident creation requires non-minor priority at 0.95 probability, known impact dimensions at 0.95 probability, Evidence Sufficiency of at least 0.95, and confident no-match across candidate Incidents.',
    },
    {
      ruleId: 'assignment-known-primary-domain',
      action: 'assign_owner',
      outcome: assignOwner ? 'authorized' : 'denied',
      explanation: assignOwner
        ? `Primary Owning Domain is ${owner} with at least 0.95 probability.`
        : 'Assignment requires an authorized Incident and a known Primary Owning Domain at 0.95 probability.',
    },
    {
      ruleId: 'paging-high-priority-corroborated',
      action: 'page_on_call',
      outcome: pageOnCall ? 'authorized' : 'denied',
      explanation: pageOnCall
        ? 'P0/P1 priority at 0.95 probability, ownership at 0.95 probability, Evidence Sufficiency at 0.95, and a Corroborating Fact authorize paging.'
        : 'Paging requires P0/P1 priority at 0.95 probability, ownership at 0.95 probability, Evidence Sufficiency at 0.95, and a Corroborating Fact.',
    },
  ];

  return {
    rules,
    thresholds: AUTOMATION_THRESHOLDS,
    authorizedActions: rules
      .filter((rule) => rule.outcome === 'authorized')
      .map((rule) => rule.action),
  };
}
