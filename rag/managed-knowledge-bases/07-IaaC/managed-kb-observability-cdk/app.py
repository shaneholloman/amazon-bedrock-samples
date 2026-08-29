#!/usr/bin/env python3
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
CDK app — end-to-end agentic RAG on fully-managed Bedrock Knowledge Bases.

Four stacks, deployed in dependency order by ``cdk deploy --all``:

    1. KnowledgeBases  S3 + corpora upload + 2 managed KBs + data sources + ingestion
    2. AgenticGateway  AgentCore Gateway (AWS_IAM/MCP) + per-KB AgenticRetrieveStream targets
    3. AgentRuntime    ECR + CodeBuild image + instrumented Strands agent + logs/traces + online eval
    4. Dashboards      2 CloudWatch dashboards spanning seven observability layers

Unlike the CloudFormation sibling of this sample, the stacks are wired by passing
construct references directly — CDK derives the dependency order and the exports, so
there is no ``Fn::ImportValue`` to keep in sync and no fixed deploy sequence to script.
"""

import aws_cdk as cdk

from config import EnvSettings
from stacks.knowledge_bases_stack import KnowledgeBasesStack
from stacks.agentic_gateway_stack import AgenticGatewayStack
from stacks.agent_runtime_stack import AgentRuntimeStack
from stacks.dashboards_stack import DashboardsStack

app = cdk.App()

env = cdk.Environment(
    account=EnvSettings.ACCOUNT_ID,
    region=EnvSettings.ACCOUNT_REGION,
)
project = EnvSettings.PROJECT_NAME

# ── 1. Knowledge bases ────────────────────────────────────────────────────────
kb_stack = KnowledgeBasesStack(
    app, f"{project}-kb", env=env,
    description="Agentic RAG sample [1/4] - S3 corpora + two fully-managed Bedrock Knowledge Bases + ingestion.",
)

# ── 2. Gateway (needs the KB ids) ─────────────────────────────────────────────
gateway_stack = AgenticGatewayStack(
    app, f"{project}-gateway", env=env,
    financial_kb=kb_stack.financial_kb,
    weather_kb=kb_stack.weather_kb,
    description="Agentic RAG sample [2/4] - AgentCore Gateway (AWS_IAM/MCP) with per-KB AgenticRetrieveStream targets.",
)

# ── 3. Agent runtime (needs the gateway URL + ARN) ────────────────────────────
agent_stack = AgentRuntimeStack(
    app, f"{project}-agent", env=env,
    gateway=gateway_stack.gateway,
    description="Agentic RAG sample [3/4] - instrumented Strands agent on AgentCore Runtime + vended telemetry + online evaluation.",
)

# ── 4. Dashboards (need the KB ids + gateway ARN) ─────────────────────────────
DashboardsStack(
    app, f"{project}-dashboards", env=env,
    financial_kb=kb_stack.financial_kb,
    weather_kb=kb_stack.weather_kb,
    gateway=gateway_stack.gateway,
    agent_runtime=agent_stack.agent_runtime,
    description="Agentic RAG sample [4/4] - CloudWatch dashboards for the seven observability layers.",
)

cdk.Tags.of(app).add("Project", project)
cdk.Tags.of(app).add("Sample", "bmkb-observability-cdk")

app.synth()
