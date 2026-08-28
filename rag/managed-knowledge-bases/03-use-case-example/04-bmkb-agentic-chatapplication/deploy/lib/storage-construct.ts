import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * StorageConstruct — durable state for bmkb-doc-chat.
 *
 *  - Data KMS CMK: a single customer-managed key (rotation enabled) used to
 *    encrypt the DynamoDB tables at rest. Customer-managed keys give rotation,
 *    audit, and revocation control that AWS-managed keys do not (CKV_AWS_119).
 *  - Documents S3 bucket: versioned, SSE (S3-managed), public access fully
 *    blocked, TLS-only bucket policy, ownership enforced, server access logging
 *    to a dedicated log bucket, lifecycle rules to expire noncurrent versions
 *    and abort stale multipart uploads. Source-of-truth for the S3 ingest path.
 *  - Access-logs bucket: receives S3 server access logs (CKV_AWS_18); private,
 *    encrypted, TLS-only, with its own retention lifecycle.
 *  - Status table: one item per document (PK documentId), with a tenant GSI so
 *    the status lambda can list a tenant's documents (BatchStatusResponse).
 *    CMK-encrypted + point-in-time recovery on.
 *  - Rate table: holds the account-wide ingest concurrency counter item that
 *    the ConcurrencyGate (see @bmkb/common rate-limiter) increments/decrements
 *    atomically to honor the verified 10-concurrent Ingest+Delete cap (F4).
 */
export interface StorageConstructProps {
  /** Tenant ownership GSI name; lambdas read this from env. */
  readonly tenantIndexName: string;
}

export class StorageConstruct extends Construct {
  public readonly documentsBucket: s3.Bucket;
  public readonly accessLogsBucket: s3.Bucket;
  public readonly statusTable: dynamodb.Table;
  public readonly rateTable: dynamodb.Table;
  public readonly tableKey: kms.Key;
  public readonly tenantIndexName: string;

  constructor(scope: Construct, id: string, props: StorageConstructProps) {
    super(scope, id);

    this.tenantIndexName = props.tenantIndexName;

    // Customer-managed key for table encryption at rest, with automatic annual
    // rotation. RETAIN by default would orphan the key on teardown; this is a
    // sample stack, so DESTROY keeps `cdk destroy` clean.
    this.tableKey = new kms.Key(this, 'DataKey', {
      description: 'bmkb-doc-chat — CMK for DynamoDB table encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Dedicated bucket for S3 server access logs. ACL writes from the S3 log
    // delivery group require BUCKET_OWNER_PREFERRED ownership. The log bucket is
    // itself versioned and TLS-only, and self-logs (prefix below) so there is no
    // un-logged bucket in the stack.
    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogsBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      publicReadAccess: false,
      // Self-logging: the access-log bucket records its own access under a
      // distinct prefix, so every bucket in the stack has access logging.
      serverAccessLogsPrefix: 'self-access-logs/',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: 'expire-access-logs', expiration: cdk.Duration.days(90) }],
    });

    this.documentsBucket = new s3.Bucket(this, 'DocumentsBucket', {
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      publicReadAccess: false,
      // Server access logging to the dedicated log bucket (CKV_AWS_18).
      // Cast to IBucket: under exactOptionalPropertyTypes the concrete Bucket's
      // optional `isWebsite` is not assignable to the IBucket prop directly.
      serverAccessLogsBucket: this.accessLogsBucket as s3.IBucket,
      serverAccessLogsPrefix: 'documents-access-logs/',
      // Sample stack: clean teardown. autoDeleteObjects also clears versions
      // (delete markers) on a versioned bucket so `cdk destroy` empties it.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'abort-incomplete-multipart',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
        {
          id: 'expire-noncurrent-versions',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    this.statusTable = new dynamodb.Table(this, 'StatusTable', {
      partitionKey: { name: 'documentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Tenant-scoped listing for BatchStatusResponse. Projection is ALL so the
    // status lambda can return full DocStatusRecord rows without a follow-up
    // GetItem per document.
    this.statusTable.addGlobalSecondaryIndex({
      indexName: this.tenantIndexName,
      partitionKey: { name: 'tenantId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.rateTable = new dynamodb.Table(this, 'RateTable', {
      partitionKey: { name: 'counterId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.tableKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }

  /**
   * Grant a principal least-privilege read/write on the status table + its GSI
   * and atomic update on the rate counter. The Bedrock KB ingest path reads
   * objects from the documents bucket; that grant is wired by the caller via
   * `grantBedrockRead`.
   */
  public grantStatusReadWrite(grantee: iam.IGrantable): void {
    this.statusTable.grantReadWriteData(grantee);
  }

  public grantStatusReadOnly(grantee: iam.IGrantable): void {
    this.statusTable.grantReadData(grantee);
  }

  /**
   * Read access plus UpdateItem on the base table (not the GSI): the status
   * lambda lazily persists PENDING→INDEXED/FAILED transitions it discovers
   * while reconciling against GetKnowledgeBaseDocuments. Without UpdateItem the
   * reconcile write is denied and rows stay PENDING forever.
   */
  public grantStatusReconcile(grantee: iam.IGrantable): void {
    this.statusTable.grantReadData(grantee);
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resourceArns: [this.statusTable.tableArn],
    });
  }

  public grantRateCounter(grantee: iam.IGrantable): void {
    this.rateTable.grantReadWriteData(grantee);
  }
}
