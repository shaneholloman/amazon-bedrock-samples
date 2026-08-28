# src/lambdas/upload/

Handles `POST /upload` — the entry point for document ingestion.

1. Resolves tenant context from the verified JWT
2. Validates the request body (filename, content type, size)
3. Routes by size: inline (≤ 6 MB) or S3 (≤ 50 MB)
4. Persists a PENDING status record to DynamoDB
5. Enqueues an ingest job to SQS
6. Returns the document ID and (for S3 path) a presigned upload URL
