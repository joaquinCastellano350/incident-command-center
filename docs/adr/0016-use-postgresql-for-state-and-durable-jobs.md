# Use PostgreSQL for state and durable jobs

PostgreSQL will be the MVP's transactional system of record, with `pg-boss` providing durable asynchronous jobs behind an internal job-port interface. Job creation will join the caller's database transaction, workers will use leases and bounded retries, and job outcomes will be retained for audit; Redis and a separate message broker are excluded until measured demand justifies their operational cost. Queue uniqueness controls do not replace Workflow Action idempotency, and the operational dashboard is protected and read-only in the public demo.
