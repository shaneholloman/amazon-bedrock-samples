# Architecture Details

This document provides deeper technical context for the architecture described in the [README](../README.md) and the accompanying blog post.

## Infrastructure overview

The stack is a single CDK v2 deployment (`deploy/`) that provisions:

- **Amazon Bedrock Managed Knowledge Base** — `type=MANAGED`, `embeddingModelType=MANAGED`. Bedrock fully manages the vector store and embeddings; there is no OpenSearch collection, index, or `storageConfiguration` to own.
- **Custom connector data source** — `MANAGED_KNOWLEDGE_BASE_CONNECTOR` + `CUSTOM`, enabling direct inline ingestion via `IngestKnowledgeBaseDocuments`.
- **API Gateway** — REST API with a Cognito authorizer. Stage throttling and access logging enabled.
- **Lambda functions** — upload, ingest-worker, chat, status, kb-provisioner.
- **SQS FIFO queue + DLQ** — decouples uploads from ingestion. The `documentId` is the message group ID so uploads fan out in parallel.
- **DynamoDB tables** — doc status tracking + rate-limiter token store.
- **S3 buckets** — large file staging + SPA hosting (private, OAC-fronted by CloudFront).
- **CloudFront** — serves the frontend with OAC, HSTS, and proper cache headers.
- **Cognito user pool** — hosted UI, Authorization Code + PKCE, no client secret.

## Managed KB via native CloudFormation

The Knowledge Base and custom connector data source are provisioned using native CloudFormation resources:

- `AWS::Bedrock::KnowledgeBase` with `type: MANAGED` and `ManagedKnowledgeBaseConfiguration`
- `AWS::Bedrock::DataSource` with `ManagedKnowledgeBaseConnectorConfiguration` (`connectorType: CUSTOM`)

No custom resource Lambda or Provider framework is needed. CloudFormation handles the asynchronous creation lifecycle natively.

### IAM

- The **KB role** trusts `bedrock.amazonaws.com` with confused-deputy guards (`aws:SourceAccount`/`aws:SourceArn`), and holds `bedrock:InvokeModel` scoped to `foundation-model/*` plus S3 read on the documents bucket.
- There are **no `aoss:*` permissions anywhere** — there is no OpenSearch.

## Ingestion path

### Size routing

The upload Lambda uses the shared `@bmkb/common` size router:

| Path | Condition | Behavior |
|------|-----------|----------|
| **INLINE** | ≤ 6 MB | Bytes sent directly in `IngestKnowledgeBaseDocuments` |
| **S3** | > 6 MB, ≤ 50 MB | File staged to S3, ingested by reference |
| **Rejected** | > 50 MB | HTTP 400 |

### Ingest worker

The worker reads from the SQS queue and applies:

- **Batch size:** up to 10 documents per `IngestKnowledgeBaseDocuments` call
- **Rate limit:** token-bucket at 5 TPS (non-adjustable quota)
- **Concurrency gate:** DynamoDB-backed, max 10 concurrent ingest+delete operations per account (non-adjustable)

The concurrency limit surfaces as a `ValidationException` (not `ThrottlingException`), so retry classifiers must handle it explicitly.

### Document indexing lifecycle

| Status | Meaning | Queryable |
|--------|---------|-----------|
| STARTING | Request accepted, processing not begun | No |
| PENDING | Queued for a processing slot | No |
| IN_PROGRESS | Parsing and embedding running | No |
| TEXT_INDEXED | Text chunks indexed; multimodal still running | Yes (text) |
| INDEXED | Fully processed | Yes |

The application marks a document as retrievable at `TEXT_INDEXED`. A scheduled self-heal sweep (15-minute EventBridge rule) reconciles any PENDING documents that were missed by on-demand polling.

## Retrieval path

`AgenticRetrieveStream` performs a full chat turn in one call:

1. Decomposes the question into sub-queries
2. Retrieves with the per-user filter applied to each sub-query
3. Streams a grounded, cited answer (`generateResponse: true`)

### Multi-turn context

The Agentic Retrieval API is stateless — no server-side session. The client replays recent turns in `history`, which the server appends to the `messages[]` parameter. The per-user filter is always applied regardless of history content.

### Model selection

- **Auto** (default): `foundationModelType=MANAGED` — Bedrock picks the model.
- **Catalog model**: `foundationModelType=CUSTOM` with a resolved model ARN from the `@bmkb/common` `CHAT_MODELS` allow-list. Unknown/forged model IDs are rejected.

## Frontend hosting

- **Private S3 bucket** — block-all-public, SSE, versioned, TLS-only.
- **CloudFront with OAC** — the bucket is never public; only the distribution can read it.
- **SPA routing** — CloudFront rewrites 403/404 to `/index.html` with a 200.
- **Response headers** — HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, strict `Referrer-Policy`.

### Runtime config

The frontend is environment-agnostic. At startup it fetches `/config.json` (written by `cdk deploy` from live stack outputs). Nothing is baked into the JavaScript.

| Key | Purpose |
|-----|---------|
| `apiBase` | Deployed API stage base URL |
| `cognito.authority` | User-pool issuer URL |
| `cognito.clientId` | Public SPA app client ID |
| `cognito.domain` | Hosted-UI domain for logout |

For local development, `npm run dev` falls back to `VITE_*` env vars (tree-shaken out of production builds).
