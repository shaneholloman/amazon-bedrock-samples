# src/lambdas/status/

Handles `GET /status` — returns the indexing status of uploaded documents.

- Reads the document status record from DynamoDB
- Enforces ownership (only the owning user can see their document's status)
- Reconciles PENDING documents against `GetKnowledgeBaseDocuments` on read
- Includes a scheduled self-heal sweep (15-min EventBridge rule) that transitions stale PENDING documents to FAILED
