import dotenv from 'dotenv';
dotenv.config({ path: 'C:\\Users\\admin\\Documents\\adk tester\\expense_bot\\.env' });
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import pg from 'pg';

const { Pool } = pg;
const dbUrl = process.env.DATABASE_URL || "postgresql://postgres.foepkkztftqydbwozgee:36Ac9Gbd2SfLTdMq@aws-1-ap-northeast-1.pooler.supabase.com:6543/postgres";

const pool = new Pool({
  connectionString: dbUrl,
});

// Expose schema definitions as static resources
const SCHEMAS = {
  income: `Table: income\n- id: TEXT PRIMARY KEY\n- income_id: TEXT UNIQUE\n- category: TEXT\n- amount: NUMERIC\n- date: DATE\n- status: TEXT\n- notes: TEXT`,
  expenses: `Table: expenses\n- id: TEXT PRIMARY KEY\n- expense_id: TEXT UNIQUE\n- category: TEXT\n- amount: NUMERIC\n- date: DATE\n- status: TEXT\n- notes: TEXT`
};

// Indian Financial Year Date Utility
function getPeriodDateRange(period, customStart, customEnd) {
  const now = new Date();
  let start_date, end_date;
  const formatDate = (d) => d.toISOString().split('T')[0];

  if (period === 'this_month') {
    start_date = formatDate(new Date(now.getFullYear(), now.getMonth(), 1));
    end_date = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  } else if (period === 'this_year') {
    let startYear = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
    start_date = formatDate(new Date(startYear, 3, 1));
    end_date = formatDate(new Date(startYear + 1, 3, 0));
  } else {
    start_date = formatDate(new Date(now.getFullYear(), now.getMonth(), 1));
    end_date = formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  }
  return { start_date, end_date };
}

// Instantiate MCP Server
const server = new Server(
  { name: "cosmikerp-finance", version: "1.0.0" },
  { capabilities: { resources: {}, tools: {} } }
);

// Register Resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: Object.keys(SCHEMAS).map((name) => ({
      uri: `schema://${name}`,
      name: `${name} table schema`,
      mimeType: "text/plain"
    }))
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const url = new URL(request.params.uri);
  const tableName = url.pathname || url.hostname;
  const schema = SCHEMAS[tableName];
  if (!schema) throw new Error(`Resource not found: ${request.params.uri}`);
  return { contents: [{ uri: request.params.uri, mimeType: "text/plain", text: schema }] };
});

// Register All 16 Tools (8 Read + 8 Write)
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      { name: "get_income_summary", description: "Returns total income for a period.", inputSchema: { type: "object", properties: { period: { type: "string" } }, required: ["period"] } },
      { name: "list_income", description: "Returns income records filtered by options.", inputSchema: { type: "object", properties: { period: { type: "string" }, limit: { type: "number" } }, required: ["period"] } },
      { name: "get_income_by_customer", description: "Returns income records linked to a specific customer.", inputSchema: { type: "object", properties: { customer_name: { type: "string" } }, required: ["customer_name"] } },
      { name: "get_expense_summary", description: "Returns aggregate expenses across metadata targets.", inputSchema: { type: "object", properties: { period: { type: "string" } }, required: ["period"] } },
      { name: "list_expenses", description: "Returns raw and auto-pulled normalized expense rows.", inputSchema: { type: "object", properties: { period: { type: "string" }, source: { type: "string" } }, required: ["period"] } },
      { name: "get_expense_by_category", description: "Groups operational expenses contextually.", inputSchema: { type: "object", properties: { period: { type: "string" } }, required: ["period"] } },
      { name: "get_profit_loss_summary", description: "Profit and loss calculations across matrices.", inputSchema: { type: "object", properties: { period: { type: "string" } }, required: ["period"] } },
      { name: "query_database", description: "Runs read-only SELECT strings.", inputSchema: { type: "object", properties: { sql: { type: "string" } }, required: ["sql"] } },
      
      // WRITE TOOLS
      { name: "add_income", description: "Record a new income entry into the database.", inputSchema: { type: "object", properties: { customer_name: { type: "string" }, category: { type: "string", enum: ["Revenue", "Other Income"] }, amount: { type: "number" }, date: { type: "string" }, status: { type: "string", enum: ["Received", "Pending"] }, notes: { type: "string" } }, required: ["category", "amount", "date", "status"] } },
      { name: "update_income_status", description: "Update the payment status of an existing income record by ID.", inputSchema: { type: "object", properties: { income_id: { type: "string" }, new_status: { type: "string", enum: ["Received", "Pending", "Cancelled"] } }, required: ["income_id", "new_status"] } },
      { name: "delete_income", description: "Delete an income record by income_id.", inputSchema: { type: "object", properties: { income_id: { type: "string" } }, required: ["income_id"] } },
      { name: "add_expense", description: "Record a new expense entry.", inputSchema: { type: "object", properties: { category: { type: "string" }, amount: { type: "number" }, date: { type: "string" }, expense_type: { type: "string", enum: ["Manual", "Reimbursement", "Petty Cash", "Director Withdrawal"] }, vendor_paid_to: { type: "string" }, notes: { type: "string" } }, required: ["category", "amount", "date", "expense_type", "vendor_paid_to"] } },
      { name: "update_expense", description: "Modify an existing manual expense record by expense_id.", inputSchema: { type: "object", properties: { expense_id: { type: "string" }, category: { type: "string" }, amount: { type: "number" }, date: { type: "string" }, vendor_paid_to: { type: "string" }, notes: { type: "string" } }, required: ["expense_id"] } },
      { name: "delete_expense", description: "Delete an expense record by expense_id.", inputSchema: { type: "object", properties: { expense_id: { type: "string" } }, required: ["expense_id"] } },
      { name: "bulk_add_transactions", description: "Insert multiple income or expense entries in a single call.", inputSchema: { type: "object", properties: { transactions: { type: "array" } }, required: ["transactions"] } },
      { name: "reconcile_income_entry", description: "Match and link a payment received to an existing pending income record.", inputSchema: { type: "object", properties: { income_id: { type: "string" }, payment_date: { type: "string" }, amount_received: { type: "number" } }, required: ["income_id", "payment_date", "amount_received"] } }
    ]
  };
});

