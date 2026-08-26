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
Stack 2 of 4 — the retrieval layer.

One AgentCore Gateway speaking MCP, with one target per knowledge base. Each target
uses the **native ``bedrock-knowledge-bases`` connector**, which means agentic
retrieval runs server-side: there is no Lambda to write and no container to build for
retrieval itself. Each target exposes that KB's ``AgenticRetrieveStream`` as an MCP
tool, and the agent picks between them — that is the semantic-routing story.

Inbound auth is ``AWS_IAM``, so callers sign with SigV4 and no Cognito user pool or
OAuth provider is needed to try the sample.

Agentic retrieval is *only* available on a managed knowledge base; a customer-managed
KB cannot be the source of a connector target like this.
"""

from constructs import Construct

from aws_cdk import (
    Stack,
    CfnOutput,
    aws_iam as iam,
    aws_bedrockagentcore as agentcore,
)
from aws_cdk.aws_bedrock import CfnKnowledgeBase

from config import EnvSettings, GatewayConfig


class AgenticGatewayStack(Stack):
    """AgentCore Gateway + one AgenticRetrieveStream target per managed KB."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        financial_kb: CfnKnowledgeBase,
        weather_kb: CfnKnowledgeBase,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        project = EnvSettings.PROJECT_NAME

        # KB ids arrive as construct references from stack 1. CDK turns these into
        # cross-stack exports on its own, so unlike the CloudFormation sibling there
        # are no Fn::ImportValue names to keep in sync between templates.
        financial_kb_id = financial_kb.attr_knowledge_base_id
        weather_kb_id = weather_kb.attr_knowledge_base_id

        # ── Gateway execution role ────────────────────────────────────────────
        # The gateway assumes this to call the Bedrock KB APIs on the caller's behalf
        # (CredentialProviderType GATEWAY_IAM_ROLE on each target below).
        self.gateway_role = iam.Role(
            self,
            "GatewayRole",
            role_name=f"{project}-gateway-role",
            description=f"Execution role for {project} AgentCore gateway KB targets",
            assumed_by=iam.ServicePrincipal(
                "bedrock-agentcore.amazonaws.com",
                conditions={
                    "StringEquals": {"aws:SourceAccount": self.account},
                    "ArnLike": {
                        "aws:SourceArn": f"arn:{self.partition}:bedrock-agentcore:{self.region}:{self.account}:*"
                    },
                },
            ),
        )
        # AgenticRetrieveStream is not resource-scopable, so it has to be granted on "*".
        self.gateway_role.add_to_policy(
            iam.PolicyStatement(
                sid="AgenticRetrieveStreamUnscoped",
                actions=["bedrock:AgenticRetrieveStream"],
                resources=["*"],
            )
        )
        # The scopable actions are pinned to just these two knowledge bases.
        self.gateway_role.add_to_policy(
            iam.PolicyStatement(
                sid="RetrieveAndDescribeScoped",
                actions=["bedrock:Retrieve", "bedrock:GetKnowledgeBase"],
                resources=[
                    f"arn:{self.partition}:bedrock:{self.region}:{self.account}:knowledge-base/{kb_id}"
                    for kb_id in (financial_kb_id, weather_kb_id)
                ],
            )
        )

        # ── The gateway ───────────────────────────────────────────────────────
        self.gateway = agentcore.CfnGateway(
            self,
            "AgenticGateway",
            name=f"{project}-gateway",
            authorizer_type="AWS_IAM",
            role_arn=self.gateway_role.role_arn,
            protocol_type="MCP",
            protocol_configuration=agentcore.CfnGateway.GatewayProtocolConfigurationProperty(
                mcp=agentcore.CfnGateway.MCPGatewayConfigurationProperty(
                    # SEMANTIC lets the agent search tools by meaning rather than
                    # needing the exact tool name up front.
                    search_type="SEMANTIC",
                ),
            ),
            description="Agentic RAG gateway routing to per-theme managed KBs.",
            tags={"Project": project, "Sample": "bmkb-observability-cdk"},
        )
        self.gateway.node.add_dependency(self.gateway_role)

        # ── One target per KB ─────────────────────────────────────────────────
        self.financial_target = self._kb_target(
            "FinancialTarget",
            name="financial-agentic",
            kb_id=financial_kb_id,
            description=(
                "Agentic retrieval over the synthetic financial (Octank 10-K) KB. "
                "(Octank is a fictional company; corpus is model-generated CC0 sample data.)"
            ),
        )
        self.weather_target = self._kb_target(
            "WeatherTarget",
            name="weather-agentic",
            kb_id=weather_kb_id,
            description="Agentic retrieval over the public U.S. CRS weather (tornadoes, IF12695) KB.",
        )
        # Targets share one gateway, so create them in series — a gateway applies
        # target changes one at a time and rejects concurrent modification.
        self.weather_target.node.add_dependency(self.financial_target)

        # ── Outputs ───────────────────────────────────────────────────────────
        CfnOutput(self, "GatewayId", value=self.gateway.attr_gateway_identifier,
                  description="Gateway identifier.")
        CfnOutput(self, "GatewayUrl", value=self.gateway.attr_gateway_url,
                  description="MCP endpoint URL (consumed by the Runtime agent as GATEWAY_URL).")
        CfnOutput(self, "GatewayArn", value=self.gateway.attr_gateway_arn,
                  description="Gateway ARN (dimension value for Gateway metrics).")
        CfnOutput(self, "GatewayRoleArn", value=self.gateway_role.role_arn,
                  description="Gateway execution role ARN.")

    # ──────────────────────────────────────────────────────────────────────────
    def _kb_target(self, cid: str, name: str, kb_id: str, description: str):
        """One MCP connector target exposing a KB's AgenticRetrieveStream tool."""
        return agentcore.CfnGatewayTarget(
            self,
            cid,
            gateway_identifier=self.gateway.attr_gateway_identifier,
            name=name,
            description=description,
            target_configuration=agentcore.CfnGatewayTarget.TargetConfigurationProperty(
                mcp=agentcore.CfnGatewayTarget.McpTargetConfigurationProperty(
                    connector=agentcore.CfnGatewayTarget.ConnectorTargetConfigurationProperty(
                        # The native KB connector — no Lambda, no container.
                        source=agentcore.CfnGatewayTarget.ConnectorSourceProperty(
                            connector_id="bedrock-knowledge-bases",
                        ),
                        enabled=["AgenticRetrieveStream"],
                        configurations=[
                            agentcore.CfnGatewayTarget.ConnectorConfigurationProperty(
                                name="AgenticRetrieveStream",
                                # parameter_values is free-form JSON handed to the
                                # connector, so these keys stay camelCase.
                                parameter_values={
                                    "retrievers": [
                                        {"configuration": {"knowledgeBase": {"knowledgeBaseId": kb_id}}}
                                    ],
                                    "agenticRetrieveConfiguration": {
                                        # MANAGED for both = bundled service models.
                                        # A custom reranker would be named here — this is
                                        # the query-time hook, not a KB property.
                                        "foundationModelType": GatewayConfig.FOUNDATION_MODEL_TYPE,
                                        "rerankingModelType": GatewayConfig.RERANKING_MODEL_TYPE,
                                    },
                                },
                            )
                        ],
                    ),
                ),
            ),
            credential_provider_configurations=[
                agentcore.CfnGatewayTarget.CredentialProviderConfigurationProperty(
                    credential_provider_type="GATEWAY_IAM_ROLE",
                )
            ],
        )
