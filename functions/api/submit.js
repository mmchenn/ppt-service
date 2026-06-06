// ——— PPT 需求提交 Worker ———
// Cloudflare Pages Functions
// 收集客户需求 → 生成 Kimi AgentPPT 提示词 → 邮件通知管理员

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
    // 1. 解析表单
    const formData = await request.formData();
    const name = (formData.get('name') || '').trim();
    const email = (formData.get('email') || '').trim();
    const topic = (formData.get('topic') || '').trim();
    const pages = (formData.get('pages') || '').trim();
    const deadline = (formData.get('deadline') || '').trim();
    const style = (formData.get('style') || '').trim();
    const notes = (formData.get('notes') || '').trim();
    const attachments = formData.getAll('attachments').filter(f => f instanceof File && f.size > 0);

    // 2. 验证
    if (!name || !email || !topic || !pages || !deadline) {
      return new Response(JSON.stringify({ error: '请填写所有必填项' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. 上传附件到 R2（可选）
    const uploadedFiles = [];
    if (attachments.length > 0) {
      for (const file of attachments) {
        const fileName = `${Date.now()}-${file.name}`;
        try {
          if (context.env && context.env.PPT_BUCKET) {
            await context.env.PPT_BUCKET.put(fileName, file.stream(), {
              httpMetadata: { contentType: file.type },
            });
          }
          uploadedFiles.push({ name: file.name, size: file.size });
        } catch (e) {
          uploadedFiles.push({ name: file.name, size: file.size });
        }
      }
    }

    // 4. 生成 Kimi AgentPPT 提示词
    const agentPrompt = buildPrompt({
      name, email, topic, pages, deadline, style, notes, files: uploadedFiles,
    });

    // 5. 邮件通知管理员
    let emailSent = false;
    const adminEmail = context.env && context.env.ADMIN_EMAIL;
    const emailApiKey = context.env && context.env.EMAIL_API_KEY;
    if (adminEmail && emailApiKey) {
      emailSent = await sendMail(emailApiKey, adminEmail, topic, name, email, agentPrompt);
    }

    // 6. 返回成功（提示词给前端展示）
    return new Response(JSON.stringify({
      success: true,
      message: '需求已提交！请将提示词复制到 Kimi AgentPPT 中生成。',
      agent_prompt: agentPrompt,
      files: uploadedFiles,
      email_notified: emailSent,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (err) {
    console.error('Submit error:', err);
    return new Response(JSON.stringify({ error: err.message || '服务器内部错误' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

// ===== 构造 Kimi AgentPPT 提示词 =====
function buildPrompt(data) {
  let text = `请使用 AgentPPT 能力生成一份专业的 PowerPoint 演示文稿。

## 基本信息
- 客户称呼：${data.name}
- 接收邮箱：${data.email}
- PPT 主题：${data.topic}
- 页数要求：${data.pages} 页（不超过 35 页）
- 交付时间：${data.deadline}`;

  if (data.style) text += `\n- 风格偏好：${data.style}`;
  if (data.notes) text += `\n\n## 内容要求\n${data.notes}`;
  if (data.files && data.files.length > 0) {
    text += `\n\n## 附件资料\n`;
    data.files.forEach((f, i) => { text += `  ${i+1}. ${f.name} (${formatSize(f.size)})\n`; });
    text += `请参考附件资料中的内容生成 PPT。`;
  }

  text += `\n\n## 输出要求
1. 内容完整、逻辑清晰、排版美观
2. 控制在 ${data.pages} 页左右
3. 生成后提供下载链接或直接发送给客户`;
  return text;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + 'KB';
  return (bytes/(1024*1024)).toFixed(1) + 'MB';
}

// ===== 邮件通知（Resend） =====
async function sendMail(apiKey, to, topic, name, email, prompt) {
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: 'PPT 智能生成 <noreply@ppt-service.pages.dev>',
      to: [to],
      subject: `新需求：${topic} - ${name}`,
      html: `<div style="max-width:600px;margin:auto;font-family:sans-serif;">
        <h2 style="color:#2563eb;">📋 新 PPT 需求</h2>
        <p><b>客户：</b>${name}（${email}）</p>
        <p><b>主题：</b>${topic}</p>
        <hr>
        <h3>🤖 复制到 Kimi AgentPPT：</h3>
        <pre style="background:#f1f5f9;padding:16px;border-radius:8px;white-space:pre-wrap;">${prompt.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
        <p style="color:#94a3b8;font-size:12px;">Powered by Kimi + AgentPPT</p>
      </div>`,
    }),
  });
  return resp.ok;
}
