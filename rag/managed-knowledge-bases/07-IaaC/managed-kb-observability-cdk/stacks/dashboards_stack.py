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
Stack 4 of 4 — the observability layer.

Two CloudWatch dashboards over metrics the live stack already emits:

**Dashboard A — seven-layer observability.** One row per concern, from the KB's own
counters up to evaluation scores.

**Dashboard B — usage and cost drivers.** The per-KB operational quantities that
determine spend: index size, retrieve volume, agentic tool-calls, session tokens.

Both render empty until the driver notebook sends traffic — that is the intended
narrative, not a bug. Layers 1, 4 and 5 arrive automatically; layers 3, 6 and 7 are
custom metrics the notebook publishes to ``BMKB/RetrievalQuality``, ``BMKB/Cost`` and
``BMKB/Evaluation``.

Where the CloudFormation sibling embeds a ``DashboardBody`` JSON blob inside a ``!Sub``
block, here the widgets are ``GraphWidget``/``SingleValueWidget``/``LogQueryWidget``
objects over typed ``Metric`` objects. The dimension names and namespaces are the same;
the difference is that a typo in a metric name is a Python error at synth time instead
of a silently-empty widget at demo time. Layout is explicit ``Row``s, so widget
coordinates do not have to be tracked by hand.
"""

from constructs import Construct

from aws_cdk import (
    Stack,
    CfnOutput,
    Duration,
    aws_cloudwatch as cw,
    aws_bedrockagentcore as agentcore,
)
from aws_cdk.aws_bedrock import CfnKnowledgeBase

from config import EnvSettings, AgentConfig

# Namespaces. The first two are emitted by AWS; the BMKB/* ones are published by the
# driver notebook (see utils/kb_observability.py).
NS_KB = "AWS/Bedrock/KnowledgeBases"
NS_GATEWAY = "AWS/Bedrock-AgentCore"
NS_QUALITY = "BMKB/RetrievalQuality"
NS_COST = "BMKB/Cost"
NS_EVAL = "BMKB/Evaluation"

PERIOD = Duration.minutes(5)


class DashboardsStack(Stack):
    """Two CloudWatch dashboards spanning the seven observability layers."""

    def __init__(
        self,
        scope: Construct,
        construct_id: str,
        financial_kb: CfnKnowledgeBase,
        weather_kb: CfnKnowledgeBase,
        gateway: agentcore.CfnGateway,
        agent_runtime: agentcore.CfnRuntime,
        **kwargs,
    ) -> None:
        super().__init__(scope, construct_id, **kwargs)

        project = EnvSettings.PROJECT_NAME
        fin_id = financial_kb.attr_knowledge_base_id
        wx_id = weather_kb.attr_knowledge_base_id
        gateway_arn = gateway.attr_gateway_arn

        dash_a_name = f"{project}-agentic-observability"
        dash_b_name = f"{project}-kb-observability"

        # ── Dashboard A — seven-layer observability ───────────────────────────
        cw.Dashboard(
            self,
            "ObservabilityDashboard",
            dashboard_name=dash_a_name,
            widgets=[
                [cw.TextWidget(width=24, height=5, markdown=self._header_a(project))],
                [
                    # L1: the KB's own Retrieve counters. Note there is no Latency
                    # metric in this namespace — KB latency lives in the spans (L5).
                    cw.GraphWidget(
                        title="L1 — KB metrics (Retrieve, per KB)",
                        width=12, height=6, period=PERIOD, statistic="Sum",
                        left=[
                            self._kb_metric("Invocations", fin_id, "financial Invocations"),
                            self._kb_metric("Invocations", wx_id, "weather Invocations"),
                            self._kb_metric("ClientErrors", fin_id, "financial ClientErrors"),
                            self._kb_metric("ServerErrors", wx_id, "weather ServerErrors"),
                            self._kb_metric("Throttles", fin_id, "financial Throttles"),
                        ],
                    ),
                    # L4: every MCP operation the gateway serves — see the header note
                    # on why Invocations is a multiple of the query count.
                    cw.GraphWidget(
                        title="L4 — Gateway metrics (MCP)",
                        width=12, height=6, period=PERIOD, statistic="Sum",
                        left=[
                            self._gateway_metric("Invocations", gateway_arn, "tools/call Invocations"),
                            self._gateway_metric("SystemErrors", gateway_arn, "SystemErrors"),
                            self._gateway_metric("UserErrors", gateway_arn, "UserErrors"),
                            self._gateway_metric("Throttles", gateway_arn, "Throttles"),
                        ],
                    ),
                ],
                [
                    cw.GraphWidget(
                        title="L4 — Gateway latency (ms)",
                        width=12, height=6, period=PERIOD, statistic="Average",
                        left=[self._gateway_metric("Latency", gateway_arn, "tools/call Latency")],
                    ),
                    # L6: token usage reconstructed from gen_ai.usage.* spans.
                    cw.GraphWidget(
                        title="L6 — Token usage per session (BMKB/Cost SessionQuotaTokens, per KB)",
                        width=12, height=6, period=PERIOD, statistic="Sum",
                        left=[
                            self._custom_metric(NS_COST, "SessionQuotaTokens", fin_id, "financial tokens"),
                            self._custom_metric(NS_COST, "SessionQuotaTokens", wx_id, "weather tokens"),
                        ],
                    ),
                ],
                [cw.TextWidget(width=24, height=7, markdown=self._l3_explainer())],
                [
                    self._quality_widget("L3 · Financial KB — agentic quality (reference-free, 0–1)", fin_id),
                    self._quality_widget("L3 · Weather KB — agentic quality (reference-free, 0–1)", wx_id),
                ],
                [
                    # L7: on-demand evaluation scores published by the notebook. The
                    # continuous scores from the online eval config land in the
                    # console's Evaluations tab instead.
                    cw.GraphWidget(
                        title="L7 — Eval scores (BMKB/Evaluation, 0–1, per KB)",
                        width=24, height=6, period=PERIOD, statistic="Average",
                        left=[
                            self._custom_metric(NS_EVAL, "Correctness", fin_id, "financial Correctness"),
                            self._custom_metric(NS_EVAL, "Correctness", wx_id, "weather Correctness"),
                        ],
                    ),
                ],
                [
                    # L5: the span tree, deliberately un-deduplicated — seeing the
                    # nesting is the point of this widget. One LLM call appears three
                    # times: the "invoke_agent" aggregate, an INTERNAL "chat", and the
                    # CLIENT "chat <model>" leaf, and all three repeat the same
                    # gen_ai.usage numbers. Do NOT sum this view; anything that
                    # aggregates tokens must filter to the CLIENT leaf (see the
                    # generation widget on the KB dashboard).
                    cw.LogQueryWidget(
                        title="L5 — OTEL span tree (aws/spans; one LLM call = 3 nested spans)",
                        width=24, height=6,
                        log_group_names=["aws/spans"],
                        view=cw.LogQueryVisualizationType.TABLE,
                        query_lines=[
                            "fields @timestamp, name, kind, durationNano, "
                            "attributes.gen_ai.usage.input_tokens, "
                            "attributes.gen_ai.usage.output_tokens, "
                            "attributes.gen_ai.request.model",
                            "filter attributes.gen_ai.request.model like /claude/",
                            "sort @timestamp desc",
                            "limit 20",
                        ],
                    ),
                ],
            ],
        )

        # ── Dashboard B — usage and cost drivers ──────────────────────────────
        cw.Dashboard(
            self,
            "KbObservabilityDashboard",
            dashboard_name=dash_b_name,
            widgets=[
                [cw.TextWidget(width=24, height=7, markdown=self._header_b(project))],
                [
                    # Point-in-time snapshot, so set_period_to_time_range widens the
                    # period to the whole dashboard window and the value stays visible.
                    # CDK rejects pairing that with sparkline=True — the two options
                    # genuinely conflict, and this is one place the typed API catches
                    # something a hand-written DashboardBody accepts silently.
                    cw.SingleValueWidget(
                        title="Index size — source bytes (MB, per KB)",
                        width=8, height=6, period=PERIOD,
                        set_period_to_time_range=True,
                        metrics=[
                            self._custom_metric(NS_COST, "SourceBytesMB", fin_id, "financial MB", "Maximum"),
                            self._custom_metric(NS_COST, "SourceBytesMB", wx_id, "weather MB", "Maximum"),
                        ],
                    ),
                    cw.GraphWidget(
                        title="Retrieve calls — Invocations count (per KB)",
                        width=8, height=6, period=PERIOD, statistic="Sum",
                        view=cw.GraphWidgetView.BAR, set_period_to_time_range=True,
                        left=[
                            self._kb_metric("Invocations", fin_id, "financial"),
                            self._kb_metric("Invocations", wx_id, "weather"),
                        ],
                    ),
                    cw.GraphWidget(
                        title="Agentic tool-calls — Gateway Invocations count",
                        width=8, height=6, period=PERIOD, statistic="Sum",
                        view=cw.GraphWidgetView.BAR, set_period_to_time_range=True,
                        left=[
                            self._gateway_metric("Invocations", gateway_arn, "tools/call (both KBs)")
                        ],
                    ),
                ],
                [
                    cw.GraphWidget(
                        title="Token usage — SessionQuotaTokens (per KB)",
                        width=8, height=6, period=PERIOD, statistic="Sum",
                        view=cw.GraphWidgetView.BAR, set_period_to_time_range=True,
                        left=[
                            self._custom_metric(NS_COST, "SessionQuotaTokens", fin_id, "financial"),
                            self._custom_metric(NS_COST, "SessionQuotaTokens", wx_id, "weather"),
                        ],
                    ),
                    cw.LogQueryWidget(
                        title="Generation (agent model) — token usage by model (aws/spans)",
                        width=16, height=6,
                        log_group_names=["aws/spans"],
                        view=cw.LogQueryVisualizationType.TABLE,
                        # One LLM call emits three nested spans that all carry the SAME
                        # gen_ai.usage attributes: the "invoke_agent" aggregate, an
                        # INTERNAL "chat", and a CLIENT "chat <model>". Summing over
                        # every span with tokens present therefore triples both totals
                        # and the call count. Restricting to the CLIENT "chat <model>"
                        # leaf counts each call exactly once — the same rule the
                        # notebook's L6 cell uses, so the widget and BMKB/Cost agree.
                        query_lines=[
                            "fields attributes.gen_ai.request.model as model, "
                            "attributes.gen_ai.usage.input_tokens as in_tok, "
                            "attributes.gen_ai.usage.output_tokens as out_tok",
                            "filter ispresent(in_tok) and kind = 'CLIENT' and name like /^chat /",
                            "stats sum(in_tok) as input_tokens, sum(out_tok) as output_tokens, "
                            "count(*) as llm_calls by model",
                        ],
                    ),
                ],
            ],
        )

        # ── Outputs ───────────────────────────────────────────────────────────
        console = f"https://{self.region}.console.aws.amazon.com/cloudwatch/home?region={self.region}"
        CfnOutput(self, "ObservabilityDashboardName", value=dash_a_name,
                  description="Dashboard A name.")
        CfnOutput(self, "KbObservabilityDashboardName", value=dash_b_name,
                  description="Dashboard B name.")
        # The dashboard deep-link path is "#dashboards/dashboard/<name>". The older
        # "#dashboards:name=<name>" form no longer resolves — the console loads the
        # dashboard list instead of the dashboard, with no error to explain why.
        CfnOutput(self, "ObservabilityDashboardUrl",
                  value=f"{console}#dashboards/dashboard/{dash_a_name}",
                  description="Console URL for Dashboard A (end-to-end agentic observability).")
        CfnOutput(self, "KbObservabilityDashboardUrl",
                  value=f"{console}#dashboards/dashboard/{dash_b_name}",
                  description="Console URL for Dashboard B (per-KB usage and cost drivers).")
        CfnOutput(self, "GenAiObservabilityUrl",
                  value=f"{console}#gen-ai-observability/agent-core/agents/{agent_runtime.attr_agent_runtime_id}",
                  description="Console GenAI Observability view for this agent (span tree + Evaluations tab).")

    # ── Metric helpers ────────────────────────────────────────────────────────
    def _kb_metric(self, name: str, kb_id: str, label: str) -> cw.Metric:
        """A metric from the KB's own namespace, scoped to one KB and Retrieve."""
        return cw.Metric(
            namespace=NS_KB,
            metric_name=name,
            # This namespace wants the dimension prefixed — 'knowledge-base/<id>',
            # not the bare id used by the BMKB/* namespaces below.
            dimensions_map={"Operation": "Retrieve", "KnowledgeBaseId": f"knowledge-base/{kb_id}"},
            label=label,
        )

    def _gateway_metric(self, name: str, gateway_arn: str, label: str) -> cw.Metric:
        """A gateway metric for the MCP tools/call method."""
        return cw.Metric(
            namespace=NS_GATEWAY,
            metric_name=name,
            dimensions_map={
                "Resource": gateway_arn,
                "Operation": "InvokeGateway",
                "Method": "tools/call",
                "Protocol": "MCP",
            },
            label=label,
        )

    def _custom_metric(self, namespace: str, name: str, kb_id: str,
                       label: str, statistic: str = None) -> cw.Metric:
        """A metric the driver notebook publishes, keyed on the bare KB id."""
        kwargs = {"statistic": statistic} if statistic else {}
        return cw.Metric(
            namespace=namespace,
            metric_name=name,
            dimensions_map={"KnowledgeBaseId": kb_id},
            label=label,
            **kwargs,
        )

    def _quality_widget(self, title: str, kb_id: str) -> cw.GraphWidget:
        """The three headline L3 ratios for one KB, all on a 0–1 scale."""
        return cw.GraphWidget(
            title=title,
            width=12, height=6, period=PERIOD, statistic="Average",
            left=[
                self._custom_metric(NS_QUALITY, "retrieval_utilization", kb_id,
                                    "retrieval_utilization (precision proxy)"),
                self._custom_metric(NS_QUALITY, "grounded_coverage", kb_id,
                                    "grounded_coverage (faithfulness proxy)"),
                self._custom_metric(NS_QUALITY, "duplicate_rate", kb_id,
                                    "duplicate_rate (redundancy)"),
            ],
        )

    # ── Explainer text ────────────────────────────────────────────────────────
    @staticmethod
    def _header_a(project: str) -> str:
        return (
            f"# {project} — Agentic RAG Observability (7 layers)\n"
            "One agent → one Gateway → per-KB `AgenticRetrieveStream` targets "
            "(financial + weather). Widgets fill as the driver notebook sends traffic. "
            "**L2 ingestion** detail lives in Logs Insights (ingestion-job API), not a "
            "metric widget.\n\n"
            "**Each layer counts a different thing — the gaps are the agentic loop made "
            "visible.** For *N* user queries you'll see roughly: **N** agent invocations · "
            "**~2N** KB retrievals · **~3N** LLM `chat` calls (L6 token usage) · **~5N** "
            "Gateway MCP ops (L4 `Invocations` — it counts every MCP op: Initialize + "
            "ListTools + NotificationsInitialized + InvokeTool). So **L4 `Invocations` ≠ "
            "query count**, and only the `chat` spans carry tokens (L6). **L1** = the KB's "
            "own Retrieve counters (no `Latency` here — KB latency is in the spans, L5). "
            "**L6** = per-session token usage from `gen_ai.usage.*` spans → `BMKB/Cost`."
        )

    @staticmethod
    def _l3_explainer() -> str:
        return (
            "### L3 · Agentic retrieval quality — what we compute, and what it means\n"
            "The agent's KB tool is **`AgenticRetrieveStream`** (not plain `Retrieve`), "
            "which reranks internally and returns a synthesized, cited answer — **no "
            "per-chunk relevance `score`**. So Layer 3 shifts from *“how relevant is each "
            "chunk”* to *“how much of what we retrieved did the answer use, and how well is "
            "it grounded.”* All signals are **reference-free** (no ground truth, no "
            "LLM-judge). The two widgets below plot the three headline ratios per KB; the "
            "full family (counts + context budget) is published to "
            "`BMKB/RetrievalQuality` and queryable there.\n\n"
            "| Metric (plotted) | From | Meaning |\n|---|---|---|\n"
            "| `retrieval_utilization` | `cited_chunks / chunk_count` | **precision proxy** "
            "— low = retriever over-fetched (0.2 = only 2 of 10 chunks used) |\n"
            "| `grounded_coverage` | cited answer-span chars / answer chars | "
            "**reference-free faithfulness** — fraction of the answer backed by a citation "
            "(near 1.0 = well-grounded, low hallucination risk) |\n"
            "| `duplicate_rate` | `1 − distinct_chunks / chunk_count` | redundant retrieval "
            "(same chunk returned twice) |\n\n"
            "*Also emitted to the namespace (not plotted):* `chunk_count`, `distinct_docs`, "
            "`distinct_chunks`, `avg_chunk_chars`, `total_context_chars` (retrieval-set) · "
            "`num_citations`, `cited_chunks`, `answer_chars` (grounding)."
        )

    @staticmethod
    def _header_b(project: str) -> str:
        return (
            f"# {project} — BMKB Observability (per KB)\n"
            "Knowledge-Base-focused operational signals — the quantities that also determine "
            "spend on a fully-managed KB. Fully-managed KB → **no OpenSearch/OCU line item** "
            "(the vector store is bundled). Values are point-in-time snapshots; "
            "`setPeriodToTimeRange` keeps the bars visible across the window.\n\n"
            "| Widget | Metric · source | How it's computed / what it means |\n|---|---|---|\n"
            "| Index size | `SourceBytesMB` · `BMKB/Cost` | summed S3 **source bytes** per KB "
            "(each KB owns a prefix), in MB. Published by the driver — a reliable, immediate "
            "stand-in for the KB's native `RawDataSize`, which emits only sporadically |\n"
            "| Retrieve calls | `Invocations` (Op=Retrieve) · `AWS/Bedrock/KnowledgeBases` | "
            "count of retrieval requests hitting each KB |\n"
            "| Agentic tool-calls | `Invocations` (Method=tools/call) · "
            "`AWS/Bedrock-AgentCore` | Gateway MCP tool invocations — the "
            "`AgenticRetrieveStream` calls that drive spend |\n"
            "| Session token usage | `SessionQuotaTokens` · `BMKB/Cost` | per-session tokens "
            "(input + output×burndown) from the agent's `chat` spans, published by the driver "
            "notebook |\n"
            "| Generation by model | span `gen_ai.usage.*_tokens` · `aws/spans` | input/output "
            "tokens + LLM-call count, grouped by model — the leaf `chat` calls that carry "
            "cost |\n\n"
            "**Embedding / Reranking** are bundled into Retrieve on the default managed path → "
            "no separate signal. The KB's internal agentic-orchestration model runs "
            f"server-side (**Model Invocation Logging**, not these metrics). Agent runtime: "
            f"`{AgentConfig.RUNTIME_NAME}`."
        )
