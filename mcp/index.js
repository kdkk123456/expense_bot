import dotenv from "dotenv";
// Suppress dotenv's console output to prevent interference with MCP's JSON-RPC protocol
const originalLog = console.log;
const originalError = console.error;
console.log = () => {};
console.error = () => {};
dotenv.config({
  path: "../.env",
});
console.log = originalLog;
console.error = originalError;
import util from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { z } from "zod";
import pg from "pg";

const { Pool } = pg;

function sanitizeConnectionString(raw) {
  if (!raw) return raw;
  try {
    const url = new URL(raw);
    url.searchParams.delete("sslmode");
    url.searchParams.delete("sslcert");
    url.searchParams.delete("sslkey");
    url.searchParams.delete("sslrootcert");
    return url.toString();
  } catch {
    return raw;
  }
}

function isSupabaseConnection(raw) {
  return typeof raw === "string" && raw.includes("supabase.co");
}

function getSafeDbTarget(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.username ? `${url.username}@` : ""}${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "unparseable DATABASE_URL";
  }
}

function getErrorMessage(error) {
  if (error instanceof AggregateError) {
    const inner = Array.from(error.errors || []).map((e, i) => {
      if (e instanceof Error) {
        return `#${i + 1} ${e.name}: ${e.message || e.toString()}`;
      }
      try {
        return `#${i + 1} ${util.inspect(e, { depth: 5, breakLength: 120 })}`;
      } catch {
        return `#${i + 1} ${String(e)}`;
      }
    });
    return `AggregateError -> ${inner.join(" || ")}`;
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message || error.toString()}`;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  try {
    return util.inspect(error, { depth: 5, breakLength: 120 });
  } catch {
    return String(error);
  }
}

const rawConnectionString = process.env.DATABASE_URL;
const sanitizedConnectionString = sanitizeConnectionString(rawConnectionString);

if (!rawConnectionString) {
  console.error("DATABASE_URL is missing");
}

console.error("DB target:", getSafeDbTarget(rawConnectionString || ""));

const dns = require("dns");
// Force IPv4 DNS resolution — EC2 instances often lack IPv6 connectivity
dns.setDefaultResultOrder("ipv4first");

const poolConfig = {
  connectionString: sanitizedConnectionString,
};

if (isSupabaseConnection(rawConnectionString || "")) {
  poolConfig.ssl = { rejectUnauthorized: false };
  console.error("DB SSL mode: enabled via pool config for Supabase");
}

const pool = new Pool(poolConfig);

async function ensureSerialPrimaryKey(tableName, columnName) {
  const sequenceName = `${tableName}_${columnName}_seq`;

  try {
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS ${sequenceName}`);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_attrdef ad
          JOIN pg_class c ON ad.adrelid = c.oid
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ad.adnum
          WHERE c.relname = '${tableName}' AND a.attname = '${columnName}'
        ) THEN
          ALTER TABLE "${tableName}" ALTER COLUMN "${columnName}" SET DEFAULT nextval('${sequenceName}');
        END IF;
      END
      $$;
    `);
    await pool.query(`SELECT setval('${sequenceName}', COALESCE((SELECT MAX("${columnName}") FROM "${tableName}"), 0) + 1, false)`);
  } catch (error) {
    console.error(`Failed to ensure serial primary key for ${tableName}.${columnName}:`, getErrorMessage(error));
  }
}

async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        expense_id BIGSERIAL PRIMARY KEY,
        description TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        category TEXT NOT NULL,
        vendor_paid_to TEXT,
        date DATE NOT NULL,
        status TEXT DEFAULT 'Pending',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS income (
        income_id BIGSERIAL PRIMARY KEY,
        customer_name TEXT NOT NULL,
        category TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        description TEXT,
        date DATE NOT NULL,
        status TEXT DEFAULT 'Received',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await ensureSerialPrimaryKey("expenses", "expense_id");
    await ensureSerialPrimaryKey("income", "income_id");

    console.error("Database schema initialized or verified.");
  } catch (error) {
    console.error("Database initialization failed:", getErrorMessage(error));
  }
}

pool.on("error", (err) => {
  console.error("pg.Pool emitted error:", getErrorMessage(err));
});

initializeDatabase();

pool.query("SELECT NOW()")
  .then(() => {
    console.error("Postgres connected");
  })
  .catch((err) => {
    console.error("Postgres connection failed:", getErrorMessage(err));
  });

function formatCurrency(amount) {
  const value = Number(amount || 0);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function getPeriodDateRange(period = "this_month") {
  const now = new Date();
  const formatDate = (date) => date.toISOString().slice(0, 10);

  if (period === "all_time") {
    return {
      start_date: "2000-01-01",
      end_date: "2100-12-31",
    };
  }

  if (period === "this_month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return {
      start_date: formatDate(start),
      end_date: formatDate(end),
    };
  }

  if (period === "last_month") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return {
      start_date: formatDate(start),
      end_date: formatDate(end),
    };
  }

  if (period === "this_year") {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear(), 11, 31);
    return {
      start_date: formatDate(start),
      end_date: formatDate(end),
    };
  }

  if (period === "last_year") {
    const start = new Date(now.getFullYear() - 1, 0, 1);
    const end = new Date(now.getFullYear() - 1, 11, 31);
    return {
      start_date: formatDate(start),
      end_date: formatDate(end),
    };
  }

  return getPeriodDateRange("this_month");
}

function toPreTable(headers, rows) {
  const widths = headers.map((header, i) =>
    Math.max(
      String(header).length,
      ...rows.map((row) => String(row[i] ?? "").length)
    )
  );

  const line = (vals) =>
    vals
      .map((v, i) => String(v ?? "").padEnd(widths[i], " "))
      .join("  ");

  return `<pre>${[
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n")}</pre>`;
}

const server = new McpServer({
  name: "finance-mcp",
  version: "1.0.0",
});

server.tool(
  "add_expense",
  {
    description: z.string(),
    amount: z.number(),
    category: z.string(),
    vendor_paid_to: z.string().optional(),
    date: z.string().optional(),
    notes: z.string().optional(),
  },
  async ({ description, amount, category, vendor_paid_to, date, notes }) => {
    try {
      const expenseDate = date || new Date().toISOString().slice(0, 10);

      const result = await pool.query(
        `INSERT INTO expenses (description, amount, category, vendor_paid_to, date, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING expense_id, description, amount, category, vendor_paid_to, date, notes, created_at`,
        [description, amount, category, vendor_paid_to || null, expenseDate, notes || null]
      );

      const row = result.rows[0];
      return {
        content: [
          {
            type: "text",
            text:
              `Expense added successfully.\n\n` +
              `Description: ${row.description}\n` +
              `Category: ${row.category}\n` +
              `Amount: ${formatCurrency(row.amount)}\n` +
              `Vendor: ${row.vendor_paid_to || "-"}\n` +
              `Date: ${row.date}\n` +
              `Notes: ${row.notes || "-"}`,
          },
        ],
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      console.error("add_expense failed:", msg);
      return {
        content: [
          {
            type: "text",
            text: `Database error in add_expense: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "add_income",
  {
    customer_name: z.string(),
    category: z.string(),
    amount: z.number(),
    description: z.string().optional(),
    date: z.string().optional(),
    status: z.string().optional(),
    notes: z.string().optional(),
  },
  async ({ customer_name, category, amount, description, date, status, notes }) => {
    try {
      const incomeDate = date || new Date().toISOString().slice(0, 10);

      const result = await pool.query(
        `INSERT INTO income (customer_name, category, amount, description, date, status, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING income_id, customer_name, category, amount, description, date, status, notes, created_at`,
        [
          customer_name,
          category,
          amount,
          description || null,
          incomeDate,
          status || "Received",
          notes || null,
        ]
      );

      const row = result.rows[0];
      return {
        content: [
          {
            type: "text",
            text:
              `Income added successfully.\n\n` +
              `Customer: ${row.customer_name}\n` +
              `Category: ${row.category}\n` +
              `Amount: ${formatCurrency(row.amount)}\n` +
              `Description: ${row.description || "-"}\n` +
              `Date: ${row.date}\n` +
              `Status: ${row.status}\n` +
              `Notes: ${row.notes || "-"}`,
          },
        ],
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      console.error("add_income failed:", msg);
      return {
        content: [
          {
            type: "text",
            text: `Database error in add_income: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_expenses",
  {
    period: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ period = "this_month", limit = 20 }) => {
    try {
      const { start_date, end_date } = getPeriodDateRange(period);

      const result = await pool.query(
        `SELECT description, category, amount, vendor_paid_to, date, notes
         FROM expenses
         WHERE date >= $1 AND date <= $2
         ORDER BY date DESC, created_at DESC
         LIMIT $3`,
        [start_date, end_date, limit]
      );

      if (!result.rows.length) {
        return {
          content: [
            {
              type: "text",
              text: `No expenses found for ${period}.`,
            },
          ],
        };
      }

      const headers = ["Description", "Category", "Amount", "Vendor", "Date", "Notes"];
      const rows = result.rows.map((row) => [
        row.description,
        row.category,
        formatCurrency(row.amount),
        row.vendor_paid_to || "-",
        row.date,
        row.notes || "-",
      ]);

      return {
        content: [
          {
            type: "text",
            text: `Expenses for ${period}\n\n${toPreTable(headers, rows)}`,
          },
        ],
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      console.error("list_expenses failed:", msg);
      return {
        content: [
          {
            type: "text",
            text: `Database error in list_expenses: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "list_income",
  {
    period: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ period = "this_month", limit = 20 }) => {
    try {
      const { start_date, end_date } = getPeriodDateRange(period);

      const result = await pool.query(
        `SELECT customer_name, category, amount, description, date, status
         FROM income
         WHERE date >= $1 AND date <= $2
         ORDER BY date DESC, created_at DESC
         LIMIT $3`,
        [start_date, end_date, limit]
      );

      if (!result.rows.length) {
        return {
          content: [
            {
              type: "text",
              text: `No income found for ${period}.`,
            },
          ],
        };
      }

      const headers = ["Customer", "Category", "Amount", "Description", "Date", "Status"];
      const rows = result.rows.map((row) => [
        row.customer_name,
        row.category,
        formatCurrency(row.amount),
        row.description || "-",
        row.date,
        row.status || "-",
      ]);

      return {
        content: [
          {
            type: "text",
            text: `Income for ${period}\n\n${toPreTable(headers, rows)}`,
          },
        ],
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      console.error("list_income failed:", msg);
      return {
        content: [
          {
            type: "text",
            text: `Database error in list_income: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "get_financial_summary",
  {
    period: z.string().optional(),
  },
  async ({ period = "this_month" }) => {
    try {
      const { start_date, end_date } = getPeriodDateRange(period);

      const expenseResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_expenses
         FROM expenses
         WHERE date >= $1 AND date <= $2`,
        [start_date, end_date]
      );

      const incomeResult = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_income
         FROM income
         WHERE date >= $1 AND date <= $2`,
        [start_date, end_date]
      );

      const totalExpenses = Number(expenseResult.rows[0].total_expenses || 0);
      const totalIncome = Number(incomeResult.rows[0].total_income || 0);
      const net = totalIncome - totalExpenses;

      return {
        content: [
          {
            type: "text",
            text:
              `Financial summary for ${period}\n\n` +
              `Income: ${formatCurrency(totalIncome)}\n` +
              `Expenses: ${formatCurrency(totalExpenses)}\n` +
              `Net: ${formatCurrency(net)}`,
          },
        ],
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      console.error("get_financial_summary failed:", msg);
      return {
        content: [
          {
            type: "text",
            text: `Database error in get_financial_summary: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "export_expenses",
  {
    period: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ period = "this_month", limit = 500 }) => {
    try {
      const { start_date, end_date } = getPeriodDateRange(period);

      const result = await pool.query(
        `SELECT expense_id, description, category, amount, vendor_paid_to, date, status, notes, created_at
         FROM expenses
         WHERE date >= $1 AND date <= $2
         ORDER BY date DESC, created_at DESC
         LIMIT $3`,
        [start_date, end_date, limit]
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              export_type: "expenses",
              period,
              start_date,
              end_date,
              row_count: result.rows.length,
              rows: result.rows,
            }),
          },
        ],
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      console.error("export_expenses failed:", msg);
      return {
        content: [
          {
            type: "text",
            text: `Database error in export_expenses: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "export_income",
  {
    period: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ period = "this_month", limit = 500 }) => {
    try {
      const { start_date, end_date } = getPeriodDateRange(period);

      const result = await pool.query(
        `SELECT income_id, customer_name, category, amount, description, date, status, notes, created_at
         FROM income
         WHERE date >= $1 AND date <= $2
         ORDER BY date DESC, created_at DESC
         LIMIT $3`,
        [start_date, end_date, limit]
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              export_type: "income",
              period,
              start_date,
              end_date,
              row_count: result.rows.length,
              rows: result.rows,
            }),
          },
        ],
      };
    } catch (error) {
      const msg = getErrorMessage(error);
      console.error("export_income failed:", msg);
      return {
        content: [
          {
            type: "text",
            text: `Database error in export_income: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const app = createMcpExpressApp();
const transports = {};

app.get("/sse", async (req, res) => {
  console.error("Received GET request to /sse");
  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  transports[sessionId] = transport;

  transport.onclose = () => {
    console.error(`SSE transport closed for session ${sessionId}`);
    delete transports[sessionId];
  };

  await server.connect(transport);
  console.error(`Established SSE stream for session ${sessionId}`);
});

app.post("/messages", async (req, res) => {
  console.error("Received POST request to /messages");
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    res.status(400).send("Missing sessionId parameter");
    return;
  }
  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).send("Session not found");
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

const PORT = process.env.PORT || 6666;
const serverInstance = app.listen(PORT, '127.0.0.1', () => {
  console.error(`MCP SSE Server listening on 127.0.0.1:${PORT}`);
});
console.error("DB target:", getSafeDbTarget(rawConnectionString || ""));

// Keep-alive interval to prevent Node from exiting in certain non-interactive environments
const keepAliveInterval = setInterval(() => {}, 60000);

process.on("exit", (code) => {
  clearInterval(keepAliveInterval);
  console.error(`Process exiting with code: ${code}`);
});
process.on("uncaughtException", (err) => {
  console.error(`Uncaught Exception: ${err.message}`, err.stack);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});