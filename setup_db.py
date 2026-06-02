# setup_db.py
import sqlite3

con = sqlite3.connect("finance.db")
con.execute("""
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY,
        type TEXT,
        category TEXT,
        amount REAL,
        note TEXT,
        date TEXT
    )
""")
con.commit()
con.close()
print("✅ Database ready!")