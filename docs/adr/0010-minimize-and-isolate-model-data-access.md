# Minimize and isolate model data access

The portfolio will use synthetic operational data, retain model credentials only on the server, redact configured sensitive fields during normalization, and send each model only the state needed for its bounded task. Source text is untrusted data, and the generative assistant can retrieve only allowlisted persisted evidence without direct database authority or Workflow Action access.
