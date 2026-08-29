# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of
# this software and associated documentation files (the "Software"), to deal in
# the Software without restriction, including without limitation the rights to
# use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
# the Software, and to permit persons to whom the Software is furnished to do so.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
# FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
# IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
# CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

"""
Stack 1 of 4 — the data layer.

Creates one S3 bucket holding two corpora under separate prefixes, two
**fully-managed** Bedrock Knowledge Bases (``Type: MANAGED`` — no OpenSearch
collection, no OCU line item, no index to define), their managed data-source
connectors, and a custom resource that runs the initial ingestion sync.

Three things CDK does for us that the CloudFormation sibling had to hand-roll:

* ``BucketDeployment`` uploads the corpora, so the ingestion custom resource only
  has to *ingest* — it no longer doubles as an uploader.
* ``auto_delete_objects`` empties the versioned bucket on stack delete, replacing
  a hand-written ``list_object_versions`` loop.
* The ``Provider`` framework splits "start the job" from "is it done yet",
  so no Lambda sits blocked for 15 minutes polling, and the CloudFormation
  response protocol is handled for us instead of vendored over ``urllib``.
"""

from pathlib import Path

from constructs import Construct

import aws_cdk as cdk
from aws_cdk import (
    Stack,
    CfnOutput,
    Duration,
    RemovalPolicy,
    aws_s3 as s3,
    aws_s3_deployment as s3deploy,
    aws_iam as iam,
    aws_lambda as lambda_,
    aws_logs as logs,
    custom_resources as cr,
)
from aws_cdk.aws_bedrock import CfnKnowledgeBase, CfnDataSource

from config import EnvSettings, KbConfig

ROOT = Path(__file__).resolve().parent.parent


