import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

import {
  DEFAULT_INGEST_BATCH_MAX,
  DEFAULT_INGEST_MAX_TPS,
  DEFAULT_INGEST_MAX_CONCURRENCY,
  DEFAULT_INLINE_MAX_BYTES,
  DEFAULT_S3_MAX_FILE_BYTES,
  TENANT_METADATA_KEY,
} from '@bmkb/common';

import { StorageConstruct } from './storage-construct.js';
import { KnowledgeBaseConstruct } from './knowledge-base-construct.js';
import { MessagingConstruct } from './messaging-construct.js';
import { ApiConstruct } from './api-construct.js';
import { AuthConstruct } from './auth-construct.js';
import { HostingConstruct } from './hosting-construct.js';

/**
 * BmkbStack — the single deployable stack for bmkb-doc-chat (see README → Design decisions).
 *
 *  - S3 documents bucket (versioned, SSE, TLS-only, block-public, lifecycle).
 *  - TRUE Managed Knowledge Base (MKB, type=MANAGED, embeddingModelType=MANAGED)
 *    created via a Lambda-backed custom resource. Bedrock fully manages the
 *    vector store — NO OpenSearch, NO index, NO storageConfiguration.
 *  - CUSTOM-connector data source for the inline (text+base64 <=6MB) ingest fast
 *    path (MANAGED_KNOWLEDGE_BASE_CONNECTOR + CUSTOM), also via the custom resource.
 *  - SQS FIFO ingest queue + FIFO DLQ between upload and ingest-worker.
 *  - DynamoDB status table (+ tenant GSI, PITR, SSE) and rate/concurrency table.
 *  - REST API GW fronting upload/status/chat NodejsFunction lambdas.
 *  - Least-privilege IAM: EXACT bedrock actions (F14), no wildcards, KB-ARN
 *    scoped; per-lambda S3/DDB/SQS grants.
 *  - CfnOutputs: ApiBaseUrl, BucketName, KnowledgeBaseId, DataSourceId,
 *    TableName, QueueUrl (+ DLQ/RateTable for ops); Cognito (UserPoolId,
 *    UserPoolClientId, UserPoolDomain, CognitoRegion); frontend hosting
 *    (FrontendBucketName, CloudFrontUrl, CloudFrontDistributionId).
 */
export interface BmkbStackProps extends cdk.StackProps {
  /** Generation model ARN for RetrieveAndGenerate (Claude default). */
  readonly generationModelArn?: string;
  /** Browser origins allowed by CORS. */
  readonly allowedOrigins?: readonly string[];
  /** Header the edge resolves the caller's tenant from. */
  readonly tenantHeader?: string;
  /** Allow open self-registration on the user pool (default false). */
  readonly selfSignUpEnabled?: boolean;
}

export class BmkbStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BmkbStackProps = {}) {
    super(scope, id, props);

    const region = this.region;
    // Cross-region inference profile (current, non-EOL). Scopes the chat
    // lambda's InvokeModel IAM grant; agentic retrieval itself uses
    // foundationModelType=MANAGED (Bedrock picks the model).
    const generationModelArn =
      props.generationModelArn ??
      `arn:${this.partition}:bedrock:${region}:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6`;
    const allowedOrigins = props.allowedOrigins ?? ['http://localhost:5173'];
    const tenantHeader = props.tenantHeader ?? 'x-tenant-id';

    const tenantIndexName = 'tenant-index';

    // --- Static hosting (CloudFront + private S3) --------------------------
    // Provisioned first so its CloudFront URL can be folded into the allowed
    // browser origins for both the Cognito hosted-UI callbacks and the REST
    // API CORS. The distribution domain is a synth-time CloudFormation token
    // (Fn::GetAtt DomainName), so referencing it here is safe — no circular
    // dependency, the value just resolves at deploy time.
    const hosting = new HostingConstruct(this, 'Hosting', { baseName: 'bmkb' });

    // The app's browser origins = the configured origins (localhost dev, any
    // custom domains) plus the CloudFront distribution URL. Used as the CORS
    // allow-list (origins never carry a path, so no trailing slash here).
    const appOrigins: readonly string[] = [...allowedOrigins, hosting.url];

    // Cognito matches redirect_uri by EXACT string. The SPA builds its
    // redirect_uri as `window.location.origin + '/'` (a trailing slash), while
    // CloudFront/S3 also serves the app at the bare origin — so register BOTH
    // the slash and no-slash form of every origin as callback/logout URLs.
    // Registering only one form makes the hosted UI reject sign-in with the
    // misleading "Client is not enabled for OAuth2.0 flows" error.
    const withSlashVariants = (origins: readonly string[]): string[] => {
      const urls = new Set<string>();
      for (const origin of origins) {
        const bare = origin.replace(/\/+$/, '');
        urls.add(bare);
        urls.add(`${bare}/`);
      }
      return [...urls];
    };
    const oauthRedirectUrls = withSlashVariants(appOrigins);

    // --- Durable state -----------------------------------------------------
    const storage = new StorageConstruct(this, 'Storage', { tenantIndexName });

