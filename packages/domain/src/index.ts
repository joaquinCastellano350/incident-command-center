import type {
  MonitoringAlertInput,
  DeploymentEventInput,
  CustomerReportInput,
  LogAnomalyInput,
  OperationalJudgments,
  PolicyRuleResult,
  WorkflowActionType,
  EvaluationAttempt,
  ProviderRequest,
  Incident,
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

export interface AssignmentProviderPort<TAssignment = unknown> {
  assign(assignment: TAssignment): Promise<{ providerReference: string }>;
}

export class WorkflowProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly providerReference: string | null = null,
  ) {
    super(message);
  }
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
  providerRequest?: ProviderRequest | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  retryCount: number;
  attempts?: EvaluationAttempt[];
}

export interface OperationalJudgmentProviderPort<TSignal, TJudgments> {
  evaluate(
    signal: TSignal,
    onAttempt?: (attempt: EvaluationAttempt) => Promise<void>,
  ): Promise<OperationalJudgmentResult<TJudgments>>;
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

export function evaluateCustomerReportDeterministically(
  signal: CustomerReportInput,
): OperationalJudgments {
  const owner =
    signal.service && Object.hasOwn(NORTHSTAR_SERVICE_DOMAINS, signal.service)
      ? NORTHSTAR_SERVICE_DOMAINS[
          signal.service as keyof typeof NORTHSTAR_SERVICE_DOMAINS
        ]
      : 'unknown';
  return {
    priorityAssessment: distribution('P3', ['P0', 'P1', 'P2', 'P3'], 0.7),
    customerReach: distribution(
      'unknown',
      ['single', 'subset', 'widespread', 'unknown'],
      0.7,
    ),
    regionalReach: distribution(
      signal.region ? 'single_region' : 'unknown',
      ['single_region', 'multi_region', 'global', 'not_applicable', 'unknown'],
      0.7,
    ),
    serviceBreadth: distribution(
      'unknown',
      ['single_service', 'multi_service', 'platform_wide', 'unknown'],
      0.7,
    ),
    primaryOwningDomain: distribution(
      owner,
      ['payments', 'authentication', 'fulfillment', 'platform', 'unknown'],
      owner === 'unknown' ? 0.7 : 0.8,
    ),
    evidenceSufficiency: { yesProbability: 0.75 },
  };
}

export function evaluateLogAnomalyDeterministically(
  signal: LogAnomalyInput,
): OperationalJudgments {
  const repeated = signal.occurrenceCount >= 10;
  const enoughSamples = signal.sampleMessages.length >= 2;
  const owner = Object.hasOwn(NORTHSTAR_SERVICE_DOMAINS, signal.service)
    ? NORTHSTAR_SERVICE_DOMAINS[
        signal.service as keyof typeof NORTHSTAR_SERVICE_DOMAINS
      ]
    : 'unknown';
  return {
    priorityAssessment: distribution(
      repeated ? 'P2' : 'P3',
      ['P0', 'P1', 'P2', 'P3'],
      0.98,
    ),
    customerReach: distribution(
      repeated ? 'subset' : 'unknown',
      ['single', 'subset', 'widespread', 'unknown'],
      0.97,
    ),
    regionalReach: distribution(
      'single_region',
      ['single_region', 'multi_region', 'global', 'not_applicable', 'unknown'],
      0.99,
    ),
    serviceBreadth: distribution(
      'single_service',
      ['single_service', 'multi_service', 'platform_wide', 'unknown'],
      0.98,
    ),
    primaryOwningDomain: distribution(
      owner,
      ['payments', 'authentication', 'fulfillment', 'platform', 'unknown'],
      owner === 'unknown' ? 0.98 : 0.99,
    ),
    evidenceSufficiency: { yesProbability: enoughSamples ? 0.98 : 0.4 },
  };
}

export interface AutomationDecision {
  rules: PolicyRuleResult[];
  authorizedActions: WorkflowActionType[];
  thresholds: AutomationThresholds;
}

export const AUTOMATION_THRESHOLDS = {
  priorityChoiceProbability: 0.95,
  impactChoiceProbability: 0.95,
  ownershipChoiceProbability: 0.95,
  evidenceSufficiencyYesProbability: 0.95,
  incidentMatchChoiceProbability: 0.97,
} as const;
export type AutomationThresholds = {
  [K in keyof typeof AUTOMATION_THRESHOLDS]: number;
};
export const CAUTIOUS_AUTOMATION_THRESHOLDS: AutomationThresholds = {
  ...AUTOMATION_THRESHOLDS,
  evidenceSufficiencyYesProbability: 0.98,
};

export const REVIEW_URGENCY_HIGH_PRIORITY_PROBABILITY = 0.25;

export function reviewUrgency(
  priority: OperationalJudgments['priorityAssessment'] | null,
  hasCorroboratingFact: boolean,
  failedHighImpactAction = false,
): 'urgent' | 'standard' {
  const highPriorityProbability =
    priority?.probabilities
      .filter((item) => item.outcome === 'P0' || item.outcome === 'P1')
      .reduce((total, item) => total + item.probability, 0) ?? 0;
  return failedHighImpactAction ||
    highPriorityProbability >= REVIEW_URGENCY_HIGH_PRIORITY_PROBABILITY ||
    hasCorroboratingFact
    ? 'urgent'
    : 'standard';
}

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

export type IncidentRelationshipDecision =
  | { outcome: 'same_incident'; incidentId: string }
  | { outcome: 'no_match' | 'review'; incidentId: null };

export function decideIncidentRelationship(
  candidateIds: string[],
  matches: OperationalJudgmentResult<OperationalJudgments>['incidentMatches'],
): IncidentRelationshipDecision {
  if (
    candidateIds.length !== matches.length ||
    new Set(matches.map((match) => match.candidateIncidentId)).size !==
      candidateIds.length ||
    matches.some((match) => !candidateIds.includes(match.candidateIncidentId))
  ) {
    return { outcome: 'review', incidentId: null };
  }
  const confidentSame = matches.filter(
    (match) =>
      match.judgment.choice === 'same_incident' &&
      selectedProbability(match.judgment) >=
        AUTOMATION_THRESHOLDS.incidentMatchChoiceProbability,
  );
  const confidentUnrelated = matches.filter(
    (match) =>
      match.judgment.choice === 'unrelated' &&
      selectedProbability(match.judgment) >=
        AUTOMATION_THRESHOLDS.incidentMatchChoiceProbability,
  );
  if (
    confidentSame.length === 1 &&
    confidentUnrelated.length === matches.length - 1
  ) {
    return {
      outcome: 'same_incident',
      incidentId: confidentSame[0]!.candidateIncidentId,
    };
  }
  if (confidentUnrelated.length === matches.length) {
    return { outcome: 'no_match', incidentId: null };
  }
  return { outcome: 'review', incidentId: null };
}

export function decideAutomation(
  judgments: OperationalJudgments,
  hasCorroboratingFact: boolean,
  relationship: IncidentRelationshipDecision,
  thresholds: AutomationThresholds = AUTOMATION_THRESHOLDS,
): AutomationDecision {
  const priority = judgments.priorityAssessment.choice;
  const owner = judgments.primaryOwningDomain.choice;
  const sufficientEvidence =
    judgments.evidenceSufficiency.yesProbability >=
    thresholds.evidenceSufficiencyYesProbability;
  const confidentPriority =
    selectedProbability(judgments.priorityAssessment) >=
    thresholds.priorityChoiceProbability;
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
      selectedProbability(judgment) >= thresholds.impactChoiceProbability,
  );
  const confidentOwner =
    selectedProbability(judgments.primaryOwningDomain) >=
    thresholds.ownershipChoiceProbability;
  const createIncident =
    priority !== 'P3' &&
    confidentPriority &&
    sufficientEvidence &&
    knownImpact &&
    confidentImpact &&
    relationship.outcome === 'no_match';
  const assignOwner = createIncident && owner !== 'unknown' && confidentOwner;
  const pageOnCall =
    assignOwner &&
    (priority === 'P0' || priority === 'P1') &&
    hasCorroboratingFact;
  const createEvidenceLink =
    relationship.outcome === 'same_incident' && sufficientEvidence;
  const rules: PolicyRuleResult[] = [
    {
      ruleId: 'incident-creation-evidence-and-impact',
      action: 'create_incident',
      outcome: createIncident ? 'authorized' : 'denied',
      explanation: createIncident
        ? `Priority and impact Choice probabilities meet thresholds, all impact dimensions are known, Evidence Sufficiency is at least ${thresholds.evidenceSufficiencyYesProbability}, and no candidate Incident matches.`
        : `Incident creation requires non-minor priority and known impact dimensions at their thresholds, Evidence Sufficiency of at least ${thresholds.evidenceSufficiencyYesProbability}, and confident no-match across candidate Incidents.`,
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
        ? `P0/P1 priority and ownership meet thresholds, Evidence Sufficiency is at least ${thresholds.evidenceSufficiencyYesProbability}, and a Corroborating Fact exists.`
        : `Paging requires P0/P1 priority, known ownership, Evidence Sufficiency at ${thresholds.evidenceSufficiencyYesProbability}, and a Corroborating Fact.`,
    },
    {
      ruleId: 'evidence-link-confident-match',
      action: 'create_evidence_link',
      outcome: createEvidenceLink ? 'authorized' : 'denied',
      explanation: createEvidenceLink
        ? `One candidate is a confident same Incident match and Evidence Sufficiency is at least ${thresholds.evidenceSufficiencyYesProbability}.`
        : `Evidence Link requires one confident same Incident match and Evidence Sufficiency of at least ${thresholds.evidenceSufficiencyYesProbability}.`,
    },
  ];

