// PPT submit Worker (forwarding mode)
// Client -> pages.dev/api/submit -> cloudflared tunnel -> server.mjs
//
// Setup:
//   1. node server.mjs
//   2. cloudflared tunnel --url http://localhost:3456

const TUNNEL_URL = 'https://troy-criterion-premises-bristol.trycloudflare.com';

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
    const tunnelUrl = `${TUNNEL_URL}/api/submit`;

    const tunnelResp = await fetch(tunnelUrl, {
      method: 'POST',
      body: request.body,
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
      error: 'Cannot connect to local server. Please ensure node server.mjs and cloudflared tunnel are running.',
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
