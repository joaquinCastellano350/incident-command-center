# Use relational current state with append-only history

The MVP will use ordinary relational tables for current operational state alongside append-only Evaluations, Policy Decisions, Human Overrides, Workflow Actions, and Timeline Events. Current state and its corresponding historical record will change in one transaction, providing traceability without the implementation and migration cost of making event replay the sole source of truth.
