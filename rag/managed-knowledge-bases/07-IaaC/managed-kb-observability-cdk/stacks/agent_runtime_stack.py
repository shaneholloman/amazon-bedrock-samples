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
Stack 3 of 4 — the agent layer.

An OpenTelemetry-instrumented Strands agent running on AgentCore Runtime, plus
everything needed to get its telemetry out:

* **ECR + CodeBuild** build the ARM64 agent image in-account, so deploying this
  sample needs no local Docker and no cross-architecture emulation. The build has
  no source input — the buildspec writes ``requirements.txt``, ``agent.py`` and the
  ``Dockerfile`` itself (see ``agent_sources.py``), so there is nothing to clone and
  nothing to stage.
* **A build-trigger custom resource** starts the build and polls it, because the
  runtime cannot start until an image exists at the tag it points to.
* **Vended log + trace delivery** sends application logs to CloudWatch Logs and OTEL
  spans to X-Ray. This is what makes layers 5–7 visible.
* **An online evaluation config** scores live sessions continuously, independent of
  the driver notebook's on-demand pass.

Instrumentation is not in the agent code: ``aws-opentelemetry-distro`` plus an
``opentelemetry-instrument`` entrypoint produce the ``gen_ai`` spans that carry token
usage, so the agent stays ordinary Strands code.
"""

from pathlib import Path

from constructs import Construct

import aws_cdk as cdk
from aws_cdk import (
    Stack,
    CfnOutput,
    Duration,
    RemovalPolicy,
    aws_iam as iam,
    aws_ecr as ecr,
    aws_codebuild as codebuild,
    aws_lambda as lambda_,
    aws_logs as logs,
    aws_bedrockagentcore as agentcore,
    custom_resources as cr,
)

from config import EnvSettings, AgentConfig, EvalConfig
from stacks.agent_sources import build_commands, sources_hash

ROOT = Path(__file__).resolve().parent.parent


class AgentRuntimeStack(Stack):
    """Instrumented Strands agent on AgentCore Runtime + telemetry + online eval."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        gateway: agentcore.CfnGateway,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        project = EnvSettings.PROJECT_NAME

        # The tag is content-addressed: it carries a digest of the agent source plus the
        # manual BUILD_VERSION override. That matters because the Runtime's containerUri
        # embeds the tag — with a fixed "latest", editing the agent rebuilds and repushes
        # the image but leaves containerUri byte-identical, so CloudFormation sees no
        # change to the Runtime and the old image keeps serving. Varying the tag makes
        # the new image a real property change, so the Runtime rolls to a new version.
        image_tag = f"{AgentConfig.IMAGE_TAG}-{AgentConfig.BUILD_VERSION}-{sources_hash()}"

        # ── ECR ───────────────────────────────────────────────────────────────
        self.repository = ecr.Repository(
            self,
            "AgentRepository",
            repository_name=f"{project}-agent",
            image_tag_mutability=ecr.TagMutability.MUTABLE,
            image_scan_on_push=True,
            # Sample hygiene: the repo and its images go away with the stack.
            removal_policy=RemovalPolicy.DESTROY,
            empty_on_delete=True,
        )

        # ── CodeBuild ─────────────────────────────────────────────────────────
        # ARM64 (AgentCore Runtime is aarch64) and privileged, because the build
        # needs the Docker daemon. No source input — the buildspec below materialises
        # every file it needs.
        self.build_project = codebuild.Project(
            self,
            "AgentImageBuild",
            project_name=f"{project}-agent-build",
            description="Build the OTEL-instrumented Strands agent image (ARM64).",
            environment=codebuild.BuildEnvironment(
                build_image=codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
                compute_type=codebuild.ComputeType.LARGE,
                privileged=True,
            ),
            environment_variables={
                "AWS_ACCOUNT_ID": codebuild.BuildEnvironmentVariable(value=self.account),
                "IMAGE_REPO_NAME": codebuild.BuildEnvironmentVariable(
                    value=self.repository.repository_name
                ),
                "IMAGE_TAG": codebuild.BuildEnvironmentVariable(value=image_tag),
            },
            build_spec=codebuild.BuildSpec.from_object({
                "version": "0.2",
                "phases": {
                    "pre_build": {"commands": [
                        "echo Logging in to Amazon ECR...",
                        "aws ecr get-login-password --region $AWS_DEFAULT_REGION | "
                        "docker login --username AWS --password-stdin "
                        "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com",
                    ]},
                    # Heredocs that write the agent, then build the image.
                    "build": {"commands": build_commands()},
                    "post_build": {"commands": [
                        "echo Pushing image...",
                        "docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/"
                        "$IMAGE_REPO_NAME:$IMAGE_TAG",
                        "echo Done.",
                    ]},
                },
            }),
            timeout=Duration.minutes(30),
            logging=codebuild.LoggingOptions(
                cloud_watch=codebuild.CloudWatchLoggingOptions(
                    enabled=True,
                    # Explicit group so the build log is easy to find when a build
                    # fails, and so it does not outlive the stack.
                    log_group=logs.LogGroup(
                        self,
                        "AgentImageBuildLogs",
                        log_group_name=f"/aws/codebuild/{project}-agent-build",
                        retention=logs.RetentionDays.ONE_WEEK,
                        removal_policy=RemovalPolicy.DESTROY,
                    ),
                ),
            ),
        )
        # grant_pull_push covers the auth token plus the layer/put-image calls; the
        # CloudFormation sibling has to spell all eight actions out by hand.
        self.repository.grant_pull_push(self.build_project)

        # ── Build trigger ─────────────────────────────────────────────────────
        # The runtime needs an image to exist before it can start, so this resource
        # starts the build and polls it. Same two-handler split as the ingestion
        # resource in stack 1 — nothing blocks inside a Lambda for ten minutes.
        build_trigger = cdk.CustomResource(
            self,
            "TriggerImageBuild",
            service_token=self._build_provider().service_token,
            resource_type="Custom::AgentImageBuild",
            properties={
                "ProjectName": self.build_project.project_name,
                # Any change to these properties re-runs the build. ImageTag carries the
                # source digest and BUILD_VERSION, so editing the agent both rebuilds the
                # image and pushes it under the tag the runtime is about to ask for. It has
                # to be *this* value: keying the trigger on anything the tag does not
                # include would let the runtime reference a tag no build ever pushed.
                "ImageTag": image_tag,
            },
        )

        # ── Agent execution role ──────────────────────────────────────────────
        self.agent_role = iam.Role(
            self,
            "AgentExecutionRole",
            role_name=f"{project}-agent-exec-role",
            description=f"Execution role for the {project} Strands agent on AgentCore Runtime",
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
        self.repository.grant_pull(self.agent_role)
        self.agent_role.add_to_policy(
            iam.PolicyStatement(
                sid="CloudWatchLogs",
                actions=[
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:DescribeLogGroups",
                    "logs:DescribeLogStreams",
                    "logs:PutLogEvents",
                ],
                resources=["*"],
            )
        )
        self.agent_role.add_to_policy(
            iam.PolicyStatement(
                sid="XRayTracing",
                actions=[
                    "xray:PutTraceSegments",
                    "xray:PutTelemetryRecords",
                    "xray:GetSamplingRules",
                    "xray:GetSamplingTargets",
                ],
                resources=["*"],
            )
        )
        self.agent_role.add_to_policy(
            iam.PolicyStatement(
                sid="CloudWatchMetrics",
                actions=["cloudwatch:PutMetricData"],
                resources=["*"],
                conditions={"StringEquals": {"cloudwatch:namespace": "bedrock-agentcore"}},
            )
        )
        self.agent_role.add_to_policy(
            iam.PolicyStatement(
                sid="GetAgentAccessToken",
                actions=[
                    "bedrock-agentcore:GetWorkloadAccessToken",
                    "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
                    "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
                ],
                resources=[
                    f"arn:{self.partition}:bedrock-agentcore:{self.region}:{self.account}:workload-identity-directory/default",
                    f"arn:{self.partition}:bedrock-agentcore:{self.region}:{self.account}:workload-identity-directory/default/workload-identity/*",
                ],
            )
        )
        # The agent's own reasoning model. Left unscoped because MODEL_ID is a
        # cross-region inference profile, which resolves to several model ARNs.
        self.agent_role.add_to_policy(
            iam.PolicyStatement(
                sid="BedrockModelInvocation",
                actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                resources=["*"],
            )
        )
        self.agent_role.add_to_policy(
            iam.PolicyStatement(
                sid="InvokeGatewayMcp",
                actions=["bedrock-agentcore:InvokeGateway"],
                resources=[
                    f"arn:{self.partition}:bedrock-agentcore:{self.region}:{self.account}:gateway/{gateway.attr_gateway_identifier}"
                ],
            )
        )

        # ── The runtime ───────────────────────────────────────────────────────
        # The agent is KB-agnostic: gateway URL and model arrive as environment
        # variables, so this one image would serve any number of knowledge bases.
        self.agent_runtime = agentcore.CfnRuntime(
            self,
            "AgentRuntime",
            agent_runtime_name=AgentConfig.RUNTIME_NAME,
            agent_runtime_artifact=agentcore.CfnRuntime.AgentRuntimeArtifactProperty(
                container_configuration=agentcore.CfnRuntime.ContainerConfigurationProperty(
                    container_uri=f"{self.repository.repository_uri}:{image_tag}",
                ),
            ),
            role_arn=self.agent_role.role_arn,
            network_configuration=agentcore.CfnRuntime.NetworkConfigurationProperty(
                network_mode=AgentConfig.NETWORK_MODE,
            ),
            protocol_configuration="HTTP",
            description=f"Instrumented Strands agentic-RAG agent for {project}.",
            environment_variables={
                # agent.py reads all three. AWS_REGION is set explicitly rather than
                # relying on the runtime's ambient value.
                "AWS_REGION": self.region,
                "GATEWAY_URL": gateway.attr_gateway_url,
                "MODEL_ID": AgentConfig.MODEL_ID,
            },
            tags={"Project": project, "Sample": "bmkb-observability-cdk"},
        )
        # Without the image in place the runtime fails to start, and the role must
        # exist before AgentCore validates it.
        self.agent_runtime.node.add_dependency(build_trigger)
        self.agent_runtime.node.add_dependency(self.agent_role)

        runtime_id = self.agent_runtime.attr_agent_runtime_id

        # ── Telemetry delivery ────────────────────────────────────────────────
        # Application logs → CloudWatch Logs, OTEL spans → X-Ray. Without this
        # wiring the runtime still works but layers 5–7 stay dark.
        self.agent_log_group = logs.LogGroup(
            self,
            "AgentLogGroup",
            log_group_name=f"/aws/vendedlogs/bedrock-agentcore/{runtime_id}",
            retention=logs.RetentionDays.TWO_WEEKS,
            removal_policy=RemovalPolicy.DESTROY,
        )
        self._deliver(
            "Logs",
            log_type="APPLICATION_LOGS",
            destination_type="CWL",
            destination_arn=self.agent_log_group.log_group_arn,
            source_name=f"{runtime_id}-logs-source",
            destination_name=f"{runtime_id}-logs-destination",
        )
        self._deliver(
            "Traces",
            log_type="TRACES",
            destination_type="XRAY",
            destination_arn=None,  # X-Ray is the destination; there is no target resource
            source_name=f"{runtime_id}-traces-source",
            destination_name=f"{runtime_id}-traces-destination",
        )

        # ── Online (continuous) evaluation ────────────────────────────────────
        eval_role = iam.Role(
            self,
            "EvalExecutionRole",
            role_name=f"{project}-eval-exec-role",
            description=f"Execution role for {project} online evaluation",
            assumed_by=iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
        )
        eval_role.add_to_policy(
            iam.PolicyStatement(
                sid="CloudWatchLogRead",
                actions=[
                    "logs:StartQuery",
                    "logs:GetQueryResults",
                    "logs:DescribeLogGroups",
                    "logs:DescribeLogStreams",
                    "logs:PutIndexPolicy",
                    "logs:DescribeIndexPolicies",
                    "cloudwatch:GenerateQuery",
                    "cloudwatch:GenerateQueryResultsSummary",
                ],
                resources=["*"],
            )
        )
        eval_role.add_to_policy(
            iam.PolicyStatement(
                sid="EvalResultsLogWrite",
                actions=[
                    "logs:CreateLogGroup",
                    "logs:CreateLogStream",
                    "logs:PutLogEvents",
                    "logs:GetLogEvents",
                ],
                resources=[
                    f"arn:{self.partition}:logs:{self.region}:{self.account}:log-group:/aws/bedrock-agentcore/evaluations/*"
                ],
            )
        )
        eval_role.add_to_policy(
            iam.PolicyStatement(
                sid="InvokeJudgeModel",
                actions=["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
                resources=["*"],
            )
        )

        self.online_eval = agentcore.CfnOnlineEvaluationConfig(
            self,
            "OnlineEvaluationConfig",
            online_evaluation_config_name=EvalConfig.ONLINE_EVAL_NAME,
            description="Continuous quality scoring of the agentic-RAG agent's live sessions.",
            evaluation_execution_role_arn=eval_role.role_arn,
            execution_status="ENABLED",
            rule=agentcore.CfnOnlineEvaluationConfig.RuleProperty(
                sampling_config=agentcore.CfnOnlineEvaluationConfig.SamplingConfigProperty(
                    # 100% is a sample setting so every session scores on the first
                    # run — not a production default. Each sampled session costs an
                    # LLM-as-judge call per evaluator. See EvalConfig.
                    sampling_percentage=EvalConfig.SAMPLING_PERCENTAGE,
                ),
                session_config=agentcore.CfnOnlineEvaluationConfig.SessionConfigProperty(
                    session_timeout_minutes=EvalConfig.SESSION_TIMEOUT_MINUTES,
                ),
            ),
            data_source_config=agentcore.CfnOnlineEvaluationConfig.DataSourceConfigProperty(
                cloud_watch_logs=agentcore.CfnOnlineEvaluationConfig.CloudWatchLogsInputConfigProperty(
                    log_group_names=[
                        f"/aws/bedrock-agentcore/runtimes/{runtime_id}-DEFAULT"
                    ],
                    # Service name as it appears in aws/spans: runtime name + ".DEFAULT".
                    service_names=[f"{AgentConfig.RUNTIME_NAME}.DEFAULT"],
                ),
            ),
            evaluators=[
                agentcore.CfnOnlineEvaluationConfig.EvaluatorReferenceProperty(evaluator_id=e)
                for e in EvalConfig.EVALUATORS
            ],
        )
        self.online_eval.node.add_dependency(self.agent_runtime)

        # ── Outputs ───────────────────────────────────────────────────────────
        CfnOutput(self, "AgentRuntimeId", value=runtime_id,
                  description="AgentCore Runtime ID.")
        CfnOutput(self, "AgentRuntimeArn", value=self.agent_runtime.attr_agent_runtime_arn,
                  description="AgentCore Runtime ARN (invoke target for the driver notebook).")
        CfnOutput(self, "AgentLogGroupName", value=self.agent_log_group.log_group_name,
                  description="Vended application-log group for the agent.")
        CfnOutput(self, "EcrRepositoryUri", value=self.repository.repository_uri,
                  description="Agent image repository URI.")
        CfnOutput(self, "OnlineEvaluationConfigId",
                  value=self.online_eval.attr_online_evaluation_config_id,
                  description="Online evaluation config (populates the console Evaluations tab).")

    # ──────────────────────────────────────────────────────────────────────────
    def _deliver(self, cid: str, log_type: str, destination_type: str,
                 destination_arn, source_name: str, destination_name: str) -> None:
        """Wire one vended-log delivery: source → destination → delivery."""
        source = logs.CfnDeliverySource(
            self, f"{cid}DeliverySource",
            name=source_name,
            log_type=log_type,
            resource_arn=self.agent_runtime.attr_agent_runtime_arn,
        )
        source.node.add_dependency(self.agent_runtime)

        destination = logs.CfnDeliveryDestination(
            self, f"{cid}DeliveryDestination",
            name=destination_name,
            delivery_destination_type=destination_type,
            # X-Ray has no target resource to point at; CWL needs the log group.
            **({"destination_resource_arn": destination_arn} if destination_arn else {}),
        )

        delivery = logs.CfnDelivery(
            self, f"{cid}Delivery",
            delivery_source_name=source.name,
            delivery_destination_arn=destination.attr_arn,
        )
        delivery.node.add_dependency(source)
        delivery.node.add_dependency(destination)

    # ──────────────────────────────────────────────────────────────────────────
    def _build_provider(self) -> cr.Provider:
        """Provider that starts the image build and polls it to completion."""
        on_event = lambda_.Function(
            self,
            "BuildTriggerOnEvent",
            function_name=f"{EnvSettings.PROJECT_NAME}-build-start",
            description="Starts the agent image build (custom resource).",
            runtime=lambda_.Runtime.PYTHON_3_13,
            handler="index.on_event",
            code=lambda_.Code.from_asset(str(ROOT / "lambdas" / "build_trigger")),
            timeout=Duration.minutes(2),
            log_group=self._log_group("BuildTriggerOnEventLogs"),
        )
        is_complete = lambda_.Function(
            self,
            "BuildTriggerIsComplete",
            function_name=f"{EnvSettings.PROJECT_NAME}-build-poll",
            description="Polls the agent image build to a terminal state.",
            runtime=lambda_.Runtime.PYTHON_3_13,
            handler="index.is_complete",
            code=lambda_.Code.from_asset(str(ROOT / "lambdas" / "build_trigger")),
            timeout=Duration.minutes(2),
            log_group=self._log_group("BuildTriggerIsCompleteLogs"),
        )
        for fn in (on_event, is_complete):
            fn.add_to_role_policy(
                iam.PolicyStatement(
                    sid="CodeBuildAccess",
                    actions=[
                        "codebuild:StartBuild",
                        "codebuild:BatchGetBuilds",
                        "codebuild:BatchGetProjects",
                    ],
                    resources=[self.build_project.project_arn],
                )
            )

        return cr.Provider(
            self,
            "BuildTriggerProvider",
            on_event_handler=on_event,
            is_complete_handler=is_complete,
            query_interval=Duration.seconds(30),
            # The image build takes roughly 8–10 minutes; leave generous headroom.
            total_timeout=Duration.minutes(45),
            log_group=self._log_group("BuildTriggerProviderLogs"),
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
