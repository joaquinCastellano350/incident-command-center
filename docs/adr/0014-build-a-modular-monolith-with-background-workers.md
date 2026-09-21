# Build a modular monolith with background workers

The MVP will implement ingestion, triage, policy, workflow, incident records, and assistant access as explicit modules inside one codebase, deployed as web/API and background-worker processes over one transactional datastore and durable job mechanism. These logical boundaries will not become independently deployed microservices unless a demonstrated scaling or isolation requirement justifies the distributed-systems cost.
