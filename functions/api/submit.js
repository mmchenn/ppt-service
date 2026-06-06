// ——— PPT 智能生成 API Worker ———
// Cloudflare Pages Functions
// 部署后访问 /api/submit

// ===== 配置（部署时替换为真实值） =====
const CONFIG = {
  // Kimi API 配置
  KIMI_API_KEY: '',
  KIMI_API_URL: 'https://api.moonshot.cn/v1/chat/completions',
  KIMI_MODEL: 'moonshot-v1-auto',

  // 邮件发送配置（使用 Resend / SendGrid / SMTP）
  // 以下为 Resend 示例
  EMAIL_API_KEY: '',
  EMAIL_API_URL: 'https://api.resend.com/emails',
  EMAIL_FROM: 'PPT 智能生成 <noreply@yourdomain.com>',

  // R2 Bucket 名称（用于存储附件）
  R2_BUCKET: 'ppt-attachments',
};

// ===== 主入口 =====
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
    const name = formData.get('name') || '';
    const email = formData.get('email') || '';
    const topic = formData.get('topic') || '';
    const pages = formData.get('pages') || '10';
    const deadline = formData.get('deadline') || '';
    const style = formData.get('style') || '';
    const notes = formData.get('notes') || '';
    const attachments = formData.getAll('attachments');

    // 2. 验证
    if (!name || !email || !topic || !pages || !deadline) {
      return new Response(JSON.stringify({ error: '请填写所有必填项' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. 上传附件到 R2
    const uploadedFiles = [];
    if (attachments && attachments.length > 0) {
      for (const file of attachments) {
        const fileName = `${Date.now()}-${file.name}`;
        try {
          // 使用 Cloudflare R2 存储
          // 需要先在 dashboard 创建 R2 bucket
          await context.env.PPT_BUCKET.put(fileName, file.stream(), {
            httpMetadata: { contentType: file.type },
          });
          uploadedFiles.push({ name: file.name, path: fileName, size: file.size });
        } catch (e) {
          // R2 不存在则跳过存储
          uploadedFiles.push({ name: file.name, size: file.size });
        }
      }
    }

    // 4. 构造 Kimi AgentPPT 提示词
    const prompt = buildPrompt({
      name, email, topic, pages, deadline, style, notes, files: uploadedFiles,
    });

    // 5. 调用 Kimi API
    let kimiResult = null;
    if (CONFIG.KIMI_API_KEY || context.env.KIMI_API_KEY) {
      const apiKey = CONFIG.KIMI_API_KEY || context.env.KIMI_API_KEY;
      kimiResult = await callKimiAPI(apiKey, prompt);
    }

    // 6. 发送邮件通知
    let emailResult = null;
    if (CONFIG.EMAIL_API_KEY || context.env.EMAIL_API_KEY) {
      const apiKey = CONFIG.EMAIL_API_KEY || context.env.EMAIL_API_KEY;
      emailResult = await sendEmail(apiKey, {
        to: email,
        subject: `PPT 需求已收到：${topic}`,
        html: buildEmailHTML({ name, topic, pages, deadline, style, notes, files: uploadedFiles }),
      });
    }

    // 7. 返回成功
    return new Response(JSON.stringify({
      success: true,
      message: '需求已提交至 Kimi AgentPPT 智能生成！',
      files: uploadedFiles,
      kimi_submitted: !!kimiResult,
      email_notified: !!emailResult,
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

// ===== 构造提示词 =====
function buildPrompt(data) {
  let prompt = `请使用 AgentPPT 能力生成一份专业的 PowerPoint 演示文稿。

## 基本信息
- 客户称呼：${data.name}
- 接收邮箱：${data.email}
- PPT 主题：${data.topic}
- 页数要求：${data.pages} 页（不超过 35 页）
- 交付时间：${data.deadline}`;

  if (data.style) prompt += `\n- 风格偏好：${data.style}`;
  if (data.notes) prompt += `\n\n## 内容要求\n${data.notes}`;
  if (data.files && data.files.length > 0) {
    prompt += `\n\n## 附件资料\n`;
    data.files.forEach(function(f, i) {
      prompt += `  ${i + 1}. ${f.name}\n`;
    });
    prompt += `\n请参考附件资料中的内容生成 PPT。`;
  }

  prompt += `\n\n## 输出要求
1. 内容完整、逻辑清晰、排版美观
2. 控制在 ${data.pages} 页左右
3. 生成后通过可下载链接或直接发送给客户
4. 文件格式为 .pptx`;
  return prompt;
}

// ===== 调用 Kimi API =====
async function callKimiAPI(apiKey, prompt) {
  const resp = await fetch(CONFIG.KIMI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: CONFIG.KIMI_MODEL,
      messages: [
        { role: 'system', content: '你是一个专业的 PPT 生成助手，使用 AgentPPT 能力为用户生成高质量的 PowerPoint 演示文稿。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Kimi API 调用失败: ' + err);
  }

  return resp.json();
}

// ===== 发送邮件（使用 Resend） =====
async function sendEmail(apiKey, { to, subject, html }) {
  const resp = await fetch(CONFIG.EMAIL_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      from: CONFIG.EMAIL_FROM,
      to: to,
      subject: subject,
      html: html,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error('Email send failed:', err);
    return null;
  }

  return resp.json();
}

// ===== 邮件 HTML 模板 =====
function buildEmailHTML(data) {
  return `
    <div style="max-width:600px;margin:0 auto;font-family:-apple-system,sans-serif;">
      <div style="background:#2563eb;color:#fff;padding:24px;text-align:center;border-radius:12px 12px 0 0;">
        <h2 style="margin:0;">📋 PPT 需求已收到</h2>
      </div>
      <div style="background:#f8fafc;padding:24px;border:1px solid #e2e8f0;border-top:none;">
        <p>你好 <strong>${data.name}</strong>，</p>
        <p>你的 PPT 需求已成功提交至 Kimi + AgentPPT 智能生成系统！</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0;">
          <tr><td style="padding:8px 12px;font-weight:500;color:#475569;">主题</td><td style="padding:8px 12px;">${data.topic}</td></tr>
          <tr><td style="padding:8px 12px;font-weight:500;color:#475569;">页数</td><td style="padding:8px 12px;">${data.pages} 页</td></tr>
          <tr><td style="padding:8px 12px;font-weight:500;color:#475569;">交付日期</td><td style="padding:8px 12px;">${data.deadline}</td></tr>
          ${data.style ? '<tr><td style="padding:8px 12px;font-weight:500;color:#475569;">风格</td><td style="padding:8px 12px;">' + data.style + '</td></tr>' : ''}
          ${data.notes ? '<tr><td style="padding:8px 12px;font-weight:500;color:#475569;">备注</td><td style="padding:8px 12px;">' + data.notes + '</td></tr>' : ''}
          ${data.files && data.files.length ? '<tr><td style="padding:8px 12px;font-weight:500;color:#475569;">附件</td><td style="padding:8px 12px;">' + data.files.length + ' 个文件</td></tr>' : ''}
        </table>
        <p style="color:#64748b;font-size:14px;">⏳ 预计 1-2 小时内完成制作，届时 PPT 文件将通过邮件发送给你。</p>
        <p style="color:#64748b;font-size:14px;">如有任何问题，请直接回复本邮件。</p>
      </div>
      <div style="text-align:center;padding:16px;font-size:12px;color:#94a3b8;">
        <p>Powered by Kimi + AgentPPT · 智能 PPT 生成服务</p>
      </div>
    </div>
  `;
}