    // --- Managed Knowledge Base (Bedrock-managed vector store) -------------
    const kb = new KnowledgeBaseConstruct(this, 'Kb', {
      baseName: 'bmkb',
      documentsBucket: storage.documentsBucket,
    });

    // --- Messaging ---------------------------------------------------------
    // Visibility timeout must cover the worker timeout (5 min) + margin.
    const messaging = new MessagingConstruct(this, 'Messaging', {
      visibilityTimeout: cdk.Duration.minutes(6),
    });

    // --- Shared lambda env -------------------------------------------------
    const commonEnv: Record<string, string> = {
      KB_ID: kb.knowledgeBaseId,
      DATA_SOURCE_ID: kb.dataSourceId,
      GENERATION_MODEL_ARN: generationModelArn,
      DOCUMENTS_BUCKET: storage.documentsBucket.bucketName,
      INGEST_QUEUE_URL: messaging.ingestQueue.queueUrl,
      INGEST_DLQ_URL: messaging.ingestDlq.queueUrl,
      STATUS_TABLE: storage.statusTable.tableName,
      TENANT_INDEX: tenantIndexName,
      RATE_TABLE: storage.rateTable.tableName,
      INGEST_BATCH_MAX: String(DEFAULT_INGEST_BATCH_MAX),
      INGEST_MAX_TPS: String(DEFAULT_INGEST_MAX_TPS),
      INGEST_MAX_CONCURRENCY: String(DEFAULT_INGEST_MAX_CONCURRENCY),
      INLINE_MAX_BYTES: String(DEFAULT_INLINE_MAX_BYTES),
      S3_MAX_FILE_BYTES: String(DEFAULT_S3_MAX_FILE_BYTES),
      TENANT_METADATA_KEY,
      TENANT_HEADER: tenantHeader,
      // SDK clients pin the region explicitly; never widen at runtime.
      AWS_BEDROCK_REGION: region,
      // Account id — chat builds account-scoped inference-profile ARNs for
      // user-selected generation models (see @bmkb/common resolveModelArn).
      BEDROCK_ACCOUNT_ID: this.account,
    };

    // --- Identity (Cognito) ------------------------------------------------
    // Cognito is the IdP. The hosted-UI callback/logout URLs are the allowed
    // browser origins (the CloudFront distribution URL once wired) plus a
    // localhost dev entry. The chat tenant resolver reads the `sub` claim from
    // the validated JWT to scope retrieval to the calling user's own documents.
    const auth = new AuthConstruct(this, 'Auth', {
      domainPrefix: 'bmkb-doc-chat',
      callbackUrls: oauthRedirectUrls,
      logoutUrls: oauthRedirectUrls,
      ...(props.selfSignUpEnabled !== undefined
        ? { selfSignUpEnabled: props.selfSignUpEnabled }
        : {}),
    });
    const authorizer = auth.buildApiAuthorizer(this, 'ApiAuthorizer');

    // --- API + lambdas -----------------------------------------------------
    // The Cognito authorizer is attached to every data method, so requests must
    // carry a valid Cognito JWT (COGNITO_USER_POOLS). If it were ever omitted,
    // ApiConstruct falls back to AWS_IAM (SigV4) — never NONE — so the API still
    // fails closed to anonymous callers.
    const apiConstruct = new ApiConstruct(this, 'Api', {
      commonEnv,
      ingestQueue: messaging.ingestQueue,
      allowedOrigins: appOrigins,
      tenantHeader,
      authorizer,
      // Stay under the F4 account-wide cap of 10 concurrent Ingest+Delete.
      workerReservedConcurrency: DEFAULT_INGEST_MAX_CONCURRENCY,
    });

    // --- Least-privilege IAM ----------------------------------------------
    // upload: write PENDING status, atomic rate counter, presign+PUT S3 object,
    // enqueue IngestJob.
    storage.grantStatusReadWrite(apiConstruct.uploadFn);
    storage.grantRateCounter(apiConstruct.uploadFn);
    storage.documentsBucket.grantPut(apiConstruct.uploadFn);
    messaging.ingestQueue.grantSendMessages(apiConstruct.uploadFn);

    // ingest-worker: read/write status, atomic rate counter, read S3 objects
    // for the S3 ingest path, ingest into the KB, and on retry/failure manage
    // SQS message lifecycle (consume + DLQ via partial-batch responses).
    storage.grantStatusReadWrite(apiConstruct.ingestWorkerFn);
    storage.grantRateCounter(apiConstruct.ingestWorkerFn);
    storage.documentsBucket.grantRead(apiConstruct.ingestWorkerFn);
    kb.grantIngest(apiConstruct.ingestWorkerFn);
    // Event source wiring already grants consume; explicit DLQ send for safety.
    messaging.ingestDlq.grantSendMessages(apiConstruct.ingestWorkerFn);

