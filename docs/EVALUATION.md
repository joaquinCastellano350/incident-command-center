# Evaluation Plan

## Claim

The evaluation tests whether Jev is a better fit than deterministic rules or a conventional structured-output generative LLM for bounded operational triage decisions. It does not assume that lower cost implies better results or claim production safety from a portfolio-sized dataset.

## Corpus

Maintain a versioned corpus of roughly 150 synthetic but realistic Signals covering ordinary, ambiguous, contradictory, incomplete, near-duplicate, adversarial, and counterfactual cases. Split entire scenario families between development and held-out evaluation so superficial rewrites cannot leak across the boundary.

The organizational rubric defines the gold Operational Judgments and permitted Workflow Actions. A generative LLM may draft scenario prose and mutations, but a human must approve every label and add an adjudication note for ambiguous cases. Held-out scenarios do not change after admission.

## Baselines

Evaluate three approaches against the same normalized facts, taxonomy, and semantic criteria:

1. Jev with typed questions.
2. GPT-5.6 Terra using its native structured-output interface.
3. Deterministic rules wherever the available facts permit them.

Record schema failures, retries, token usage, end-to-end latency, estimated cost, selected outcomes, probability information, and resolved model versions.

GPT-5.6 Terra also powers the generative incident assistant, with separately versioned configuration for the assistant and benchmark roles. Prefer a stable dated snapshot when the provider offers one; otherwise persist the returned model identifier and rerun the benchmark when the configured alias changes.

## Measures

The primary measure is safe automation coverage at a fixed action-specific error limit. Also report per-judgment classification quality, calibration, review rate, harmful-action errors, latency, cost, and schema reliability, including uncertainty intervals where meaningful.

## Automation gates

Choose confidence and Evidence Sufficiency thresholds on development data, then evaluate them once on the held-out set. The portfolio targets are:

- zero observed false pages;
- at least 95% precision for automatic Incident creation;
- at least 97% precision for automatic Evidence Links; and
- a Corroborating Fact for every automatic page.

If an action misses its constraint, it remains human-reviewed. These results demonstrate the behavior of the evaluated versions and corpus; they are not evidence of universal or production-grade safety.

The full benchmark is an explicit evaluation workflow rather than an ordinary continuous-integration requirement. Routine CI uses deterministic fixtures and a small opt-in real-API smoke evaluation.
