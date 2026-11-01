"""
AWS Lambda: archive old S3 objects when the Archive Button is pressed.

Trigger: an AWS IoT Core rule on topic  archive-button/+/press  (see README).
Nothing is deleted: each old object is copied onto itself with a new storage
class (GLACIER), which is how S3 changes an object's tier in place.

Environment variables
  BUCKET            bucket to archive (required)
  PREFIX            only archive keys under this prefix (default: "")
  AGE_LIMIT_DAYS    archive objects older than this (default: 90)
  TARGET_CLASS      GLACIER | GLACIER_IR | DEEP_ARCHIVE (default: GLACIER)
  TABLE_NAME        DynamoDB table for the run log (partition key: runId, string)
  ALERT_TOPIC_ARN   SNS topic for failure notifications (optional)

Result is published to  archive-button/<deviceId>/result  so the device can
play the right buzzer pattern: success -> 1 beep, partial -> 2, failed -> long.
"""
import json
import os
import time
import uuid
from datetime import datetime, timedelta, timezone

import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")
iot = boto3.client("iot-data")
sns = boto3.client("sns")
table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"]) if os.environ.get("TABLE_NAME") else None

BUCKET = os.environ.get("BUCKET", "")
PREFIX = os.environ.get("PREFIX", "")
AGE_LIMIT_DAYS = int(os.environ.get("AGE_LIMIT_DAYS", "90"))
TARGET_CLASS = os.environ.get("TARGET_CLASS", "GLACIER")
ALERT_TOPIC_ARN = os.environ.get("ALERT_TOPIC_ARN")
MAX_COPY_BYTES = 5 * 1024 ** 3  # copy_object limit; larger objects need multipart copy


def archive_old_objects():
    cutoff = datetime.now(timezone.utc) - timedelta(days=AGE_LIMIT_DAYS)
    moved = failed = skipped = bytes_moved = 0
    errors = []

    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=PREFIX):
        for obj in page.get("Contents", []):
            if obj["LastModified"] >= cutoff:
                continue
            if obj.get("StorageClass", "STANDARD") != "STANDARD":
                continue  # already archived (or in another tier)
            if obj["Size"] > MAX_COPY_BYTES:
                skipped += 1
                errors.append(f"{obj['Key']}: larger than 5 GB, skipped")
                continue
            try:
                s3.copy_object(
                    Bucket=BUCKET,
                    Key=obj["Key"],
                    CopySource={"Bucket": BUCKET, "Key": obj["Key"]},
                    StorageClass=TARGET_CLASS,
                    MetadataDirective="COPY",
                    TaggingDirective="COPY",
                )
                moved += 1
                bytes_moved += obj["Size"]
            except ClientError as e:
                failed += 1
                errors.append(f"{obj['Key']}: {e.response['Error']['Code']}")
                # A permission error will hit every object, so stop early.
                if e.response["Error"]["Code"] in ("AccessDenied", "AllAccessDisabled"):
                    break
        else:
            continue
        break
    return moved, failed, skipped, bytes_moved, errors


def lambda_handler(event, context):
    device_id = (event or {}).get("deviceId", "archive-button-01")
    run_id = str(uuid.uuid4())
    started = time.time()
    run = {
        "runId": run_id,
        "deviceId": device_id,
        "time": datetime.now(timezone.utc).isoformat(),
        "bucket": BUCKET,
        "ageLimitDays": AGE_LIMIT_DAYS,
    }

    try:
        if not BUCKET:
            raise RuntimeError("BUCKET environment variable is not set")
        moved, failed, skipped, bytes_moved, errors = archive_old_objects()
        if failed or skipped:
            status = "partial" if moved else "failed"
        else:
            status = "success"
        run.update(filesMoved=moved, filesFailed=failed, filesSkipped=skipped,
                   bytesMoved=bytes_moved, errors=errors[:20])
    except Exception as e:  # noqa: BLE001 - we want every failure logged and reported
        status = "failed"
        run.update(filesMoved=0, errors=[str(e)])

    run["status"] = status
    run["durationMs"] = int((time.time() - started) * 1000)
    print(json.dumps(run))  # CloudWatch Logs; CloudTrail already records the S3 calls

    if table:
        table.put_item(Item=json.loads(json.dumps(run), parse_float=str))

    # Tell the device which buzzer pattern to play.
    iot.publish(
        topic=f"archive-button/{device_id}/result",
        qos=1,
        payload=json.dumps({"runId": run_id, "status": status}),
    )

    if status != "success" and ALERT_TOPIC_ARN:
        sns.publish(
            TopicArn=ALERT_TOPIC_ARN,
            Subject=f"Archive Button: run {status}",
            Message=json.dumps(run, indent=2),
        )
    return {"status": status, "runId": run_id}
