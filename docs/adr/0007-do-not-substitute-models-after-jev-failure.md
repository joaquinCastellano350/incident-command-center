# Do not substitute models after a Jev failure

If Jev is unavailable or returns no valid decision record, the application will record the evaluation failure, retry with bounded backoff, and ultimately create a Review Task without executing a model-dependent Workflow Action. It will not silently substitute the generative LLM or deterministic heuristics for Jev, because doing so would change the meaning and measured performance of the decision pipeline; ordinary monitoring and paging remain independent safety systems.
