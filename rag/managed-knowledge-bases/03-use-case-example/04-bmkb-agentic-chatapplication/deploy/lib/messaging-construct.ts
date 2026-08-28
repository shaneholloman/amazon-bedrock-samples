import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * MessagingConstruct — the ingest queue between the upload lambda and the
 * ingest-worker.
 *
 * FIFO with content-based dedup: documentId is deterministic/idempotent
 * (see @bmkb/common document-id), so re-submitting the same document inside the
 * dedup window is collapsed. MessageGroupId is set per-tenant by the producer
 * so one tenant's backlog can't head-of-line-block another's, while ordering
 * within a tenant is preserved.
 *
 * A FIFO DLQ captures messages that exhaust maxReceiveCount; the worker isolates
 * partial-batch failures so only genuinely-bad documents land here.
 */
export interface MessagingConstructProps {
  /** SQS visibility timeout. Must be >= the worker lambda timeout. */
  readonly visibilityTimeout: cdk.Duration;
}

export class MessagingConstruct extends Construct {
  public readonly ingestQueue: sqs.Queue;
  public readonly ingestDlq: sqs.Queue;
  public readonly queueKey: kms.Key;

  constructor(scope: Construct, id: string, props: MessagingConstructProps) {
    super(scope, id);

    // Customer-managed key for SQS encryption at rest (CKV_AWS_27), with annual
    // rotation. Shared by the queue and its DLQ.
    this.queueKey = new kms.Key(this, 'QueueKey', {
      description: 'bmkb-doc-chat — CMK for SQS ingest queue encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.ingestDlq = new sqs.Queue(this, 'IngestDlq', {
      fifo: true,
      contentBasedDeduplication: true,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.queueKey,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.ingestQueue = new sqs.Queue(this, 'IngestQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: this.queueKey,
      enforceSSL: true,
      visibilityTimeout: props.visibilityTimeout,
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: {
        queue: this.ingestDlq,
        // A failing document gets a few attempts (transient throttle/5xx) before
        // it is parked in the DLQ for inspection.
        maxReceiveCount: 5,
      },
    });
  }
}