  return {
    rules,
    thresholds,
    authorizedActions: rules
      .filter((rule) => rule.outcome === 'authorized')
      .map((rule) => rule.action),
  };
}

export function decideExistingIncidentAutomation(
  judgments: OperationalJudgments,
  hasCorroboratingFact: boolean,
  incident: Pick<
    Incident,
    'currentPriority' | 'status' | 'primaryOwningDomain'
  >,
  priorEffects: { assignmentFailed: boolean; pageAttempted: boolean },
  thresholds: AutomationThresholds = AUTOMATION_THRESHOLDS,
): AutomationDecision {
  const owner = judgments.primaryOwningDomain.choice;
  const active = incident.status !== 'resolved';
  const confidentOwner =
    owner !== 'unknown' &&
    selectedProbability(judgments.primaryOwningDomain) >=
      thresholds.ownershipChoiceProbability;
  const ownerAlreadyAssigned = incident.primaryOwningDomain === owner;
  const ownershipConflict =
    incident.primaryOwningDomain !== 'unknown' && !ownerAlreadyAssigned;
  const assignOwner =
    active &&
    confidentOwner &&
    incident.primaryOwningDomain === 'unknown' &&
    !priorEffects.assignmentFailed;
  const pageOnCall =
    active &&
    confidentOwner &&
    !ownershipConflict &&
    !priorEffects.assignmentFailed &&
    !priorEffects.pageAttempted &&
    (ownerAlreadyAssigned || assignOwner) &&
    (incident.currentPriority === 'P0' || incident.currentPriority === 'P1') &&
    (judgments.priorityAssessment.choice === 'P0' ||
      judgments.priorityAssessment.choice === 'P1') &&
    selectedProbability(judgments.priorityAssessment) >=
      thresholds.priorityChoiceProbability &&
    judgments.evidenceSufficiency.yesProbability >=
      thresholds.evidenceSufficiencyYesProbability &&
    hasCorroboratingFact;
  const rules: PolicyRuleResult[] = [
    {
      ruleId: 'existing-incident-not-recreated',
      action: 'create_incident',
      outcome: 'denied',
      explanation: 'The Triage Case already has an Incident.',
    },
    {
      ruleId: 'existing-incident-owner',
      action: 'assign_owner',
      outcome: assignOwner ? 'authorized' : 'denied',
      explanation: assignOwner
        ? `Primary Owning Domain is ${owner} with at least 0.95 probability.`
        : ownershipConflict
          ? 'A different Domain already owns the Incident; reassignment requires Operator review.'
          : priorEffects.assignmentFailed
            ? 'A previous assignment failed permanently; Operator review is required.'
            : 'Assignment is already complete or requires a known Primary Owning Domain at 0.95 probability.',
    },
    {
      ruleId: 'existing-incident-page',
      action: 'page_on_call',
      outcome: pageOnCall ? 'authorized' : 'denied',
      explanation: pageOnCall
        ? `Current Priority and the latest Priority Assessment are P0/P1, priority and ownership meet their thresholds, Evidence Sufficiency is at least ${thresholds.evidenceSufficiencyYesProbability}, and a Corroborating Fact exists.`
        : priorEffects.pageAttempted
          ? 'A prior page was already attempted; no duplicate automatic page is authorized.'
          : `Paging requires P0/P1 Current Priority and Priority Assessment at its confidence threshold, non-conflicting ownership at 0.95 probability, Evidence Sufficiency at ${thresholds.evidenceSufficiencyYesProbability}, and a Corroborating Fact.`,
    },
    {
      ruleId: 'existing-signal-not-relinked',
      action: 'create_evidence_link',
      outcome: 'denied',
      explanation: 'The original Signal remains attached to its Incident.',
    },
  ];
  return {
    rules,
    thresholds,
    authorizedActions: rules
      .filter((rule) => rule.outcome === 'authorized')
      .map((rule) => rule.action),
  };
}