    // status: read status rows (incl. tenant GSI) + reconcile against the KB,
    // lazily persisting PENDING→terminal transitions (needs UpdateItem).
    storage.grantStatusReconcile(apiConstruct.statusFn);
    kb.grantStatusRead(apiConstruct.statusFn);
    kb.grantIngest(apiConstruct.statusFn);

    // status sweep: same reconcile grants (read + UpdateItem + KB read). The
    // scheduled sweep additionally Scans the table for PENDING rows — grantReadData
    // (included in grantStatusReconcile) already covers dynamodb:Scan.
    storage.grantStatusReconcile(apiConstruct.statusSweepFn);
    kb.grantStatusRead(apiConstruct.statusSweepFn);

    // chat: Retrieve + RetrieveAndGenerate scoped to the KB + invoke the
    // generation model. No DynamoDB/S3 access — chat reads nothing local.
    kb.grantRetrieve(apiConstruct.chatFn, generationModelArn);

    // --- Alarms ------------------------------------------------------------
    // Wire an SNS/chat-ops action onto these as an operational follow-up; the
    // alarms alone make failures visible in the console/dashboards.
    new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmDescription:
        'bmkb: ingest DLQ has messages — documents permanently failed ingestion',
      metric: messaging.ingestDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'IngestWorkerErrorsAlarm', {
      alarmDescription: 'bmkb: ingest-worker lambda errors',
      metric: apiConstruct.ingestWorkerFn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      alarmDescription: 'bmkb: REST API 5XX responses',
      metric: apiConstruct.api.metricServerError({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // --- Outputs -----------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiBaseUrl', {
      value: apiConstruct.apiBaseUrl,
      description: 'REST API base URL (written into the frontend config.json as apiBase).',
    });
    new cdk.CfnOutput(this, 'BucketName', {
      value: storage.documentsBucket.bucketName,
      description: 'Documents S3 bucket (S3 ingest path source-of-truth).',
    });
    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: kb.knowledgeBaseId,
      description: 'Managed KB id (KB_ID) — created by the custom resource.',
    });
    new cdk.CfnOutput(this, 'DataSourceId', {
      value: kb.dataSourceId,
      description: 'CUSTOM-connector data source id (DATA_SOURCE_ID).',
    });
    new cdk.CfnOutput(this, 'TableName', {
      value: storage.statusTable.tableName,
      description: 'DynamoDB document status table (STATUS_TABLE).',
    });
    new cdk.CfnOutput(this, 'RateTableName', {
      value: storage.rateTable.tableName,
      description: 'DynamoDB rate/concurrency counter table (RATE_TABLE).',
    });
    new cdk.CfnOutput(this, 'QueueUrl', {
      value: messaging.ingestQueue.queueUrl,
      description: 'SQS FIFO ingest queue URL (INGEST_QUEUE_URL).',
    });
    new cdk.CfnOutput(this, 'DlqUrl', {
      value: messaging.ingestDlq.queueUrl,
      description: 'SQS FIFO ingest DLQ URL (INGEST_DLQ_URL).',
    });

    // --- Cognito outputs (informational; the frontend reads these from
    // config.json, not from these outputs — they aid CLI/debugging only) -----
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: auth.userPool.userPoolId,
      description: 'Cognito User Pool id (also written into frontend config.json).',
    });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: auth.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool SPA client id (also written into frontend config.json).',
    });
    new cdk.CfnOutput(this, 'UserPoolDomain', {
      value: auth.hostedUiBaseUrl,
      description: 'Cognito hosted-UI base URL (also written into frontend config.json).',
    });
    new cdk.CfnOutput(this, 'CognitoRegion', {
      value: region,
      description: 'AWS region of the Cognito User Pool.',
    });

    // --- Hosting outputs (informational; frontend is deployed automatically
    // by `cdk deploy` — these aid manual invalidation / debugging only) ------
    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: hosting.bucket.bucketName,
      description: 'Private S3 bucket holding the built frontend (deployed by cdk deploy).',
    });
    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: hosting.url,
      description: 'CloudFront distribution URL serving the frontend (open this to use the app).',
    });
    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: hosting.distributionId,
      description:
        'CloudFront distribution id (use with `aws cloudfront create-invalidation`).',
    });

    // --- Atomic frontend deploy (bundle + runtime config together) ---------
    // Called LAST, after Cognito + API exist, so config.json is written from
    // the LIVE stack values (API base, user-pool issuer, SPA client id, hosted
    // UI domain). The built SPA and the config.json it fetches at startup are
    // uploaded by the same deploy, so they can never drift — this is what
    // eliminates the stale-bundle / stale-config class of failures. No env file
    // is baked into the bundle; a plain `cdk deploy` yields a working frontend
    // with zero manual config steps. Synth stays robust when frontend/dist is
    // absent (deployFrontend no-ops with a warning).
    hosting.deployFrontend({
      apiBase: apiConstruct.apiBaseUrl,
      cognito: {
        authority: `https://cognito-idp.${region}.amazonaws.com/${auth.userPool.userPoolId}`,
        clientId: auth.userPoolClient.userPoolClientId,
        domain: auth.hostedUiBaseUrl,
      },
    });
  }
}