class KnowledgeBasesStack(Stack):
    """S3 corpora + two managed KBs + data sources + initial ingestion."""

    def __init__(self, scope: Construct, construct_id: str, **kwargs) -> None:
        super().__init__(scope, construct_id, **kwargs)

        project = EnvSettings.PROJECT_NAME

        # ── Shared source bucket ──────────────────────────────────────────────
        # One bucket, two prefixes. The data sources are isolated by
        # inclusionPrefixes so each KB indexes only its own corpus.
        self.source_bucket = s3.Bucket(
            self,
            "SourceBucket",
            bucket_name=f"{project}-kb-src-{self.account}-{self.region}",
            encryption=s3.BucketEncryption.S3_MANAGED,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
            enforce_ssl=True,
            versioned=True,
            # Sample hygiene: the bucket and every version in it go away with the
            # stack. For anything you care about, switch to RemovalPolicy.RETAIN.
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
        )

        # ── Upload the bundled corpora ────────────────────────────────────────
        # One deployment per prefix so each KB's data source sees only its corpus.
        financial_upload = s3deploy.BucketDeployment(
            self,
            "FinancialCorpus",
            sources=[s3deploy.Source.asset(str(ROOT / "data" / "financial"))],
            destination_bucket=self.source_bucket,
            destination_key_prefix=KbConfig.FINANCIAL_PREFIX,
            retain_on_delete=False,
            log_group=self._log_group("FinancialCorpusLogs"),
        )
        weather_upload = s3deploy.BucketDeployment(
            self,
            "WeatherCorpus",
            sources=[s3deploy.Source.asset(str(ROOT / "data" / "weather"))],
            destination_bucket=self.source_bucket,
            destination_key_prefix=KbConfig.WEATHER_PREFIX,
            retain_on_delete=False,
            log_group=self._log_group("WeatherCorpusLogs"),
        )

        # ── KB execution role ─────────────────────────────────────────────────
        # Assumed by the Bedrock service. The confused-deputy conditions scope the
        # trust to this account's knowledge bases. A managed-embedding KB needs no
        # bedrock:InvokeModel grant — the embedding model is bundled.
        self.kb_role = iam.Role(
            self,
            "KnowledgeBaseRole",
            role_name=f"{project}-kb-role",
            description=f"Execution role for {project} managed knowledge bases",
            max_session_duration=Duration.hours(1),
            assumed_by=iam.ServicePrincipal(
                "bedrock.amazonaws.com",
                conditions={
                    "StringEquals": {"aws:SourceAccount": self.account},
                    "ArnLike": {
                        "aws:SourceArn": f"arn:{self.partition}:bedrock:{self.region}:{self.account}:knowledge-base/*"
                    },
                },
            ),
        )
        self.kb_role.add_to_policy(
            iam.PolicyStatement(
                sid="CloudWatchWrite",
                actions=["cloudwatch:PutMetricData"],
                resources=["*"],
                conditions={
                    "StringEquals": {"cloudwatch:namespace": "AWS/Bedrock/KnowledgeBases"}
                },
            )
        )
        self.kb_role.add_to_policy(
            iam.PolicyStatement(
                sid="S3ListBucket",
                actions=["s3:ListBucket"],
                resources=[self.source_bucket.bucket_arn],
                conditions={"StringEquals": {"aws:ResourceAccount": self.account}},
            )
        )
        self.kb_role.add_to_policy(
            iam.PolicyStatement(
                sid="S3GetObject",
                actions=["s3:GetObject"],
                resources=[self.source_bucket.arn_for_objects("*")],
                conditions={"StringEquals": {"aws:ResourceAccount": self.account}},
            )
        )

        # Custom embedding is the only case that needs a model grant.
        if KbConfig.EMBEDDING_MODEL_TYPE == "CUSTOM":
            if not KbConfig.CUSTOM_EMBEDDING_MODEL_ARN:
                raise ValueError(
                    "KbConfig.EMBEDDING_MODEL_TYPE is 'CUSTOM' but "
                    "CUSTOM_EMBEDDING_MODEL_ARN is not set. Supply a direct "
                    "foundation-model ARN (inference-profile ARNs are rejected)."
                )
            self.kb_role.add_to_policy(
                iam.PolicyStatement(
                    sid="InvokeEmbeddingModel",
                    actions=["bedrock:InvokeModel"],
                    resources=[KbConfig.CUSTOM_EMBEDDING_MODEL_ARN],
                )
            )

        # ── The two managed knowledge bases ───────────────────────────────────
        self.financial_kb, self.financial_ds = self._managed_kb(
            "Financial",
            theme="financial",
            description="Synthetic financial corpus (Octank 10-K). Managed KB.",
            prefix=KbConfig.FINANCIAL_PREFIX,
        )
        self.weather_kb, self.weather_ds = self._managed_kb(
            "Weather",
            theme="weather",
            description="Public U.S. CRS weather corpus (tornadoes report, IF12695). Managed KB.",
            prefix=KbConfig.WEATHER_PREFIX,
        )

        # ── Initial ingestion sync ────────────────────────────────────────────
        # StartIngestionJob has no CloudFormation resource, so this is the one place
        # the data layer needs a custom resource. It starts a job per data source and
        # polls to a terminal state via the Provider's isComplete handler.
        ingest = self._ingest_provider()
        sync = cdk.CustomResource(
            self,
            "IngestSync",
            service_token=ingest.service_token,
            resource_type="Custom::IngestSync",
            properties={
                # "<kbId>|<dataSourceId>" pairs — one per data source to sync.
                "Ingestions": [
                    f"{self.financial_kb.attr_knowledge_base_id}|{self.financial_ds.attr_data_source_id}",
                    f"{self.weather_kb.attr_knowledge_base_id}|{self.weather_ds.attr_data_source_id}",
                ],
            },
        )
        # Nothing to ingest until the corpora have actually landed in the bucket.
        sync.node.add_dependency(financial_upload)
        sync.node.add_dependency(weather_upload)

        # ── Outputs ───────────────────────────────────────────────────────────
        CfnOutput(self, "SourceBucketName", value=self.source_bucket.bucket_name,
                  description="S3 bucket holding both KB corpora.")
        CfnOutput(self, "FinancialKnowledgeBaseId", value=self.financial_kb.attr_knowledge_base_id,
                  description="Financial (Octank 10-K) managed KB ID.")
        CfnOutput(self, "WeatherKnowledgeBaseId", value=self.weather_kb.attr_knowledge_base_id,
                  description="Weather (tornadoes) managed KB ID.")
        CfnOutput(self, "KnowledgeBaseRoleArn", value=self.kb_role.role_arn,
                  description="Shared KB execution role ARN.")

    # ──────────────────────────────────────────────────────────────────────────
    def _managed_kb(self, cid: str, theme: str, description: str, prefix: str):
        """Create one managed KB plus its S3-connector data source."""
        project = EnvSettings.PROJECT_NAME

        # A managed KB carries no vector-store configuration at all — contrast with a
        # customer-managed KB, which needs a collection, an index, and field mappings.
        managed_config = {"embedding_model_type": KbConfig.EMBEDDING_MODEL_TYPE}
        if KbConfig.EMBEDDING_MODEL_TYPE == "CUSTOM":
            managed_config["embedding_model_arn"] = KbConfig.CUSTOM_EMBEDDING_MODEL_ARN

        kb = CfnKnowledgeBase(
            self,
            f"{cid}KnowledgeBase",
            name=f"{project}-{theme}",
            description=description,
            role_arn=self.kb_role.role_arn,
            knowledge_base_configuration=CfnKnowledgeBase.KnowledgeBaseConfigurationProperty(
                type="MANAGED",
                managed_knowledge_base_configuration=CfnKnowledgeBase.ManagedKnowledgeBaseConfigurationProperty(
                    **managed_config
                ),
            ),
            tags={"Project": project, "Theme": theme},
        )
        kb.node.add_dependency(self.kb_role)

        data_source = CfnDataSource(
            self,
            f"{cid}DataSource",
            name=f"{project}-{theme}-s3",
            knowledge_base_id=kb.attr_knowledge_base_id,
            data_deletion_policy="DELETE",
            data_source_configuration=CfnDataSource.DataSourceConfigurationProperty(
                type="MANAGED_KNOWLEDGE_BASE_CONNECTOR",
                managed_knowledge_base_connector_configuration=CfnDataSource.ManagedKnowledgeBaseConnectorConfigurationProperty(
                    # connector_parameters is free-form JSON passed straight to the
                    # connector, so these keys stay camelCase — CDK does not convert them.
                    connector_parameters={
                        "type": "S3",
                        "version": "1",
                        "connectionConfiguration": {
                            "bucketName": self.source_bucket.bucket_name,
                            "bucketOwnerAccountId": self.account,
                        },
                        "filterConfiguration": {"inclusionPrefixes": [prefix]},
                        "deletionProtectionConfiguration": {
                            "enableDeletionProtection": False
                        },
                    },
                ),
            ),
        )
        return kb, data_source

    # ──────────────────────────────────────────────────────────────────────────
    def _ingest_provider(self) -> cr.Provider:
        """Provider that starts an ingestion job per data source and polls it."""
        on_event = lambda_.Function(
            self,
            "IngestSyncOnEvent",
            function_name=f"{EnvSettings.PROJECT_NAME}-ingest-start",
            description="Starts the initial KB ingestion job for each data source.",
            runtime=lambda_.Runtime.PYTHON_3_13,
            handler="index.on_event",
            code=lambda_.Code.from_asset(str(ROOT / "lambdas" / "ingest_sync")),
            timeout=Duration.minutes(5),
            log_group=self._log_group("IngestSyncOnEventLogs"),
        )
        is_complete = lambda_.Function(
            self,
            "IngestSyncIsComplete",
            function_name=f"{EnvSettings.PROJECT_NAME}-ingest-poll",
            description="Polls the KB ingestion jobs to a terminal state.",
            runtime=lambda_.Runtime.PYTHON_3_13,
            handler="index.is_complete",
            code=lambda_.Code.from_asset(str(ROOT / "lambdas" / "ingest_sync")),
            timeout=Duration.minutes(2),
            log_group=self._log_group("IngestSyncIsCompleteLogs"),
        )
        for fn in (on_event, is_complete):
            fn.add_to_role_policy(
                iam.PolicyStatement(
                    sid="BedrockIngestion",
                    actions=[
                        "bedrock:StartIngestionJob",
                        "bedrock:GetIngestionJob",
                        "bedrock:ListIngestionJobs",
                    ],
                    resources=[
                        f"arn:{self.partition}:bedrock:{self.region}:{self.account}:knowledge-base/*"
                    ],
                )
            )

        return cr.Provider(
            self,
            "IngestSyncProvider",
            on_event_handler=on_event,
            is_complete_handler=is_complete,
            query_interval=Duration.seconds(30),
            total_timeout=Duration.minutes(30),
            log_group=self._log_group("IngestSyncProviderLogs"),
        )

    # ──────────────────────────────────────────────────────────────────────────
    def _log_group(self, cid: str) -> logs.LogGroup:
        """A short-retention log group that goes away with the stack.

        Deployment-helper Lambdas default to never-expiring log groups that also
        survive the stack, which leaves litter behind after a sample is torn down.
        """
        return logs.LogGroup(
            self, cid,
            retention=logs.RetentionDays.ONE_WEEK,
            removal_policy=RemovalPolicy.DESTROY,
        )
