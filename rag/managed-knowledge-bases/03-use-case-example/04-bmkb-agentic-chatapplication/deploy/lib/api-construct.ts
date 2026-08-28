import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve `<repo>/lambda`. This file runs either from source (`deploy/lib`)
 * or compiled (`deploy/dist/lib`); walk up from here until the directory holding
 * `lambda` is found so the entry path is correct in both cases.
 */
function resolveLambdasRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'lambda');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate lambda/ walking up from ${__dirname}`);
}

const LAMBDAS_ROOT = resolveLambdasRoot();

function lambdaEntry(name: string): string {
  return path.join(LAMBDAS_ROOT, name, 'src', 'index.ts');
}

/**
 * ApiConstruct — the four NodejsFunction lambdas (upload, ingest-worker, chat,
 * status) and the REST API that fronts the HTTP-triggered three.
 *
 *  - All lambdas are ESM, Node 20, bundled with esbuild, @bmkb/common inlined.
 *  - The ingest-worker is NOT on the API; it is wired to the SQS ingest queue
 *    with partial-batch responses so one bad document doesn't fail the batch.
 *  - CORS is scoped to the configured frontend origins and the tenant header.
 *  - IAM grants are wired by the stack via the exposed function handles, so this
 *    construct stays least-privilege-agnostic (it only declares env + runtime).
 */
export interface ApiConstructProps {
  /** Shared lambda environment (KB ids, table/queue names, limits). */
  readonly commonEnv: Readonly<Record<string, string>>;
  /** SQS queue the upload lambda publishes to and the worker consumes. */
  readonly ingestQueue: sqs.IQueue;
  /** Allowed CORS origins for the browser app. */
  readonly allowedOrigins: readonly string[];
  /** Tenant header the authorizer/edge resolves the tenant from. */
  readonly tenantHeader: string;
  /**
   * Authorizer applied to every data method (/upload, /status, /chat). The API
   * contract requires every request to be authenticated and the caller's tenant
   * to be resolved server-side (see README → API reference), so the methods MUST NOT
   * be left open. When an authorizer is supplied it is attached with
   * `authorizationType = CUSTOM/COGNITO`; otherwise the methods fall back to
   * `AWS_IAM` (SigV4) so the API still fails closed to anonymous callers — it is
   * never `NONE`. Pass a JWT/Cognito authorizer here in real environments. */
  readonly authorizer?: apigw.IAuthorizer;
  /** Worker reserved concurrency — a hard ceiling well under the F4 account
   *  cap of 10 concurrent Ingest+Delete (the DynamoDB ConcurrencyGate is the
   *  real account-wide guard; this is defense in depth). */
  readonly workerReservedConcurrency: number;
}

export class ApiConstruct extends Construct {
  public readonly uploadFn: lambdaNode.NodejsFunction;
  public readonly ingestWorkerFn: lambdaNode.NodejsFunction;
  public readonly chatFn: lambdaNode.NodejsFunction;
  public readonly statusFn: lambdaNode.NodejsFunction;
  /** Scheduled self-heal sweep (reconciles orphaned PENDING rows). */
  public readonly statusSweepFn: lambdaNode.NodejsFunction;
  public readonly api: apigw.RestApi;
  public readonly apiBaseUrl: string;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    const baseBundling: lambdaNode.BundlingOptions = {
      format: lambdaNode.OutputFormat.ESM,
      target: 'node20',
      minify: true,
      sourceMap: true,
      // Bundle the v3 SDK clients from each lambda's pinned package.json. CDK's
      // NodejsFunction defaults to externalizing `@aws-sdk/*` (assuming the Node
      // 20 runtime provides them), but the runtime's bundled SDK is OLDER and
      // lacks newer commands (e.g. AgenticRetrieveStreamCommand). `externalModules:
      // []` forces everything into the bundle so the pinned version is used.
      externalModules: [],
      mainFields: ['module', 'main'],
      // ESM + require shim for any CJS-only transitive dep.
      banner:
        "import{createRequire}from'module';const require=createRequire(import.meta.url);",
    };

    // Customer-managed key for CloudWatch Logs encryption at rest
    // (CLOUDWATCH_LOG_GROUP_ENCRYPTED). The CloudWatch Logs service principal
    // must be allowed to use the key, scoped to this account/region's log
    // groups via the kms:EncryptionContext condition.
    const logsKey = new kms.Key(this, 'LogsKey', {
      description: 'bmkb-doc-chat — CMK for CloudWatch Logs encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    logsKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [
          new iam.ServicePrincipal(`logs.${cdk.Stack.of(this).region}.amazonaws.com`),
        ],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${cdk.Stack.of(this).partition}:logs:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:log-group:*`,
          },
        },
      }),
    );

    // One explicit, destroy-on-teardown, CMK-encrypted log group per function
    // (avoids the deprecated logRetention custom resource).
    const makeLogGroup = (fnId: string): logs.LogGroup =>
      new logs.LogGroup(this, `${fnId}LogGroup`, {
        retention: logs.RetentionDays.ONE_MONTH,
        encryptionKey: logsKey,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    const baseDefaults = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      tracing: lambda.Tracing.ACTIVE,
      bundling: baseBundling,
    } as const;

    this.uploadFn = new lambdaNode.NodejsFunction(this, 'UploadFn', {
      ...baseDefaults,
      logGroup: makeLogGroup('UploadFn'),
      entry: lambdaEntry('upload'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      environment: { ...props.commonEnv },
      description: 'POST /upload — validate, route INLINE/S3, presign, enqueue, write PENDING',
    });

    this.statusFn = new lambdaNode.NodejsFunction(this, 'StatusFn', {
      ...baseDefaults,
      logGroup: makeLogGroup('StatusFn'),
      entry: lambdaEntry('status'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: { ...props.commonEnv },
      description: 'GET /status — tenant-scoped status read + KB reconcile',
    });

    // Self-heal sweep: same status bundle, the `sweepHandler` export. Driven by
    // an EventBridge schedule (below), NOT the API — it scans PENDING rows and
    // reconciles the ones no client is polling so a NOT_FOUND-past-grace doc
    // still transitions to FAILED instead of dangling PENDING forever.
    this.statusSweepFn = new lambdaNode.NodejsFunction(this, 'StatusSweepFn', {
      ...baseDefaults,
      logGroup: makeLogGroup('StatusSweepFn'),
      entry: lambdaEntry('status'),
      handler: 'sweepHandler',
      // A full sweep does one Scan + bounded (5-at-a-time) GetKnowledgeBaseDocuments
      // per PENDING row; give generous headroom for a large backlog.
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: { ...props.commonEnv },
      description: 'Scheduled sweep — reconcile orphaned PENDING status rows against the KB',
    });

    // Run the sweep every 15 minutes — aligned with the NOT_FOUND grace window,
    // so an orphaned row is reconciled to FAILED within roughly one grace period
    // of becoming eligible.
    new events.Rule(this, 'StatusSweepSchedule', {
      description: 'bmkb: periodic reconcile of orphaned PENDING document status rows',
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(this.statusSweepFn)],
    });

    this.chatFn = new lambdaNode.NodejsFunction(this, 'ChatFn', {
      ...baseDefaults,
      logGroup: makeLogGroup('ChatFn'),
      entry: lambdaEntry('chat'),
      handler: 'handler',
      // RetrieveAndGenerate can be slow; keep under API GW's 29s integration cap.
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      environment: { ...props.commonEnv },
      description: 'POST /chat — RetrieveAndGenerate with explicit tenant equals filter',
    });

    this.ingestWorkerFn = new lambdaNode.NodejsFunction(this, 'IngestWorkerFn', {
      ...baseDefaults,
      logGroup: makeLogGroup('IngestWorkerFn'),
      entry: lambdaEntry('ingest-worker'),
      handler: 'handler',
      // Batch of <=10 docs under the token bucket; allow headroom for retries.
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      reservedConcurrentExecutions: props.workerReservedConcurrency,
      environment: { ...props.commonEnv },
      description: 'SQS ingest worker — batch<=10, <=5 TPS, account concurrency gate, DLQ',
    });

    // Worker consumes the ingest queue. Partial-batch responses isolate the
    // failed document so the rest of the batch still succeeds.
    this.ingestWorkerFn.addEventSource(
      // No maxBatchingWindow: FIFO queues do not support a batching window.
      new SqsEventSource(props.ingestQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    // --- REST API ---
    // Dedicated access-log group for the stage (CKV_AWS_76). Captures one JSON
    // line per request (caller, latency, status) for audit and debugging.
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey: logsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.api = new apigw.RestApi(this, 'RestApi', {
      restApiName: 'bmkb-doc-chat-api',
      description: 'bmkb-doc-chat edge — /upload /status /chat',
      deployOptions: {
        stageName: 'prod',
        tracingEnabled: true,
        loggingLevel: apigw.MethodLoggingLevel.INFO,
        metricsEnabled: true,
        throttlingRateLimit: 50,
        throttlingBurstLimit: 100,
        accessLogDestination: new apigw.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: [...props.allowedOrigins],
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'Authorization',
          props.tenantHeader,
        ],
        allowCredentials: false,
        maxAge: cdk.Duration.hours(1),
      },
      // 6 MB inline upload bodies fit under API GW's 10 MB payload limit.
      minCompressionSize: cdk.Size.kibibytes(1),
    });

    // CORS on ERROR responses. defaultCorsPreflightOptions only adds CORS
    // headers to the OPTIONS preflight and to successful integration responses.
    // When the Cognito authorizer REJECTS a request (expired/absent token), API
    // Gateway returns a built-in GatewayResponse (401/403) that has NO CORS
    // headers — so the browser blocks it and fetch() rejects with an opaque
    // "Failed to fetch", hiding the real 401 from the SPA. Attach CORS headers
    // to the default 4XX/5XX gateway responses so the browser can read the
    // status and the app can react (e.g. re-authenticate on 401). ACAO is '*'
    // because allowCredentials is false (no cookies), matching the preflight.
    const corsErrorHeaders: Record<string, string> = {
      'Access-Control-Allow-Origin': "'*'",
      'Access-Control-Allow-Headers': `'Content-Type,Authorization,${props.tenantHeader}'`,
      'Access-Control-Allow-Methods': "'GET,POST,OPTIONS'",
    };
    this.api.addGatewayResponse('Default4xxCors', {
      type: apigw.ResponseType.DEFAULT_4XX,
      responseHeaders: corsErrorHeaders,
    });
    this.api.addGatewayResponse('Default5xxCors', {
      type: apigw.ResponseType.DEFAULT_5XX,
      responseHeaders: corsErrorHeaders,
    });

    // Fail closed: never leave a data method on AuthorizationType=NONE. If a
    // JWT/Cognito authorizer is supplied use it; otherwise require SigV4
    // (AWS_IAM) so anonymous callers cannot invoke the API or spoof the tenant
    // header. The CORS preflight (OPTIONS) is added separately by
    // defaultCorsPreflightOptions and stays unauthenticated, as the spec
    // requires.
    const methodAuth: apigw.MethodOptions = props.authorizer
      ? {
          authorizer: props.authorizer,
          // Be explicit: a Cognito authorizer drives COGNITO_USER_POOLS auth.
          // (CDK infers it from the authorizer, but pin it so the method never
          // silently lands on NONE if the authorizer type changes.)
          authorizationType:
            props.authorizer.authorizationType ??
            apigw.AuthorizationType.COGNITO,
        }
      : { authorizationType: apigw.AuthorizationType.IAM };

    const upload = this.api.root.addResource('upload');
    upload.addMethod('POST', new apigw.LambdaIntegration(this.uploadFn), methodAuth);

    const status = this.api.root.addResource('status');
    status.addMethod('GET', new apigw.LambdaIntegration(this.statusFn), methodAuth);

    const documents = this.api.root.addResource('documents');
    documents.addMethod('GET', new apigw.LambdaIntegration(this.statusFn), methodAuth);
    documents.addMethod('DELETE', new apigw.LambdaIntegration(this.statusFn), methodAuth);

    const chat = this.api.root.addResource('chat');
    chat.addMethod('POST', new apigw.LambdaIntegration(this.chatFn), methodAuth);

    this.apiBaseUrl = this.api.url;
  }
}
