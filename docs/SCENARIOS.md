# Canonical Scenarios

## Operating environment

Northstar Market is a fictional marketplace operating in `us-east`, `eu-west`, and `sa-east`.

| Domain         | Services                                                                   |
| -------------- | -------------------------------------------------------------------------- |
| payments       | `checkout-api`, `payment-processor`                                        |
| authentication | `identity-api`, `session-service`                                          |
| fulfillment    | `order-service`, `fulfillment-worker`                                      |
| platform       | `api-gateway`, `event-router`, shared databases and runtime infrastructure |

## Automatic response

`checkout-api` version `2026.09.20.3` deploys successfully to `us-east`. Four minutes later, a Monitoring Alert reports payment authorization failures at 18% against a declared 2% threshold over ten minutes.

The expected Evaluation assesses P1 priority, widespread Customer Reach, single-region Regional Reach, payments as the Primary Owning Domain, and adequate Evidence Sufficiency. The threshold breach and recent deployment are Corroborating Facts. Policy creates an Incident, assigns payments, and pages its On-call Engineer.

## Incident matching

After the payment Incident opens, three Customer Reports describe the same checkout failure using different language and distinct customer references. Candidate retrieval finds the active Incident, Jev judges each Signal `same_incident`, and policy creates Evidence Links without creating another Incident or sending another page.

## Human review

A single Customer Report says that sign-in "has been acting strange" but provides no customer reference, region, timing, error, or reproducible behavior. Jev may still return a best-fit Priority Assessment and Primary Owning Domain, but Evidence Sufficiency is too low for action. Policy creates a standard Review Task, and an Operator dismisses the Triage Case with a recorded reason because the available evidence does not justify creating or joining an Incident.

## Correlation policy

- A Deployment Event corroborates a regression for the same service and region within 15 minutes.
- At least three independent Signals within 10 minutes provide multi-signal corroboration.
- Active Incident retrieval considers all active Incidents and recent activity within two hours.
- Resolved Incident retrieval uses a 24-hour lookback.
- Customer Reports are independent when their customer references differ.
- Provider deliveries with the same provider and source-event key are duplicates regardless of arrival time.

Every duration and count is versioned policy configuration rather than part of a Jev question.
