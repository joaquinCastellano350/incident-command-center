# Incident Command Center

Incident Command Center evaluates operational signals for Northstar Market, a fictional multi-region commerce marketplace, applies explicit safety policy, and coordinates the creation and handling of incidents while preserving human control over uncertain or harmful actions.

## Language

**Domain**:
One of Northstar Market's accountable operational areas: payments, authentication, fulfillment, or platform.
_Avoid_: Team, service group

**Service**:
An independently operated application or infrastructure capability assigned to one Domain.
_Avoid_: Domain, component

**Signal**:
An immutable observation received from an operational source, such as a monitoring alert, customer report, log-derived event, or deployment event.
_Avoid_: Alert, event, report when referring to the shared cross-source concept

**Monitoring Alert**:
A Signal reporting that an observed operational metric crossed a declared threshold during an evaluation window.

**Customer Report**:
A Signal containing a customer's description of an operational problem and any available affected-operation context.

**Log Anomaly**:
A Signal describing an unusual error signature or occurrence pattern observed in application logs.

**Deployment Event**:
A Signal recording the completion and outcome of deploying a specific service version to a region.

**Triage Case**:
The persistent evaluation of one Signal, including its operational judgments, policy outcome, and review state. A Triage Case does not imply that an Incident exists.
_Avoid_: Incident candidate, case

**Incident**:
A confirmed operational disruption tracked for investigation and resolution. An Incident may be supported by many Signals.
_Avoid_: Triage Case, alert

**Evidence Link**:
The association recording that a Signal supports or relates to an Incident.
_Avoid_: Attachment, duplicate

**Review Task**:
A request for a human operator to decide how a Triage Case should proceed.
_Avoid_: Review queue item, escalation

**Review Urgency**:
A deterministic risk class for ordering Review Tasks: urgent for plausible high-priority impact, corroborated risk, or a failed high-impact action; standard otherwise.
_Avoid_: Priority Assessment, model confidence

**Operational Judgment**:
A bounded semantic assessment of a Signal or its relationship to operational context, expressed as typed outcomes and probabilities.
_Avoid_: Recommendation, action, route

**Evaluation**:
One immutable execution of a versioned question set against a Triage Case's evidence, producing Operational Judgments.
_Avoid_: Policy Decision, reclassification

**Re-evaluation**:
A new Evaluation created intentionally after evidence, questions, models, or policy change and linked to the Evaluation it follows.
_Avoid_: Edit, retry

**Priority Assessment**:
Jev's Operational Judgment of the response urgency indicated by a Signal, expressed on the P0–P3 scale.
_Avoid_: Current Priority, severity

**Current Priority**:
The authoritative P0–P3 response urgency assigned to an Incident and used by operators and policy after any Human Override.
_Avoid_: Priority Assessment, severity

**Impact Scope**:
The observed breadth of an operational disruption, kept separate from its response priority.
_Avoid_: Priority, severity

**P0 — Critical**:
Priority for catastrophic or rapidly expanding impact requiring immediate cross-team coordination.

**P1 — Major**:
Priority for substantial customer or service impact requiring an immediate response from the owning team.

**P2 — Moderate**:
Priority for limited degradation with tolerable short-term impact or a viable workaround.

**P3 — Minor**:
Priority for small, informational, or unconfirmed impact that does not justify an urgent response.

**Customer Reach**:
The estimated breadth of affected customers: single, subset, widespread, or unknown.

**Regional Reach**:
The estimated geographic breadth of impact: single region, multiple regions, global, not applicable, or unknown.

**Service Breadth**:
The estimated breadth of affected services: single service, multiple services, platform-wide, or unknown.

**Primary Owning Domain**:
The domain best positioned to provide the first accountable response, even when an Incident affects several domains.
_Avoid_: Only affected team, impacted domain

**Evidence Sufficiency**:
Jev's yes-probability judgment that a Signal contains enough operational evidence for automated triage, kept distinct from confidence in any particular Choice or Score.
_Avoid_: Confidence, completeness

**Policy Decision**:
The authoritative determination of what may happen next, derived from Operational Judgments, deterministic facts, and action-specific risk rules.
_Avoid_: Model recommendation, Jev route

**Workflow Action**:
An attempted operational change authorized by a Policy Decision, such as creating an Incident, assigning an owner, paging an on-call engineer, or creating an Evidence Link.
_Avoid_: Judgment, recommendation

**Action Attempt**:
One recorded execution attempt for a Workflow Action, including its outcome and provider correlation data.
_Avoid_: Workflow Action, retry

**Corroborating Fact**:
A machine-verifiable operational condition that supports allowing a higher-risk Workflow Action, independently of an Operational Judgment's confidence.
_Avoid_: Model confidence, supporting opinion

**Incident Match**:
An Operational Judgment about whether a Signal and a candidate Incident represent the same disruption, distinct but related disruptions, or unrelated activity.
_Avoid_: Duplicate status, new incident

**Human Override**:
A human decision that changes the current operational outcome while preserving the superseded Operational Judgment and Policy Decision in the audit history.
_Avoid_: Edit, correction

**Operator**:
A person who reviews Triage Cases and authorizes or overrides their outcomes.
_Avoid_: On-call Engineer, Incident Commander

**On-call Engineer**:
The person currently responsible for investigating disruptions in an operational service.
_Avoid_: Operator, Incident Commander

**Incident Commander**:
The person coordinating the response to an active Incident.
_Avoid_: Operator, On-call Engineer

**Timeline Event**:
An immutable, time-stamped fact about an Incident's history, including lifecycle transitions and human or automated actions.
_Avoid_: Log entry, audit record

**Assistant Interaction**:
A persisted exchange with the generative incident assistant, including its supporting evidence references and generated output. It is not an Incident fact or Timeline Event.
_Avoid_: Incident update, evidence, model judgment

**Published Update**:
An operational communication that a human accepted from a draft or authored directly.
_Avoid_: Draft, Assistant Interaction
