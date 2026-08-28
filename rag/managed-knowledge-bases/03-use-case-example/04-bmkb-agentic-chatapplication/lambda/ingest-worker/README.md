# src/lambdas/ingest-worker/

SQS-triggered worker that ingests documents into the Bedrock Managed Knowledge Base.

- Reads jobs from the ingest queue
- Batches up to 10 documents per `IngestKnowledgeBaseDocuments` call
- Enforces rate limits (token-bucket at 5 TPS) and concurrency (max 10 concurrent per account via DynamoDB gate)
- Attaches `user_id` and `tenant_id` inline metadata for per-user isolation
- Records terminal status (INDEXED or FAILED) to DynamoDB
- Routes persistent failures to the dead-letter queue
