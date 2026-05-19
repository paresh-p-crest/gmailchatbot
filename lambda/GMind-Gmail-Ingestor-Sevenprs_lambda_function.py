import json
import os
from datetime import timezone
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo

import boto3
from botocore.exceptions import ClientError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

s3 = boto3.client("s3")
ssm = boto3.client("ssm")

SSM_CLIENT_ID_PARAM = os.environ.get("SSM_GOOGLE_CLIENT_ID", "/gmind/client_id")
SSM_CLIENT_SECRET_PARAM = os.environ.get("SSM_GOOGLE_CLIENT_SECRET", "/gmind/client_secret")

BUCKET = os.environ.get("S3_BUCKET", "lexiguard-gmail-data-ps-b402")
TOKEN_KEY = os.environ.get("TOKEN_S3_KEY", "private/token.json")
REDIRECT_URI = os.environ.get("OAUTH_REDIRECT_URI", "http://localhost:5173")
# One .txt per email for Bedrock KB — data source: s3://<bucket>/ingest/
KB_PREFIX = os.environ.get("KB_S3_PREFIX", "ingest/")
DISPLAY_TZ = ZoneInfo(os.environ.get("DISPLAY_TIMEZONE", "Asia/Kolkata"))

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]

HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Content-Type": "application/json",
}


def _parse_body(event):
    raw = event.get("body")
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        if event.get("isBase64Encoded"):
            import base64

            raw = base64.b64decode(raw).decode("utf-8")
        return json.loads(raw) if raw.strip() else {}
    return {}


def _parse_limit(body):
    try:
        n = int(body.get("limit", 10))
    except (TypeError, ValueError):
        n = 10
    return max(1, min(n, 500))


def get_google_secrets():
    id_param = ssm.get_parameter(Name=SSM_CLIENT_ID_PARAM)
    secret_param = ssm.get_parameter(Name=SSM_CLIENT_SECRET_PARAM, WithDecryption=True)
    return {
        "GOOGLE_CLIENT_ID": id_param["Parameter"]["Value"],
        "GOOGLE_CLIENT_SECRET": secret_param["Parameter"]["Value"],
    }


def _credentials_from_s3_token_json(token_json: str, google_secrets: dict) -> Credentials:
    info = json.loads(token_json)
    # Ensure token refresh has OAuth client id/secret (required by Google's refresh endpoint)
    info.setdefault("client_id", google_secrets["GOOGLE_CLIENT_ID"])
    info.setdefault("client_secret", google_secrets["GOOGLE_CLIENT_SECRET"])
    return Credentials.from_authorized_user_info(info, SCOPES)


def _persist_credentials(creds: Credentials) -> None:
    s3.put_object(
        Bucket=BUCKET,
        Key=TOKEN_KEY,
        Body=creds.to_json(),
        ContentType="application/json",
    )


def _parse_received_datetime(date_header: str):
    if not date_header or not str(date_header).strip():
        return None
    try:
        dt = parsedate_to_datetime(str(date_header).strip())
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _format_display_date(date_header: str) -> str:
    dt = _parse_received_datetime(date_header)
    if not dt:
        return ""
    local = dt.astimezone(DISPLAY_TZ)
    formatted = local.strftime("%d-%m-%Y %I:%M %p")
    return formatted.replace(" AM", " am").replace(" PM", " pm")


def _parse_received_iso(date_header: str) -> str:
    dt = _parse_received_datetime(date_header)
    if not dt:
        return ""
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _build_kb_text(email: dict) -> str:
    received = email.get("received_at_display") or email.get("date", "")
    sync_order = email.get("sync_order", "")
    return "\n".join(
        [
            f"Gmail message id: {email.get('id', '')}",
            f"Sync order: {sync_order} (1 = most recent in this Gmail sync)",
            f"Received: {received}",
            f"From: {email.get('from', '')}",
            f"To: {email.get('to', '')}",
            f"Subject: {email.get('subject', '')}",
            "",
            "Body snippet:",
            email.get("body_snippet", ""),
        ]
    )


def _clear_kb_objects(prefix: str) -> None:
    """Remove prior sync .txt files (and legacy emails.json) under ingest/."""
    if not prefix.endswith("/"):
        prefix = prefix + "/"
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if key.endswith(".txt") or key.endswith("emails.json"):
                s3.delete_object(Bucket=BUCKET, Key=key)


def _upload_kb_documents(email_data: list) -> int:
    prefix = KB_PREFIX if KB_PREFIX.endswith("/") else KB_PREFIX + "/"
    _clear_kb_objects(prefix)
    for rank, email in enumerate(email_data, start=1):
        key = f"{prefix}{rank:03d}_{email['id']}.txt"
        s3.put_object(
            Bucket=BUCKET,
            Key=key,
            Body=_build_kb_text(email),
            ContentType="text/plain; charset=utf-8",
        )
    return len(email_data)


