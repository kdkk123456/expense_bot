import asyncio
from dotenv import load_dotenv  # ✅ add this
load_dotenv() 
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai.types import Content, Part
from agent import root_agent

async def main():
    session_service = InMemorySessionService()
    runner = Runner(
        agent=root_agent,
        session_service=session_service,
        app_name="finance_app"
    )

    session = await session_service.create_session(
        app_name="finance_app",
        user_id="user1"
    )

    print("💰 Finance Tracker ready! Type 'quit' to exit.\n")

    while True:
        user_input = input("You: ")
        if user_input.lower() == "quit":
            break

        message = Content(
            role="user",
            parts=[Part(text=user_input)]
        )

        async for event in runner.run_async(
            user_id="user1",
            session_id=session.id,
            new_message=message
        ):
            if event.is_final_response():
                # ✅ safe access with None checks
                if event.content and event.content.parts:
                    print(f"Agent: {event.content.parts[0].text}\n")
                else:
                    print("Agent: (no response)\n")

if __name__ == "__main__":
    asyncio.run(main())