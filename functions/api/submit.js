// ——�?PPT 需求提�?Worker (转发模式) ——�?// 客户通过 Cloudflare Pages 提交 �?Worker 转发到本�?tunnel �?server.mjs
//
// 架构�?//   client �?https://ppt-service.pages.dev/api/submit (Worker)
//            �?cloudflared tunnel �?localhost:3456 �?server.mjs �?CDP �?Kimi
//
// 依赖：本地需要运行：
//   1. node server.mjs
//   2. cloudflared tunnel --url http://localhost:3456

// Quick Tunnel URL（每次重�?cloudflared 后需要更新）
const TUNNEL_URL = 'https://yoga-referred-novels-prev.trycloudflare.com';

export async function onRequest(context) {
  const { request } = context;

  // CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // 直接转发到本地服务（通过 cloudflared tunnel�?    const tunnelUrl = `${TUNNEL_URL}/api/submit`;

    const tunnelResp = await fetch(tunnelUrl, {
      method: 'POST',
      body: request.body,  // 直接透传 body（multipart/form-data 含文件）
      headers: {
        'Content-Type': request.headers.get('Content-Type') || '',
      },
    });

    const result = await tunnelResp.json();

    if (!tunnelResp.ok) {
      return new Response(JSON.stringify(result), {
        status: tunnelResp.status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (err) {
    console.error('Submit error:', err);
    return new Response(JSON.stringify({
      success: false,
      error: '无法连接到本地服务。请确保本地已启�?node server.mjs �?cloudflared tunnel 隧道�?,
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
