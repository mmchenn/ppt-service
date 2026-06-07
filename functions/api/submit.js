// ——— PPT 需求提交 Worker (简化版) ———
// 由于客户未开通 R2，Worker 仅作为页面托管和静态展示
// 表单数据直接由浏览器发到本地 localhost:3456/api/submit
//
// 此文件用于：
//   - Cloudflare Pages 部署（必须存在一个 Worker）
//   - 可选：接收表单后邮件通知管理员
//   - 返回一个提示，引导用户确保本机服务运行

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
    // 解析表单
    const formData = await request.formData();
    const name = (formData.get('name') || '').trim();
    const email = (formData.get('email') || '').trim();
    const topic = (formData.get('topic') || '').trim();
    const pages = (formData.get('pages') || '').trim();
    const deadline = (formData.get('deadline') || '').trim();
    const style = (formData.get('style') || '').trim();
    const notes = (formData.get('notes') || '').trim();
    const attachments = formData.getAll('attachments').filter(f => f instanceof File && f.size > 0);

    // 验证
    if (!name || !email || !topic || !pages || !deadline) {
      return new Response(JSON.stringify({ error: '请填写所有必填项' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 生成提示词
    const agentPrompt = buildPrompt({
      name, email, topic, pages, deadline, style, notes,
      files: attachments.map(f => ({ name: f.name, size: f.size })),
    });

    // 可选邮件通知管理员
    let emailSent = false;
    const adminEmail = context.env && context.env.ADMIN_EMAIL;
    const emailApiKey = context.env && context.env.EMAIL_API_KEY;
    if (adminEmail && emailApiKey) {
      emailSent = await sendMail(emailApiKey, adminEmail, topic, name, email, agentPrompt);
    }

    // 返回（提示词给前端展示）
    return new Response(JSON.stringify({
      success: true,
      message: '需求已提交！请确保本地服务 (node server.mjs) 运行中，'
             + '或者手动将提示词复制到 Kimi AgentPPT。',
      agent_prompt: agentPrompt,
      files: attachments.map(f => ({ name: f.name, size: f.size })),
      email_notified: emailSent,
      note: '附件未存储到云端，请确保本地服务运行中接收文件',
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (err) {
    console.error('Submit error:', err);
    return new Response(JSON.stringify({ error: err.message || '服务器错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

function buildPrompt(data) {
  let text = `请使用 AgentPPT 能力生成一份专业的 PowerPoint 演示文稿。

## 基本信息
- 客户称呼：${data.name}
- 接收邮箱：${data.email}
- PPT 主题：${data.topic}
- 页数要求：${data.pages} 页
- 交付时间：${data.deadline}`;
  if (data.style) text += `\n- 风格偏好：${data.style}`;
  if (data.notes) text += `\n\n## 内容要求\n${data.notes}`;
  if (data.files && data.files.length > 0) {
    text += `\n\n## 附件资料\n`;
    data.files.forEach((f, i) => {
      text += `  ${i+1}. ${f.name}\n`;
    });
    text += `请在附件中参考这些资料。`;
  }
  text += `\n\n## 输出要求\n1. 内容完整、逻辑清晰、排版美观\n2. 控制在 ${data.pages} 页以内\n3. 生成后提供下载链接`;
  return text;
}

async function sendMail(apiKey, to, topic, name, email, prompt) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: 'PPT 智能生成 <noreply@ppt-service.pages.dev>',
      to: [to],
      subject: `新需求：${topic} - ${name}`,
      html: `<div style="max-width:600px;font-family:sans-serif;">
        <h2>新 PPT 需求</h2>
        <p><b>客户：</b>${name}（${email}）</p><p><b>主题：</b>${topic}</p>
        <hr><h3>Kimi 提示词：</h3>
        <pre style="background:#f1f5f9;padding:16px;border-radius:8px;white-space:pre-wrap;">${prompt.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
        <p style="color:#94a3b8;font-size:12px;">Powered by Kimi + AgentPPT</p>
      </div>`,
    }),
  });
  return resp.ok;
}
