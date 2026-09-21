# Use REST commands and server-sent events

The operator dashboard will use REST endpoints for commands and queries and Server-Sent Events for Evaluation, review, and Workflow Action status updates, with polling as a reconnect fallback. GraphQL and WebSockets are excluded because the MVP has a predominantly server-driven, one-way update flow.
