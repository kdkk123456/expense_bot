# finance_mcp_server.py
from mcp.server.fastmcp import FastMCP
import sqlite3, datetime

mcp = FastMCP("Finance Tracker")
DB = "finance.db"

def init_db():
    con = sqlite3.connect(DB)
    con.execute("""CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY, type TEXT, category TEXT,
        amount REAL, note TEXT, date TEXT
    )""")
    con.commit(); con.close()

@mcp.tool()
def add_transaction(type: str, category: str, amount: float, note: str = "") -> str:
    """Add an income or expense. type = 'income' or 'expense'."""
    con = sqlite3.connect(DB)
    con.execute("INSERT INTO transactions VALUES (NULL,?,?,?,?,?)",
                (type, category, amount, note, datetime.date.today().isoformat()))
    con.commit(); con.close()
    return f"✅ {type.capitalize()} of ₹{amount} added under '{category}'"

@mcp.tool()
def get_summary(month: str | None = None) -> dict:
    """Get income vs expense summary. month format: 'YYYY-MM'"""
    con = sqlite3.connect(DB)
    query = "SELECT type, SUM(amount) FROM transactions"
    params = []
    if month:
        query += " WHERE date LIKE ?"
        params.append(f"{month}%")
    query += " GROUP BY type"
    rows = con.execute(query, params).fetchall()
    con.close()
    return {row[0]: row[1] for row in rows}

@mcp.tool()
def list_transactions(limit: int = 10) -> list:
    """List recent transactions."""
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT type, category, amount, note, date FROM transactions ORDER BY id DESC LIMIT ?",
        (limit,)
    ).fetchall()
    con.close()
    return [{"type": r[0], "category": r[1], "amount": r[2], "note": r[3], "date": r[4]} for r in rows]

init_db()
mcp.run(transport="stdio")  # or "sse" for HTTP