def _start_kb_ingestion_job() -> None:
    kb_id = os.environ.get("KB_ID")
    ds_id = os.environ.get("DATA_SOURCE_ID")
    if not kb_id or not ds_id:
        print("KB_ID or DATA_SOURCE_ID not set; skipping Bedrock sync trigger.")
        return
    bedrock_agent = boto3.client("bedrock-agent")
    print(f"Triggering Knowledge Base sync for KB: {kb_id}")
    bedrock_agent.start_ingestion_job(
        knowledgeBaseId=kb_id,
        dataSourceId=ds_id,
    )


def lambda_handler(event, context):
    try:
        body = _parse_body(event)
        auth_code = body.get("code")
        email_limit = _parse_limit(body)

        google_secrets = get_google_secrets()
        os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"

        flow = Flow.from_client_config(
            client_config={
                "web": {
                    "client_id": google_secrets["GOOGLE_CLIENT_ID"],
                    "client_secret": google_secrets["GOOGLE_CLIENT_SECRET"],
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                }
            },
            scopes=SCOPES,
            redirect_uri=REDIRECT_URI,
        )

        if not auth_code:
            # Silent resync: load stored user OAuth token from S3 and refresh if needed
            try:
                token_obj = s3.get_object(Bucket=BUCKET, Key=TOKEN_KEY)
                raw = token_obj["Body"].read()
                token_json = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
                creds = _credentials_from_s3_token_json(token_json, google_secrets)
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code", "")
                if code in ("NoSuchKey", "404"):
                    return {
                        "statusCode": 401,
                        "headers": HEADERS,
                        "body": json.dumps(
                            {"error": "no_stored_session", "message": "No stored token. Sign in with Google first."}
                        ),
                    }
                raise
            except (json.JSONDecodeError, ValueError, KeyError) as e:
                return {
                    "statusCode": 401,
                    "headers": HEADERS,
                    "body": json.dumps(
                        {"error": "invalid_stored_token", "message": str(e)}
                    ),
                }

            if not creds.refresh_token:
                return {
                    "statusCode": 401,
                    "headers": HEADERS,
                    "body": json.dumps(
                        {
                            "error": "missing_refresh_token",
                            "message": "Stored token has no refresh_token. Sign in again once (use consent so Google issues a refresh token).",
                        }
                    ),
                }

            if creds.expired:
                creds.refresh(Request())
                _persist_credentials(creds)
        else:
            flow.fetch_token(code=auth_code)
            creds = flow.credentials
            _persist_credentials(creds)

        user_service = build("oauth2", "v2", credentials=creds)
        user_info = user_service.userinfo().get().execute()

        gmail = build("gmail", "v1", credentials=creds)
        results = gmail.users().messages().list(userId="me", maxResults=email_limit).execute()

        email_data = []
        for msg in results.get("messages", []):
            m = gmail.users().messages().get(userId="me", id=msg["id"]).execute()
            h = m["payload"]["headers"]
            date_header = next((x["value"] for x in h if x["name"] == "Date"), "")
            email_data.append(
                {
                    "id": msg["id"],
                    "from": next((x["value"] for x in h if x["name"] == "From"), "Unknown"),
                    "subject": next((x["value"] for x in h if x["name"] == "Subject"), "No Sub"),
                    "date": date_header,
                    "received_at_display": _format_display_date(date_header),
                    "received_at_iso": _parse_received_iso(date_header),
                    "sync_order": len(email_data) + 1,
                    "to": next((x["value"] for x in h if x["name"] == "To"), "Me"),
                    "body_snippet": m["snippet"],
                }
            )

        # Bedrock KB: one .txt per email under s3://<bucket>/ingest/
        # UI left panel uses emails[] in this API response (localStorage in browser).
        kb_files_written = _upload_kb_documents(email_data)

        try:
            _start_kb_ingestion_job()
        except Exception as sync_err:
            print(f"KB ingestion job failed to start (S3 txt files still saved): {sync_err}")

        return {
            "statusCode": 200,
            "headers": HEADERS,
            "body": json.dumps(
                {
                    "status": "SUCCESS",
                    "user": {
                        "name": user_info.get("name") or "User",
                        "email": user_info.get("email") or "",
                        "picture": user_info.get("picture") or "",
                    },
                    "emails": email_data,
                    "kb_files_written": kb_files_written,
                }
            ),
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "headers": HEADERS,
            "body": json.dumps({"error": str(e)}),
        }