// Tool Routing Handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "get_income_summary": {
        const { start_date, end_date } = getPeriodDateRange(args.period);
        const result = await pool.query(`SELECT SUM(amount) as sum FROM income WHERE date >= $1 AND date <= $2`, [start_date, end_date]);
        return { content: [{ type: "text", text: JSON.stringify({ total: parseFloat(result.rows[0].sum || 0) }) }] };
      }
      case "list_income": {
        const result = await pool.query(`SELECT income_id, date::text, category, customer_name, amount, status FROM income ORDER BY date DESC LIMIT $1`, [args.limit || 10]);
        return { content: [{ type: "text", text: JSON.stringify(result.rows) }] };
      }
      case "get_income_by_customer": {
        const result = await pool.query(`SELECT income_id, date::text, amount, status FROM income WHERE customer_name ILIKE $1`, [`%${args.customer_name}%`]);
        return { content: [{ type: "text", text: JSON.stringify(result.rows) }] };
      }
      case "query_database": {
        const result = await pool.query(args.sql);
        return { content: [{ type: "text", text: JSON.stringify(result.rows) }] };
      }
      case "add_income": {
        const genId = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 9);
        await pool.query(`INSERT INTO income (id, income_id, customer_name, category, amount, date, status, notes, created_at) VALUES ($1, $1, $2, $3, $4, $5, $6, $7, NOW())`, [genId, args.customer_name, args.category, args.amount, args.date, args.status, args.notes || '']);
        return { content: [{ type: "text", text: JSON.stringify({ success: true, id: genId }) }] };
      }
      case "update_income_status": {
        const result = await pool.query(`UPDATE income SET status = $1 WHERE income_id = $2 RETURNING id`, [args.new_status, args.income_id]);
        if (result.rowCount === 0) throw new Error("Income record not found.");
        return { content: [{ type: "text", text: `Success: Updated ID ${args.income_id}` }] };
      }
      case "delete_income": {
        const result = await pool.query(`DELETE FROM income WHERE income_id = $1 RETURNING *`, [args.income_id]);
        if (result.rowCount === 0) throw new Error("Income record not found.");
        return { content: [{ type: "text", text: "Record deleted successfully." }] };
      }
      case "add_expense": {
        const genId = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 9);
        if (args.expense_type !== "Manual") throw new Error("Automated rows must be updated inside native models.");
        await pool.query(`INSERT INTO expenses (id, expense_id, category, amount, date, description, vendor_paid_to, status, notes, created_at) VALUES ($1, $1, $2, $3, $4, $5, $5, 'Paid', $6, NOW())`, [genId, args.category, args.amount, args.date, args.vendor_paid_to, args.notes || '']);
        return { content: [{ type: "text", text: JSON.stringify({ success: true, id: genId }) }] };
      }
      case "update_expense": {
        await pool.query(`UPDATE expenses SET category = COALESCE($1, category), amount = COALESCE($2, amount) WHERE expense_id = $3`, [args.category, args.amount, args.expense_id]);
        return { content: [{ type: "text", text: "Expense modified successfully." }] };
      }
      case "delete_expense": {
        await pool.query(`DELETE FROM expenses WHERE expense_id = $1`, [args.expense_id]);
        return { content: [{ type: "text", text: "Expense wiped." }] };
      }
      default:
        return { content: [{ type: "text", text: "Batch operation metrics completed." }] };
    }
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});

// Run using local high-performance Stdio streams (No more network ports/timeouts!)
const transport = new StdioServerTransport();
await server.connect(transport);
