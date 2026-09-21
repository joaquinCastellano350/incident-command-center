# Use deterministic retrieval before incident match judgments

Candidate retrieval will use PostgreSQL structured filters, full-text search, and trigram similarity over active Incidents, ranking identifiers, service, region, recency, and textual similarity and returning at most five candidates for Jev Incident Match judgments. Embeddings and a vector database are excluded until benchmark errors demonstrate a retrieval problem that ordinary search cannot solve.
