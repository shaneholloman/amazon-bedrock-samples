# Security

This document describes the security posture of the sample application. Review these considerations before deploying to a production environment.

## Per-user isolation (the core boundary)

- Every document is tagged with a server-derived `user_id` (Cognito `sub`) and `tenant_id` inline metadata attribute. A client cannot override these values.
- Every retrieval call applies an **explicit `equals` filter** on `user_id`. There is no code path that queries Bedrock without it.
- A missing identity fails closed (HTTP 401/403).
- `GET /status` enforces ownership on the stored record before returning it.
- **Identity is never taken from a request header or body** — only from the verified JWT claims.
- Implicit (model-generated) filtering is never relied on for isolation.
- Reserved underscore-prefixed metadata keys are rejected at upload, in the shared helpers, and in the worker.
- A dedicated cross-user / cross-tenant isolation test suite guards this.

## Encryption and network

- **DynamoDB tables, SQS queue + DLQ, CloudWatch log groups** — customer-managed KMS CMKs with rotation enabled.
- **S3 buckets** — SSE with TLS-only bucket policy (`aws:SecureTransport=false` deny), all public access blocked, ownership enforced, access logging on.
- **Frontend bucket** — private behind CloudFront OAC.
- **API Gateway** — Cognito authorizer (fails closed), access logging, stage throttling, scoped CORS allow-list.

## IAM

Least privilege throughout:
- Exact Bedrock actions (no `bedrock:*`)
- KB-ARN scoped grants
- Per-Lambda S3/DDB/SQS grants
- Confused-deputy guards on the KB role

## Application security

- Strict input validation: filename traversal/control-char rejection, base64 + size cross-checks, doc-id format checks, length caps.
- Structured logging redacts content-bearing fields — document bytes, base64 payloads, and query text are never logged.
- No internal error detail leaked to clients (generic 500s, proper 400s).
- Frontend renders all content as escaped text nodes.

## Operational visibility

- CloudWatch alarms on ingest DLQ depth, ingest-worker errors, and API 5xx.

## Known limitations (address before production)

| Area | Current state | Production recommendation |
|------|---------------|---------------------------|
| WAF | Not deployed | Add AWS WAF with rate rules and bot control |
| Per-user throttling | Stage-level only | Add API Gateway usage plans |
| Cognito security | Advanced security/MFA off | Enable threat protection + MFA |
| Data retention | `RemovalPolicy.DESTROY` | Switch to `RETAIN` for stateful resources |
| Conversation history | Client-side only, not persisted | Add server-side storage if cross-device continuity is needed |
