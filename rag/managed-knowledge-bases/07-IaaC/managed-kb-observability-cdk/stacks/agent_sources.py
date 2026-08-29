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
The agent's own source, as strings the buildspec writes at build time.

The CodeBuild project has no source input, so the three files that make up the
container image live here and get written by heredocs inside the build. Keeping them
in one module rather than inline in the stack means the agent is readable on its own,
and ``sources_hash`` gives the build-trigger custom resource something to key on:
edit ``AGENT_PY`` and the next ``cdk deploy`` rebuilds the image.

Three files:

``REQUIREMENTS``
    Strands, the SigV4 MCP client, and the OTEL distro that does the instrumenting.
``AGENT_PY``
    An ordinary Strands agent. Nothing in it knows about tracing — the spans that
    carry ``gen_ai.usage`` token counts (observability layer 6) come from the distro.
``DOCKERFILE``
    ARM64 base, non-root user, port 8080, and ``opentelemetry-instrument`` as the
    entrypoint wrapper. That wrapper is the whole instrumentation story.
"""

import hashlib

REQUIREMENTS = """\
strands-agents
strands-agents-tools
boto3
bedrock-agentcore
mcp-proxy-for-aws
aws-opentelemetry-distro>=0.10.1
"""

AGENT_PY = '''\
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""Strands agent on AgentCore Runtime — answers via managed KBs behind an
AgentCore Gateway (MCP). KB-agnostic: Gateway URL + model come from env vars,
so one image serves every KB. OTEL spans are emitted by the Runtime sidecar."""
import os
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.tools.mcp import MCPClient
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client

app = BedrockAgentCoreApp()
REGION = os.environ["AWS_REGION"]
GATEWAY_URL = os.environ["GATEWAY_URL"]
MODEL_ID = os.environ["MODEL_ID"]
model = BedrockModel(model_id=MODEL_ID, region_name=REGION)

# The AgenticRetrieveStream schema takes content as an OBJECT ({"text": ...}), not a
# bare string. Left to infer it, the model sends a string on the first call, eats a
# ValidationException, and only gets it right on the retry — which shows up as a ~50%
# UserErrors rate on the L4 Gateway widget and one wasted tool call plus an extra LLM
# turn per question. Spelling the shape out here removes that whole round trip.
SYSTEM_PROMPT = (
    "Answer using the knowledge base tools. Pick the tool matching the question's topic. "
    "Cite sources.\\n\\n"
    "Call a retrieval tool with exactly this argument shape — content is an object, "
    "never a plain string:\\n"
    '{"messages": [{"role": "user", "content": {"text": "<the question>"}}]}'
)


@app.entrypoint
def invoke(payload):
    prompt = payload.get("prompt", "")
    mcp_client = MCPClient(lambda: aws_iam_streamablehttp_client(
        endpoint=GATEWAY_URL, aws_region=REGION, aws_service="bedrock-agentcore"))
    with mcp_client:
        agent = Agent(model=model, tools=mcp_client.list_tools_sync(),
                      system_prompt=SYSTEM_PROMPT)
        return agent(prompt).message["content"][0]["text"]


if __name__ == "__main__":
    app.run()
'''

DOCKERFILE = """\
FROM public.ecr.aws/docker/library/python:3.11-slim
WORKDIR /app
COPY requirements.txt requirements.txt
RUN pip install -r requirements.txt
RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore
EXPOSE 8080
COPY . .
CMD ["opentelemetry-instrument", "python", "-m", "agent"]
"""

# Quoted delimiter, so the shell writes these files verbatim — no expansion of the
# $-signs or backticks that appear in Python and Dockerfile syntax.
_HEREDOC = "cat > {name} << 'BMKB_EOF'\n{body}BMKB_EOF"


def build_commands() -> list:
    """The buildspec ``build`` phase: write the three files, then build and tag."""
    return [
        "echo Build started on `date`",
        _HEREDOC.format(name="requirements.txt", body=REQUIREMENTS),
        _HEREDOC.format(name="agent.py", body=AGENT_PY),
        _HEREDOC.format(name="Dockerfile", body=DOCKERFILE),
        "echo Building ARM64 image...",
        "docker build -t $IMAGE_REPO_NAME:$IMAGE_TAG .",
        "docker tag $IMAGE_REPO_NAME:$IMAGE_TAG "
        "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$IMAGE_REPO_NAME:$IMAGE_TAG",
    ]


def sources_hash() -> str:
    """Digest of the agent source, so editing it triggers an image rebuild."""
    digest = hashlib.sha256()
    for body in (REQUIREMENTS, AGENT_PY, DOCKERFILE):
        digest.update(body.encode("utf-8"))
    return digest.hexdigest()[:16]
