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
Agent image build, as a CDK ``Provider`` custom resource.

The AgentCore Runtime cannot start without an image already sitting at the tag it
points to, and CodeBuild has no CloudFormation resource that means "run this build
now and wait". So the deploy needs one custom resource to start the build and block
the runtime's creation until the push finishes.

``on_event``
    Starts the build and returns the build id.
``is_complete``
    Called on a timer until the build reaches a terminal state.

The build takes roughly 8–10 minutes, comfortably past what a single Lambda should
sit blocked for. The CloudFormation version of this sample has to sleep in a loop
against its own 15-minute ceiling and compute a deadline from
``get_remaining_time_in_millis``; splitting the work across two handlers removes
that constraint entirely, and the framework owns the response protocol so there is
no hand-vendored ``urllib`` callback here either.

Resource properties
-------------------
ProjectName : str
    CodeBuild project to run.
SourceHash, BuildVersion : str
    Not read by this handler — they exist so that changing the agent source (or
    bumping the version by hand) changes the resource and re-runs the build.
"""

import json

import boto3

codebuild = boto3.client("codebuild")

SUCCEEDED = "SUCCEEDED"
TERMINAL_BAD = {"FAILED", "FAULT", "STOPPED", "TIMED_OUT"}


def on_event(event, context):
    """Create/Update: start the image build. Delete: no-op."""
    print(json.dumps({"RequestType": event.get("RequestType"),
                      "ResourceProperties": event.get("ResourceProperties", {})}))

    request_type = event["RequestType"]
    physical_id = event.get("PhysicalResourceId", "bmkb-agent-image-build")

    # Nothing to undo: the images go away with the ECR repository (empty_on_delete).
    if request_type == "Delete":
        return {"PhysicalResourceId": physical_id, "Data": {}}

    project_name = event["ResourceProperties"]["ProjectName"]
    build_id = codebuild.start_build(projectName=project_name)["build"]["id"]
    print(f"started build {build_id} in project {project_name}")

    return {
        "PhysicalResourceId": physical_id,
        # is_complete reads this back out of the event to know what to poll.
        "Data": {"BuildId": build_id},
    }


def is_complete(event, context):
    """Return IsComplete once the build has succeeded; raise if it failed."""
    if event["RequestType"] == "Delete":
        return {"IsComplete": True}

    build_id = event.get("Data", {}).get("BuildId")
    if not build_id:
        # on_event always hands a build id forward, so a missing one means something
        # is wrong upstream. Failing loudly beats reporting a build that never ran
        # as complete and letting the runtime fail on a missing image.
        raise RuntimeError("No BuildId in event data — the build was never started.")

    build = codebuild.batch_get_builds(ids=[build_id])["builds"][0]
    status = build["buildStatus"]
    print(f"build {build_id}: {status}")

    if status in TERMINAL_BAD:
        # Raising here fails the stack operation with this message, so the reason
        # shows up in the CloudFormation events rather than as a silent timeout.
        phase = build.get("currentPhase", "unknown")
        raise RuntimeError(
            f"CodeBuild {build_id} ended {status} in phase {phase}. "
            f"See the build log for details."
        )
    if status != SUCCEEDED:
        return {"IsComplete": False}

    print(f"build {build_id} SUCCEEDED — image pushed")
    return {"IsComplete": True}
