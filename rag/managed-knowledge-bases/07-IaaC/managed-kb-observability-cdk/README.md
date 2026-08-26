# End-to-End Agentic RAG on a Fully-Managed Bedrock Knowledge Base — via AWS CDK

Deploy a complete **agentic RAG** solution from one CDK app: two fully-managed Amazon Bedrock
Knowledge Bases, an Amazon Bedrock AgentCore **Gateway** that exposes each KB's
`AgenticRetrieveStream` tool, an instrumented **Strands agent on AgentCore Runtime** that routes
questions to the right KB, and two **CloudWatch dashboards** covering seven layers of observability.

A companion notebook then drives traffic and lights the dashboards up.

This is the CDK counterpart of the [managed-kb-observability-cfn](../managed-kb-observability-cfn/)
sample. Same deployed architecture, same seven layers, same notebook — a different authoring model.
See [What CDK changes](#what-cdk-changes) for the side-by-side.

> **About the data.** The two corpora have different provenance. The **financial** corpus (Octank
> Financial 10-K) is **synthetic** — Octank is a fictional company and the document is model-generated
> (CC0-licensed) sample data; it is not real financial data. The **weather** corpus (`tornadoes_report.pdf`)
> is a **real, publicly available** U.S. Congressional Research Service report
> ([IF12695](https://sgp.fas.org/crs/misc/IF12695.pdf)) — a public-domain U.S. Government work. Swap in
> your own corpus by dropping files under `data/` and adjusting the prefixes in [config.py](config.py).

## Architecture

```
                          ┌── Layer 1: AWS/Bedrock/KnowledgeBases (metrics)
  data/ ─▶ Managed KB ×2 ─┼── Layer 2: ingestion job + APPLICATION_LOGS
  (financial, weather)    └── Layer 3: AgenticRetrieveStream payload (chunks + cited answer)
       ▲
       │ MCP (AgenticRetrieveStream, per-KB connector target)
  AgentCore Gateway ─────── Layer 4: AWS/Bedrock-AgentCore (metrics)
       ▲
       │ MCP (SigV4 / AWS_IAM)
  Strands agent  ┌───────── Layer 5: OTEL span tree ─▶ aws/spans
  on AgentCore ──┼───────── Layer 6: gen_ai.usage tokens on spans → usage
  RUNTIME        └───────── Layer 7: AgentCore Evaluate scores the session
       ▲
  invoke_agent_runtime(session_id)   ← session id is the join key across every layer
```

Everything above the `data/` line is deployed by the CDK app. The agentic retrieval tool is a
**native Gateway connector** (`ConnectorId: bedrock-knowledge-bases`) — no Lambda or extra container
is needed for retrieval; only the agent itself runs in a container (built by CodeBuild at deploy).

## Layout

```
app.py                      the four stacks, wired by passing construct references
config.py                   everything tunable: project name, models, prefixes, sampling rate
stacks/
  knowledge_bases_stack.py  S3 + corpora upload + 2 managed KBs + data sources + IAM + ingestion
  agentic_gateway_stack.py  Gateway (AWS_IAM/MCP) + per-KB AgenticRetrieveStream targets
  agent_runtime_stack.py    ECR + CodeBuild + Strands agent on Runtime + vended logs/traces + online eval
  agent_sources.py          the agent's requirements.txt / agent.py / Dockerfile, as buildspec input
  dashboards_stack.py       2 CloudWatch dashboards, built from typed Metric + widget objects
lambdas/
  ingest_sync/              custom resource: StartIngestionJob + poll to terminal state
  build_trigger/            custom resource: start the CodeBuild image build + poll it
utils/                      self-contained copy of the observability helpers (no repo-root deps)
notebooks/
  01-drive-and-observe.ipynb  post-deploy driver: drives traffic, emits L3/L6/L7, opens dashboards
data/                       the two corpora: financial/ (synthetic, CC0) + weather/ (public CRS report)
```

## Prerequisites

- AWS credentials with permissions for Bedrock, AgentCore (Runtime + Gateway), IAM, CloudWatch,
  X-Ray, ECR, CodeBuild, S3, Lambda, CloudFormation.
- Model access enabled for the agent's model (default `us.anthropic.claude-haiku-4-5-20251001-v1:0`).
- **CloudWatch Transaction Search** enabled (so OTEL spans land in `aws/spans` for Layers 5–7).
- Node.js 18+ and the CDK CLI (`npm install -g aws-cdk`), plus Python 3.13+.
- The account/region **bootstrapped** for CDK (`cdk bootstrap`) — once per account/region.
- No local Docker required — the agent image is built by CodeBuild (ARM64).

## Deploy

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cdk bootstrap          # once per account/region
cdk deploy --all
```

Account and region come from your AWS profile (`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`), so the
app deploys with no edits. Everything else tunable lives in [config.py](config.py):

| Setting | Meaning | Default |
|---------|---------|---------|
| `EnvSettings.PROJECT_NAME` | Name prefix for **every** stack and resource | `bmkb-obs-cdk` |
| `EnvSettings.ACCOUNT_REGION` | Region to deploy into | `us-west-2` (or your profile's) |
| `KbConfig.EMBEDDING_MODEL_TYPE` | `MANAGED` (bundled) or `CUSTOM` (bring your own ARN) | `MANAGED` |
| `AgentConfig.MODEL_ID` | The agent's reasoning model — the Layer 6 spend | Claude Haiku 4.5 |
| `AgentConfig.BUILD_VERSION` | Bump to force a CodeBuild image rebuild | `1` |
| `EvalConfig.SAMPLING_PERCENTAGE` | Online-evaluation sampling rate — **see the disclaimer below** | `100` |

> **Changing `PROJECT_NAME`** gives you an isolated, independently-named copy of the whole solution,
> so two deployments can coexist in one account. The driver notebook reads the same constant, so it
> follows the rename automatically — there are no stack names to keep in sync by hand.

`cdk deploy --all` deploys these four stacks. **You do not choose the order** — CDK derives it from
the construct references passed in [app.py](app.py):

| # | Stack | What it creates | Note |
|---|-------|-----------------|------|
| 1 | `…-kb` | S3 bucket, corpora upload, two `Type: MANAGED` KBs, data sources, IAM, ingestion | KBs reach `ACTIVE`, corpora ingested |
| 2 | `…-gateway` | Gateway (AWS_IAM/MCP), per-KB `AgenticRetrieveStream` targets | no Cognito needed |
| 3 | `…-agent` | ECR, CodeBuild, instrumented Strands agent on Runtime, vended logs/traces, online eval | **~8–10 min** (image build) |
| 4 | `…-dashboards` | agentic-observability + kb-observability dashboards | empty until you drive traffic |

## Drive traffic & observe

Open [notebooks/01-drive-and-observe.ipynb](notebooks/01-drive-and-observe.ipynb) and run it top to
bottom (`pip install -r requirements-notebook.txt` first). It reads the stack outputs, sends financial
+ weather prompts to the deployed agent (per-KB sessions), then publishes the three custom-metric
layers the dashboards read:

- **Layer 3** — reference-free agentic retrieval quality → `BMKB/RetrievalQuality`
- **Layer 6** — per-session token usage from span `gen_ai.usage.*` → `BMKB/Cost`
- **Layer 7** — AgentCore Evaluate scores → `BMKB/Evaluation`

Then open the dashboards (URLs are printed, and are stack outputs). Set a **3-hour** range and
refresh — CloudWatch metric values lag emission by 1–5 minutes.

## The two dashboards

- **`…-agentic-observability`** — the end-to-end 7-layer view: KB metrics (L1), agentic retrieval
  quality per KB (L3), Gateway calls + latency (L4), token usage (L6), eval scores (L7), and the
  span table (L5).
- **`…-kb-observability`** — the per-KB operational signals that also determine spend: index size
  (MB), retrieve volume, agentic tool-calls, session token usage, and generation token usage by model.

The dashboards stack also outputs `GenAiObservabilityUrl` — a deep link to the console's built-in
**GenAI Observability** view for this agent runtime, which is AWS's own rendering of the same L5/L6
span data.

## Evaluation: on-demand and continuous

Layer 7 is covered two ways:

- **On-demand** — the driver notebook calls `evaluate()` over each session's spans and publishes to
  `BMKB/Evaluation` (feeds the L7 dashboard widget).
- **Continuous (online)** — the agent stack provisions an
  `AWS::BedrockAgentCore::OnlineEvaluationConfig` that samples live sessions and scores them
  automatically; results appear in the console under **CloudWatch → GenAI Observability → Bedrock
  AgentCore → Evaluations**, and in the log group
  `/aws/bedrock-agentcore/evaluations/results/<config-id>`.

> **Online results only arrive after a session closes.** Scoring runs on the *completed* session,
> so the results log group stays empty for roughly the session idle timeout (~30 minutes) after you
> drive traffic — an empty group right after a run is expected, not a misconfiguration. Each result
> event carries `session.id`, so it joins to every other layer. The on-demand path in the notebook
> has no such wait, which is why both are here.

> **⚠️ Sampling disclaimer.** This app sets **`SAMPLING_PERCENTAGE = 100`** *purely for the blog
> experiment*, so every session is scored and the results are immediately visible. **This is not a
> production recommendation.** Online evaluation invokes an LLM-as-judge per sampled session, which
> **incurs cost that scales with the sampling rate and traffic volume**. For any real deployment,
> choose a sampling percentage that reflects your quality-monitoring needs and budget, and **align
> the configuration with your organization's own policies and cost-governance requirements** before
> enabling it. Tune `EvalConfig.SAMPLING_PERCENTAGE` in [config.py](config.py).

## What CDK changes

The deployed result is identical to the CloudFormation sibling — the same resources, the same
properties. What differs is what you have to write and maintain:

| Concern | CloudFormation version | This CDK version |
|---------|------------------------|------------------|
| Cross-stack wiring | `Export` + `Fn::ImportValue` per value, kept in sync by hand | pass the construct; CDK derives the export *and* the dependency |
| Deploy order | `scripts/deploy.sh` sequences the four stacks and threads outputs forward | `cdk deploy --all` — order is derived from the references |
| Teardown order | `scripts/cleanup.sh` deletes in hand-written reverse order | `cdk destroy --all` |
| Uploading corpora | the ingest custom resource doubles as an uploader | `BucketDeployment` |
| Emptying the bucket | hand-written `list_object_versions` delete loop | `auto_delete_objects=True` |
| Emptying the ECR repo | hand-written image delete loop | `empty_on_delete=True` |
| Long-running custom resources | one Lambda that sleeps in a poll loop against its own 15-min ceiling | `Provider`'s `on_event` / `is_complete` split — nothing blocks |
| CFN response protocol | vendored `urllib` callback in each handler | owned by the `Provider` framework |
| ECR permissions for the build | eight hand-spelled `ecr:*` actions | `repository.grant_pull_push(project)` |
| Dashboards | ~12 KB of `DashboardBody` JSON inside a `!Sub` string | typed `Metric` / `GraphWidget` / `Row` objects |
| Invalid widget combinations | accepted at deploy, silently broken in the console | rejected at `cdk synth` |
| Helper-Lambda log groups | default: never expire, survive the stack | explicit 1-week groups that go away with the stack |

Two things CDK does **not** change, and they are worth knowing:

- **Free-form JSON stays camelCase.** `connector_parameters` and `parameter_values` are passed
  through verbatim, so CDK's snake_case → PascalCase conversion does not apply inside them. Keys
  like `bucketName` and `inclusionPrefixes` must be spelled exactly as the API expects.
- **L1 dimensions are prefixed.** `AWS/Bedrock/KnowledgeBases` wants
  `KnowledgeBaseId: knowledge-base/<id>`, not the bare id the `BMKB/*` namespaces use. The typed
  API will not catch that for you.

## Cleanup

```bash
cdk destroy --all
```

CDK deletes the stacks in reverse dependency order on its own. The S3 source bucket empties itself
(`auto_delete_objects`) and the ECR repository empties itself (`empty_on_delete`), so nothing stalls
on a non-empty resource. Both are set for sample hygiene — for anything you care about, switch the
bucket to `RemovalPolicy.RETAIN`.

The CDK bootstrap stack (`CDKToolkit`) and its staging bucket are **not** removed — they are shared
account-wide infrastructure, and other CDK apps in the account may depend on them.
