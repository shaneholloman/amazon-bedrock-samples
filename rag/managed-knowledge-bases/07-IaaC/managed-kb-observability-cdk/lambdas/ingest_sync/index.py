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
Initial knowledge-base ingestion, as a CDK ``Provider`` custom resource.

``StartIngestionJob`` has no CloudFormation resource of its own, so the first sync
after the data sources exist has to be driven by code. The provider framework splits
that across two handlers:

``on_event``
    Starts one ingestion job per data source and returns immediately, handing the
    job ids forward.
``is_complete``
    Called on a timer until it returns ``IsComplete: True``.

Splitting it this way means no Lambda ever sits blocked polling a long-running job,
which is what the CloudFormation version of this sample has to do (a single handler
that sleeps in a loop against its own 15-minute ceiling). The framework also owns the
CloudFormation response protocol, so there is no hand-vendored ``urllib`` callback
here, and a crash surfaces as a stack error instead of a stack that hangs for an hour.

Resource properties
-------------------
Ingestions : list[str]
    One ``"<kbId>|<dataSourceId>"`` entry per data source to sync.

Note the corpora are already in place: the stack uploads them with a
``BucketDeployment``, so this resource only ever *ingests*.
"""

import json

import boto3

bedrock_agent = boto3.client("bedrock-agent")

TERMINAL_OK = "COMPLETE"
TERMINAL_BAD = {"FAILED", "STOPPED"}


def _parse(entry: str) -> tuple:
    kb_id, ds_id = entry.split("|")
    return kb_id, ds_id


def on_event(event, context):
    """Create/Update: start an ingestion job per data source. Delete: no-op."""
    print(json.dumps({"RequestType": event.get("RequestType"),
                      "ResourceProperties": event.get("ResourceProperties", {})}))

    request_type = event["RequestType"]
    physical_id = event.get("PhysicalResourceId", "bmkb-ingest-sync")

    # Nothing to undo — ingested data goes away with the knowledge bases themselves,
    # and the bucket is emptied by the stack's auto_delete_objects.
    if request_type == "Delete":
        return {"PhysicalResourceId": physical_id, "Data": {}}

    jobs = []
    for entry in event["ResourceProperties"].get("Ingestions", []):
        kb_id, ds_id = _parse(entry)
        job = bedrock_agent.start_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id)
        job_id = job["ingestionJob"]["ingestionJobId"]
        print(f"started ingestion {job_id} for kb={kb_id} ds={ds_id}")
        jobs.append(f"{kb_id}|{ds_id}|{job_id}")

    return {
        "PhysicalResourceId": physical_id,
        # is_complete reads this back out of the event to know what to poll.
        "Data": {"Jobs": json.dumps(jobs)},
    }


def is_complete(event, context):
    """Return IsComplete once every started job has reached a terminal state."""
    if event["RequestType"] == "Delete":
        return {"IsComplete": True}

    # The framework merges on_event's return value into the event it hands the
    # poller, so Data.Jobs is what was started. If the key is missing something is
    # wrong upstream — better to fail loudly than to report an unstarted ingestion
    # as complete and let the gateway query an empty knowledge base.
    if "Jobs" not in event.get("Data", {}):
        raise RuntimeError("No Jobs in event data — ingestion was never started.")

    jobs = json.loads(event["Data"]["Jobs"])
    if not jobs:
        # Legitimately nothing to sync (no Ingestions configured).
        return {"IsComplete": True}

    for entry in jobs:
        kb_id, ds_id, job_id = entry.split("|")
        status = bedrock_agent.get_ingestion_job(
            knowledgeBaseId=kb_id, dataSourceId=ds_id, ingestionJobId=job_id,
        )["ingestionJob"]["status"]
        print(f"ingestion {job_id} (kb={kb_id}): {status}")

        # Raising here fails the stack operation with this message — the provider
        # framework stops polling and reports it, rather than timing out silently.
        if status in TERMINAL_BAD:
            raise RuntimeError(f"Ingestion job {job_id} for kb={kb_id} ended {status}")
        if status != TERMINAL_OK:
            return {"IsComplete": False}

    print("all ingestion jobs COMPLETE")
    return {"IsComplete": True}
