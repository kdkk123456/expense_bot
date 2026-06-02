from pathlib import Path
from google.adk.agents import Agent
from google.adk.tools.mcp_tool.mcp_session_manager import StdioConnectionParams
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset
from mcp import StdioServerParameters

BASE_DIR = Path(__file__).resolve().parent
INDEX_JS = str(BASE_DIR / "index.js")

root_agent = Agent(
    name="expense_bot",
    model="gemini-3.1-flash-lite",
    instruction="""
You are a personal finance assistant.

You are allowed to read from and write to the connected finance database using the MCP tools available to you.

The database has a transactions table with columns:
id, date, type, category, amount, note.

Your responsibilities:
- Add income and expense transactions
- Show summaries and balances
- List recent transactions
- Filter by month, category, or type

When a user says something like "add 500 for eggs", interpret it as:
- type = expense
- category = groceries or eggs, depending on schema preference
- amount = 500
- note = eggs

Always use the available MCP tools to perform the action when possible.
Do not claim you are read-only unless the tool actually fails.
After a successful insert, confirm exactly what was added.
Show amounts in ₹.
""",
    tools=[
        MCPToolset(
            connection_params=StdioConnectionParams(
                server_params=StdioServerParameters(
                    command="node",
                    args=[INDEX_JS],
                ),
                timeout=60,
            )
        )
    ],
)