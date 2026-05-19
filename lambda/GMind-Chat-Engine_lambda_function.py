import json
import os
import re
from typing import Optional

import boto3

bedrock_agent_runtime = boto3.client("bedrock-agent-runtime")

HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Content-Type": "application/json",
}

ORDERING_PATTERN = re.compile(
    r"\b(latest|last|most recent|newest|first|second|third|1st|2nd|3rd)\b",
    re.IGNORECASE,
)

GREETING_PATTERN = re.compile(
    r"^(hi|hello|hey|hiya|howdy|yo|sup|what'?s up|whats up|good morning|good afternoon|"
    r"good evening|good night|gm|gn|morning|afternoon|evening)(\s+there)?[!.?]*$",
    re.IGNORECASE,
)

THANKS_PATTERN = re.compile(
    r"^(thanks|thank you|thx|ty|appreciate it|much appreciated)[!.?]*$",
    re.IGNORECASE,
)

ACK_PATTERN = re.compile(
    r"^(ok|okay|k|cool|nice|got it|understood|sure|alright|fine|great|perfect)[!.?]*$",
    re.IGNORECASE,
)

HOW_ARE_YOU_PATTERN = re.compile(
    r"^(how are you|how'?re you|how r u|how do you do|how'?s it going|how are things)[!.?]*$",
    re.IGNORECASE,
)

BYE_PATTERN = re.compile(
    r"^(bye|goodbye|see you|see ya|take care|later|catch you later)[!.?]*$",
    re.IGNORECASE,
)

PROMPT_TEMPLATE = (
    "You are G-Mind, a friendly Gmail assistant. Answer using the retrieved email documents when the "
    "question is about the user's emails.\n\n"
    "CRITICAL INSTRUCTIONS:\n"
    "0. SMALL TALK: If the user only greets you, says thanks, ok, or asks how you are — reply warmly "
    "in 1–2 short sentences like a helpful colleague. Do NOT search emails or say 'not in context'.\n"
    "1. ORDERING: Use 'Received:' (dd-mm-yyyy hh:mm am/pm) for time comparisons. "
    "Use 'Sync order: 1' as the most recent email in the synced inbox when dates are unclear. "
    "Never mention sync order numbers, inbox rank, or message ids in your answer.\n"
    "2. DATES: Use exactly the Received format from the document.\n"
    "3. NO TECHNICAL TAGS: Do not output raw JSON, XML tags, or S3 paths.\n"
    "4. CITATIONS: For email answers, mention **From**, **Subject**, and **Received** only.\n"
    "5. If an email question is not in the retrieved context, say so briefly and suggest resyncing.\n\n"
    "Context:\n$search_results$\n\n"
    "Question: $query$\n\n"
    "Answer:"
)


def _normalize_question(question: str) -> str:
    q = question.strip().lower()
    q = re.sub(r"\s+", " ", q)
    return q


def _inbox_hint(emails: list) -> str:
    if not emails:
        return " Sync your inbox if you haven't yet, and I can help you search it."
    by_sync = sorted(emails, key=lambda e: e.get("sync_order", 999))
    latest = by_sync[0]
    subject = (latest.get("subject") or "your latest message")[:80]
    n = len(emails)
    return (
        f" You have {n} email{'s' if n != 1 else ''} synced — the newest is about "
        f"\"{subject}\". Ask me anything about them."
    )


def _try_casual_reply(question: str, emails: list) -> Optional[str]:
    q = _normalize_question(question)
    if not q:
        return None

    hint = _inbox_hint(emails)

    if GREETING_PATTERN.match(q):
        if "morning" in q or q == "gm":
            return f"Good morning! Hope you're having a nice start to the day.{hint}"
        if "evening" in q or "afternoon" in q:
            return f"Hello! Good to see you.{hint}"
        return f"Hey! I'm G-Mind — here to help with your Gmail.{hint}"

    if HOW_ARE_YOU_PATTERN.match(q):
        return (
            f"I'm doing well, thanks for asking! Ready to help with your inbox.{hint}"
        )

    if THANKS_PATTERN.match(q):
        return "You're welcome! Happy to help anytime."

    if ACK_PATTERN.match(q):
        return f"Sounds good! Just ask when you want to look something up in your emails.{hint}"

    if BYE_PATTERN.match(q):
        return "Take care! Come back anytime you need help with your inbox."

    return None


