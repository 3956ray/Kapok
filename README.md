# Kapok

Kapok 是一个面向团队的训练记录应用，支持记录训练、整理视频和复盘、查看成员信息与团队动态。应用使用 React、TypeScript 和 Vinext，后端运行于 Cloudflare Workers，数据结构和迁移使用 D1 与 Drizzle，媒体使用 R2 存储。

本仓库中的代码来自已验收的 v14 源码快照（原工程提交 `d0483882`）。正在开发的“复盘分享与撤回”功能不包含在此版本中。

## 本地开发

需要 Node.js 22.13.0 或更新版本及 npm：

```sh
npm run install:ci
npm run dev
```

开发服务器默认在本机的 5173 端口启动。项目包含本地开发用的模拟登录及 D1、R2 绑定；实际托管环境的身份认证和资源绑定需要按部署平台配置。安装方式、预览、数据库迁移和部署集成的详细说明见 [STARTER.md](STARTER.md)。

## 常用检查

```sh
npm run typecheck
npm run lint
npm run test:integration
npm run build
```

## 目录

- `app/`、`components/`：页面与界面组件。
- `lib/`：客户端逻辑、服务端业务逻辑和数据契约。
- `db/`、`drizzle/`：数据库结构与迁移。
- `build/`、`scripts/`：项目需要的构建和开发工具源码。
- `tests/`：测试与合成测试素材。
- `vendor/`：第三方资源及其许可证。

依赖目录、构建输出、本地状态和环境变量文件不纳入仓库。历史验收截图、报告与本机运行资料不在此快照中。托管配置仅保留所需的绑定名称，不包含原项目的部署标识。

## 许可证

本仓库采用 [MIT 许可证](LICENSE)；第三方资源的许可证随对应文件保留。
