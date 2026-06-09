-- PPT 智能生成服务 - D1 订单表
-- 运行: npx wrangler d1 execute ppt-orders --file=schema.sql

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  topic TEXT NOT NULL,
  pages INTEGER DEFAULT 15,
  deadline TEXT,
  notes TEXT,
  attachments TEXT DEFAULT '[]',
  file_paths TEXT DEFAULT '[]',
  status TEXT DEFAULT 'queued',
  progress TEXT DEFAULT '排队中...',
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  result_path TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
