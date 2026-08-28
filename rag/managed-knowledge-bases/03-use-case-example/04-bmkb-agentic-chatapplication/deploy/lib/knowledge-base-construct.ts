import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import type { Bucket } from 'aws-cdk-lib/aws-s3';

/**
 * KnowledgeBaseConstruct — provisions a Bedrock Managed Knowledge Base and a
 * custom connector data source using native CloudFormation resources.
 *
 * With type=MANAGED and no storageConfiguration, Bedrock fully manages the
 * vector store and embeddings. There is no OpenSearch collection to own.
 *
 * The custom connector data source (ManagedKnowledgeBaseConnector + CUSTOM)
 * enables direct inline ingestion via IngestKnowledgeBaseDocuments.
 */
export interface KnowledgeBaseConstructProps {
  /** Short, lowercase base name for the KB + data source. */
  readonly baseName: string;
  /** Documents bucket the KB role may read for the S3 ingest path. */
  readonly documentsBucket: Bucket;
}

export class KnowledgeBaseConstruct extends Construct {
  public readonly role: iam.Role;
  public readonly knowledgeBaseId: string;
  public readonly dataSourceId: string;
  public readonly knowledgeBaseArn: string;

  constructor(scope: Construct, id: string, props: KnowledgeBaseConstructProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const kbName = `${props.baseName}-mkb`;
    const dsName = `${props.baseName}-custom-ds`;

    // --- KB service role ---
    // Trusts bedrock.amazonaws.com with confused-deputy guards.
    // NO aoss:* — there is no OpenSearch.
    this.role = new iam.Role(this, 'KbRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: {
            'aws:SourceArn': `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:knowledge-base/*`,
          },
        },
      }),
      description: 'Bedrock Managed Knowledge Base service role',
    });

    // Managed embedding/rerank models are Bedrock-owned foundation models.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeManagedModels',
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:${stack.partition}:bedrock:${stack.region}::foundation-model/*`],
      }),
    );

    // Read documents for the S3 ingest path.
    props.documentsBucket.grantRead(this.role);

    // --- Managed Knowledge Base (native CloudFormation) ---
    const kb = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: kbName,
      roleArn: this.role.roleArn,
      description:
        'Bedrock Managed Knowledge Base — multi-tenant via inline metadata + explicit equals filter',
      knowledgeBaseConfiguration: {
        type: 'MANAGED',
        managedKnowledgeBaseConfiguration: {},
      },
    });
    kb.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    this.knowledgeBaseArn = kb.attrKnowledgeBaseArn;

    // --- Custom connector data source (native CloudFormation) ---
    const ds = new bedrock.CfnDataSource(this, 'DataSource', {
      knowledgeBaseId: this.knowledgeBaseId,
      name: dsName,
      description:
        'Custom connector — inline (≤6 MB) and S3-reference ingest via IngestKnowledgeBaseDocuments',
      dataSourceConfiguration: {
        type: 'MANAGED_KNOWLEDGE_BASE_CONNECTOR',
        managedKnowledgeBaseConnectorConfiguration: {
          connectorParameters: {
            type: 'CUSTOM',
            version: '1',
            aclEnabled: false,
          },
        },
      },
    });
    ds.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    ds.addDependency(kb);

    this.dataSourceId = ds.attrDataSourceId;
  }

  /**
   * Grant Bedrock document/ingestion actions scoped to this KB.
   */
  public grantIngest(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'KbIngest',
        actions: [
          'bedrock:IngestKnowledgeBaseDocuments',
          'bedrock:GetKnowledgeBaseDocuments',
          'bedrock:ListKnowledgeBaseDocuments',
          'bedrock:DeleteKnowledgeBaseDocuments',
          'bedrock:StartIngestionJob',
        ],
        resources: [this.knowledgeBaseArn],
      }),
    );
  }

  /** Grant read/reconcile actions for the status path. */
  public grantStatusRead(grantee: iam.IGrantable): void {
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'KbStatusRead',
        actions: [
          'bedrock:GetKnowledgeBaseDocuments',
          'bedrock:ListKnowledgeBaseDocuments',
        ],
        resources: [this.knowledgeBaseArn],
      }),
    );
  }

  /**
   * Grant Retrieve + AgenticRetrieve for the chat path, plus InvokeModel
   * on the generation model.
   */
  public grantRetrieve(grantee: iam.IGrantable, generationModelArn: string): void {
    const stack = cdk.Stack.of(this);

    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'KbRetrieve',
        actions: ['bedrock:Retrieve'],
        resources: [this.knowledgeBaseArn],
      }),
    );

    // AgenticRetrieveStream authorizes against `*` (spans multiple retrievers).
    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'KbAgenticRetrieve',
        actions: ['bedrock:AgenticRetrieve', 'bedrock:AgenticRetrieveStream'],
        resources: ['*'],
      }),
    );

    grantee.grantPrincipal.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeGenerationModel',
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:GetInferenceProfile',
        ],
        resources: [
          generationModelArn,
          `arn:${stack.partition}:bedrock:*::foundation-model/anthropic.*`,
          `arn:${stack.partition}:bedrock:*::foundation-model/amazon.*`,
          `arn:${stack.partition}:bedrock:*::foundation-model/qwen.*`,
          `arn:${stack.partition}:bedrock:*::foundation-model/deepseek.*`,
          `arn:${stack.partition}:bedrock:*::foundation-model/mistral.*`,
          `arn:${stack.partition}:bedrock:*::foundation-model/openai.*`,
          `arn:${stack.partition}:bedrock:*:${stack.account}:inference-profile/*`,
        ],
      }),
    );
  }
}
