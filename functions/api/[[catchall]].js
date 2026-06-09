// PPT 订单管理 Worker — D1 版
// Client -> pages.dev/api/* -> D1 数据库
// 本地服务轮询 D1 拉取订单处理

// ===== CORS 辅助 =====
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
};

function handleOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ===== 订单 ID 生成 =====
function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ===== 路由分发 =====
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const { pathname, searchParams } = url;
  const method = request.method;

  if (method === 'OPTIONS') return handleOptions();

  try {
    // POST /api/submit — 客户提交订单
    if (pathname === '/api/submit' && method === 'POST') {
      return handleSubmit(request, env);
    }

    // GET /api/orders — 查询订单（按 email 或 id）
    if (pathname === '/api/orders' && method === 'GET') {
      return handleListOrders(searchParams, env);
    }

    // GET /api/poll — 本地服务轮询待处理订单
    if (pathname === '/api/poll' && method === 'GET') {
      return handlePoll(request, env);
    }

    // PATCH /api/orders/:id — 更新订单状态（本地服务）
    if (pathname.startsWith('/api/orders/') && method === 'PATCH') {
      const orderId = pathname.split('/')[3];
      if (!orderId) return json({ error: 'Missing order ID' }, 400);
      return handleUpdateOrder(orderId, request, env);
    }

    return json({ error: 'Not Found' }, 404);
  } catch (err) {
    console.error('Worker error:', err);
    return json({ error: err.message || 'Internal error' }, 500);
  }
}

// ===== POST /api/submit =====
async function handleSubmit(request, env) {
  const ct = request.headers.get('Content-Type') || '';

  let data;
  if (ct.includes('multipart/form-data')) {
    // 有附件：只存基本信息，附件信息存为 JSON 字符串
    const formData = await request.formData();
    const attachments = [];
    const filesRaw = formData.getAll('attachments') || [];
    for (const file of filesRaw) {
      if (file instanceof File) {
        attachments.push({ name: file.name, size: file.size, type: file.type });
      }
    }
    data = {
      customerName: formData.get('name') || '',
      email: formData.get('email') || '',
      topic: formData.get('topic') || '',
      pages: parseInt(formData.get('pages')) || 15,
      deadline: formData.get('deadline') || '',
      notes: formData.get('notes') || '',
      attachments,
      filePaths: [],
    };
    // 如果有附件，回退到让客户发文件到本地/邮箱
    // 云端无法直接传递文件到本地 CDP
  } else {
    data = await request.json();
  }

  const id = generateId();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  await env.ppt_orders.prepare(
    `INSERT INTO orders (id, customer_name, email, topic, pages, deadline, notes, attachments, file_paths, status, progress, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '排队中...', ?)`
  ).bind(
    id,
    data.customerName || data.name || '',
    data.email || '',
    data.topic || '',
    data.pages || 15,
    data.deadline || '',
    data.notes || '',
    JSON.stringify(data.attachments || []),
    JSON.stringify(data.filePaths || []),
    now
  ).run();

  return json({
    success: true,
    message: '订单已提交！正在排队处理...',
    order_id: id,
    order: {
      id,
      customerName: data.customerName || data.name || '',
      email: data.email || '',
      topic: data.topic || '',
      status: 'queued',
      progress: '排队中...',
      createdAt: now,
    },
  });
}

// ===== GET /api/orders =====
async function handleListOrders(searchParams, env) {
  const email = searchParams.get('email');
  const id = searchParams.get('id');
  const limit = Math.min(parseInt(searchParams.get('limit')) || 20, 100);

  let rows;
  if (id) {
    rows = await env.ppt_orders.prepare(
      'SELECT * FROM orders WHERE id = ? ORDER BY created_at DESC'
    ).bind(id).all();
  } else if (email) {
    rows = await env.ppt_orders.prepare(
      'SELECT * FROM orders WHERE email = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(email, limit).all();
  } else {
    rows = await env.ppt_orders.prepare(
      'SELECT * FROM orders ORDER BY created_at DESC LIMIT ?'
    ).bind(limit).all();
  }

  return json({ success: true, orders: rows.results || [] });
}

// ===== GET /api/poll — 本地服务轮询 =====
async function handlePoll(request, env) {
  // 验证 token
  const authToken = request.headers.get('X-Auth-Token');
  const expectedToken = env.POLL_TOKEN;
  if (!expectedToken || authToken !== expectedToken) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const rows = await env.ppt_orders.prepare(
    "SELECT * FROM orders WHERE status IN ('queued', 'running') ORDER BY created_at ASC LIMIT 10"
  ).all();

  return json({ success: true, orders: rows.results || [] });
}

// ===== PATCH /api/orders/:id — 更新订单 =====
async function handleUpdateOrder(orderId, request, env) {
  // 验证 token
  const authToken = request.headers.get('X-Auth-Token');
  const expectedToken = env.POLL_TOKEN;
  if (!expectedToken || authToken !== expectedToken) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const updates = await request.json();
  const allowedFields = ['status', 'progress', 'error', 'result_path', 'completed_at'];

  // 构建动态 UPDATE
  const setClauses = [];
  const values = [];
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    if (allowedFields.includes(dbKey)) {
      setClauses.push(`${dbKey} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) {
    return json({ error: 'No valid fields to update' }, 400);
  }

  values.push(orderId);
  await env.ppt_orders.prepare(
    `UPDATE orders SET ${setClauses.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  return json({ success: true, message: '订单已更新' });
}