def _format_citation(em: dict) -> str:
    when = em.get("received_at_display") or em.get("date") or "Unknown time"
    return (
        f"**From:** {em.get('from', 'Unknown')}\n"
        f"**Subject:** {em.get('subject', 'No subject')}\n"
        f"**Received:** {when}"
    )


def _pick_email_by_order(emails: list, question: str):
    if not emails:
        return None, None
    q = question.lower()
    # Gmail ingest order: index 0 = newest (sync_order 1)
    by_sync = sorted(emails, key=lambda e: e.get("sync_order", 999))
    if re.search(r"\b(second|2nd)\b", q):
        return by_sync[1] if len(by_sync) > 1 else None, "second"
    if re.search(r"\b(third|3rd)\b", q):
        return by_sync[2] if len(by_sync) > 2 else None, "third"
    if re.search(r"\b(first|1st)\b", q) and not re.search(
        r"\b(latest|last|most recent|newest)\b", q
    ):
        return by_sync[0], "first"
    if re.search(r"\b(latest|last|most recent|newest)\b", q):
        return by_sync[0], "latest"
    return None, None


def _try_ordering_answer(question: str, emails: list):
    if not emails or not ORDERING_PATTERN.search(question):
        return None
    em, label = _pick_email_by_order(emails, question)
    if not em:
        return "That position is not in your current sync."
    label_text = {
        "latest": "The most recent email in your sync is",
        "first": "The first email in your sync (newest) is",
        "second": "The second email in your sync is",
        "third": "The third email in your sync is",
    }.get(label, "The email is")
    return f"{label_text}:\n\n{_format_citation(em)}"


def lambda_handler(event, context):
    try:
        http_method = (event.get("httpMethod") or "").upper()
        if http_method == "OPTIONS":
            return {"statusCode": 200, "headers": HEADERS, "body": ""}

        raw_body = event.get("body", "{}")
        body = json.loads(raw_body) if isinstance(raw_body, str) else raw_body
        user_question = body.get("question")
        emails = body.get("emails") or []

        if not user_question:
            return {
                "statusCode": 400,
                "headers": HEADERS,
                "body": json.dumps({"error": "No question provided"}),
            }

        casual = _try_casual_reply(user_question, emails)
        if casual:
            return {
                "statusCode": 200,
                "headers": HEADERS,
                "body": json.dumps({"answer": casual}),
            }

        direct = _try_ordering_answer(user_question, emails)
        if direct:
            return {
                "statusCode": 200,
                "headers": HEADERS,
                "body": json.dumps({"answer": direct}),
            }

        kb_id = os.environ["KB_ID"]
        model_arn = os.environ.get(
            "BEDROCK_MODEL_ARN",
            "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
        )
        num_results = int(os.environ.get("KB_NUM_RESULTS", "25"))

        response = bedrock_agent_runtime.retrieve_and_generate(
            input={"text": user_question},
            retrieveAndGenerateConfiguration={
                "type": "KNOWLEDGE_BASE",
                "knowledgeBaseConfiguration": {
                    "knowledgeBaseId": kb_id,
                    "modelArn": model_arn,
                    "retrievalConfiguration": {
                        "vectorSearchConfiguration": {
                            "numberOfResults": num_results,
                        }
                    },
                    "generationConfiguration": {
                        "inferenceConfig": {
                            "textInferenceConfig": {
                                "temperature": float(
                                    os.environ.get("BEDROCK_TEMPERATURE", "0.1")
                                ),
                                "topP": 0.9,
                                "maxTokens": 1000,
                            }
                        },
                        "promptTemplate": {
                            "textPromptTemplate": PROMPT_TEMPLATE,
                        },
                    },
                },
            },
        )

        return {
            "statusCode": 200,
            "headers": HEADERS,
            "body": json.dumps({"answer": response["output"]["text"]}),
        }
    except Exception as e:
        print(f"Error: {str(e)}")
        return {
            "statusCode": 500,
            "headers": HEADERS,
            "body": json.dumps({"error": str(e)}),
        }
