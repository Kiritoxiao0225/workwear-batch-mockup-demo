# 工作服批量效果图 Demo

基于 Next.js 的无数据库 Demo。商品素材固定保存在项目中；本地开发的任务状态和上传 Logo 写入项目目录，部署到 Vercel 后改用当前浏览器的 IndexedDB。

## 本地运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000/products`。

## 存储位置

- 商品原图：`public/products/originals/`
- 商品缩略图：`public/products/thumbs/`
- 上传 Logo：`public/uploads/logos/`
- 任务状态：`data/demo-state.json`（首次运行自动创建，Git 忽略）

Demo 文件存储只适合本地体验，不适合作为多实例生产部署方案。

## Vercel Demo 存储边界

- Vercel 线上任务与 Logo 只保存在当前浏览器中，不会同步到其他电脑或其他浏览器。
- 清理浏览器网站数据会清空线上 Demo 任务。
- 正式多人协作版本仍需要数据库与对象存储；本 Demo 不包含这些生产依赖。
