import asyncio
import os

import httpx
from dotenv import load_dotenv
from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import Application, CommandHandler, MessageHandler, filters, CallbackContext


load_dotenv()

TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
BASE_URL = os.environ.get("ADK_SERVER_URL", "http://localhost:8000").rstrip("/")
ADK_APP_NAME = os.environ.get("ADK_APP_NAME", "expense_bot")


async def start(update: Update, context: CallbackContext) -> None:
    if update.message is None:
        return

    await update.message.reply_text(
        "Finance Tracker Bot\n\n"
        "I can help you track income and expenses.\n\n"
        "Try:\n"
        "• Add 500 expense for groceries\n"
        "• How much did I spend this month?\n"
        "• Show my last 5 transactions"
    )


async def send_typing_loop(chat_id: int, bot, stop_event: asyncio.Event):
    while not stop_event.is_set():
        try:
            await bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)
            await asyncio.sleep(4)
        except Exception:
            await asyncio.sleep(1)


def extract_reply_text(events) -> str:
    if not isinstance(events, list):
        return ""

    collected_texts = []

    for event in events:
        if not isinstance(event, dict):
            continue

        content = event.get("content") or {}
        parts = content.get("parts") or []

        if isinstance(parts, list):
            for part in parts:
                if isinstance(part, dict):
                    text = part.get("text")
                    if isinstance(text, str) and text.strip():
                        collected_texts.append(text.strip())

    return collected_texts[-1] if collected_texts else ""


async def handle_message(update: Update, context: CallbackContext) -> None:
    message = update.message
    if message is None:
        return

    user_message = (message.text or "").strip()
    if not user_message:
        await message.reply_text("Please send a text message.")
        return

    chat_id = message.chat_id

    if message.from_user is None:
        return

    raw_user_id = str(message.from_user.id)

    user_id = f"tg_{raw_user_id}"
    session_id = f"tg_sess_{raw_user_id}"

    stop_event = asyncio.Event()
    typing_task = asyncio.create_task(
        send_typing_loop(chat_id, context.bot, stop_event)
    )

    reply_text = "The agent returned an empty response."

    try:
        async with httpx.AsyncClient() as client:
            session_url = f"{BASE_URL}/apps/{ADK_APP_NAME}/users/{user_id}/sessions/{session_id}"
            session_check = await client.get(session_url, timeout=10.0)

            if session_check.status_code == 404:
                await client.post(session_url, json={}, timeout=10.0)

            response = await client.post(
                f"{BASE_URL}/run",
                json={
                    "appName": ADK_APP_NAME,
                    "userId": user_id,
                    "sessionId": session_id,
                    "newMessage": {
                        "role": "user",
                        "parts": [{"text": user_message}]
                    }
                },
                timeout=60.0
            )

            if response.status_code == 200:
                events = response.json()
                reply_text = extract_reply_text(events)

                if not reply_text:
                    reply_text = "The agent returned no text response."
            else:
                reply_text = f"Agent error (status {response.status_code})."

    except Exception as e:
        reply_text = f"Could not connect to agent: {e}"

    finally:
        stop_event.set()
        await typing_task

    reply_text = str(reply_text or "").replace("**", "").replace("*", "").strip()

    print("DEBUG reply_text =", repr(reply_text))

    if not reply_text:
        reply_text = "The agent returned an empty response."

    await message.reply_text(reply_text)


def main():
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    print("🤖 Telegram Finance Bot running (polling mode)...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()