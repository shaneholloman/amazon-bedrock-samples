# deploy/

CDK v2 infrastructure stack for the application. A single stack deploys all resources:

- Bedrock Managed Knowledge Base + custom connector data source
- API Gateway (REST, Cognito authorizer)
- Lambda functions (upload, ingest-worker, chat, status)
- SQS FIFO queue + dead-letter queue
- DynamoDB tables (document status, rate-limiter tokens)
- S3 buckets (document staging, frontend hosting)
- CloudFront distribution (SPA hosting with OAC)
- Cognito user pool (hosted UI, Authorization Code + PKCE)

## Usage

```bash
npx cdk bootstrap    # once per account/region
npm run deploy       # builds frontend + deploys everything
npm run destroy      # tears down all resources
```
