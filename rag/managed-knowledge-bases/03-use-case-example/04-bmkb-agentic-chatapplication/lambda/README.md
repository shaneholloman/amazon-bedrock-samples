# lambda/

Backend source code — shared library and Lambda function handlers.

| Folder | Purpose |
|--------|---------|
| `common/` | `@bmkb/common` — shared contracts, types, and helpers (single source of truth for API shapes, tenant filtering, size routing, rate limiting, document ID generation) |
| `upload/` | POST /upload — validates uploads, routes by size, enqueues ingest jobs |
| `ingest-worker/` | SQS → `IngestKnowledgeBaseDocuments` with batching, rate limiting, and concurrency control |
| `chat/` | POST /chat — `AgenticRetrieveStream` with per-user filter, streams cited answers |
| `status/` | GET /status — document indexing status with on-read reconciliation |
