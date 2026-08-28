# src/common/

The `@bmkb/common` package — shared API contracts and helpers used by every other package in the monorepo.

## Contents

- **types.ts** — TypeScript interfaces and enums for all API request/response shapes, document status, ingest jobs, and error codes.
- **tenant-filter.ts** — Builds the explicit `equals` retrieval filter for per-user isolation.
- **size-router.ts** — Decides INLINE vs S3 ingestion path based on file size.
- **rate-limiter.ts** — Token-bucket configuration for ingestion throughput control.
- **document-id.ts** — Deterministic, idempotent document ID generation.
- **models.ts** — Chat model catalog (allow-list for generation model selection).

## Rule

Never redefine these shapes elsewhere. All packages import from `@bmkb/common`.
