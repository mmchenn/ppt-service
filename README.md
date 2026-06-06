# PPT 代制作服务 · 落地页

一个专业的 PPT 代制作服务需求收集页面。客户打开页面 → 填写需求 → 一键复制发给卖家 → 卖家使用 Kimi + AgentPPT 完成制作。

## 功能

- ✏️ **表单填写**：收集 PPT 主题、页数、交付时间等关键信息
- 📋 **一键复制**：生成结构化需求单，自动复制到剪贴板
- 📥 **下载文件**：支持下载为 `.txt` 文件
- 📱 **响应式设计**：手机和电脑均可正常使用
- 🎨 **商务简约风格**：专业、清晰、可信赖

## 部署方式

### 方式一：GitHub Pages（推荐，免费）

```bash
# 1. 在 GitHub 上创建一个新仓库（公开或私有均可）
# 2. 在本地初始化并推送
git init
git add .
git commit -m "初始化 PPT 代制作服务落地页"
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main

# 3. 在仓库 Settings → Pages 中，选择 main 分支
# 4. 等待 1-2 分钟，你的页面就会出现在
#    https://你的用户名.github.io/你的仓库名/
```

### 方式二：Vercel（秒级部署）

1. 去 [vercel.com](https://vercel.com) 用 GitHub 登录
2. 点击 **Add New → Project**
3. 导入本仓库
4. 框架选择 **Other**，直接 Deploy
5. 部署完成自动获得 `https://xxx.vercel.app` 链接

### 方式三：本地直接打开

直接双击 `index.html` 即可在浏览器中使用（复制功能在部分浏览器中可能需要通过 `http://` 协议访问）。

## 自定义

在 `index.html` 中搜索以下内容进行修改：

- **联系信息**：替换页面中的服务说明文案
- **颜色主题**：搜索 `#1a3a5c`、`#2563eb` 等颜色值
- **表单字段**：按需增删表单项

## 技术栈

- 纯 HTML + CSS + JavaScript，零依赖
- 无后端，无数据库
- 可直接托管在任何静态文件服务器
