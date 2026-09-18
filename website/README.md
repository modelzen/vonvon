# Vonvon Website

这个目录是 Vonvon 的静态产品官网，可以直接作为 Cloudflare Pages 的项目根目录来部署。

## 目录说明

- `index.html`: 官网主页面
- `styles.css`: 页面样式
- `script.js`: 轻量交互动效
- `assets/`: 本地图片素材
- `_headers`: Cloudflare Pages 自定义响应头

## 本地预览

可以直接在这个目录起一个静态文件服务，例如：

```bash
cd website
python3 -m http.server 4173
```

然后访问 `http://localhost:4173`。

## Cloudflare Pages

推荐把 Pages 项目的 Root directory 设为 `website`，这样官网目录会作为独立静态站点发布。

建议配置：

- Framework preset: `None`
- Root directory: `website`
- Build command: `exit 0`
- Build output directory: `.`

Cloudflare 的构建配置页提到无框架项目可以留空 Build command，但它们的 Static HTML 部署指南明确推荐使用 `exit 0`。这里按更稳妥的官方推荐写成 `exit 0`。

如果后续想接自定义域名，直接在 Cloudflare Pages 控制台里追加域名即可。
