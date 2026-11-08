# Kapok

Kapok Bloom 是队伍训练、比赛回看与成长记录工具。访问 [kapok.party](https://kapok.party)。

- 用邮箱注册。先填盘名与背号，验证邮箱，确认后加入 Kapok 队伍。
- 在训练记录观看 B 站视频，定位时间点、讨论和直接回复。
- 收藏片段、保存私人备注、写复盘，按需要分享给全队或撤回。
- 管理员可同页发布训练和可选视频，之后编辑、补视频及预览队员页面。

后续开发请先读 [完整交接](HANDOFF.md) 和 [部署与恢复手册](docs/DEPLOYMENT.md)。[AGENTS.md](AGENTS.md) 是仓库内协作说明。

## 本地验证

使用 Node.js 24 和 npm。在干净的 checkout 运行：

```sh
npm run install:ci
npm run typecheck -- --incremental false
npm run lint
node --test --test-concurrency=1 tests/integration/*.test.mjs
npm run build:staging
npm run test:staging
npm run dry-run:staging
```

`build:staging` 是历史命名，当前是 Cloudflare Worker 构建。普通克隆默认使用合成 D1、合成身份配置和测试视频编号，无远程路由。线上构建需要负责人提供正式配置和获准的队伍视频清单。生产数据、备份、账号会话和凭据均在受限环境管理。

如需手动操作页面，按[本地浏览器验证步骤](HANDOFF.md#本地浏览器验证)启动合成环境。旧 Sites starter 手册见 [STARTER.md](STARTER.md)。
