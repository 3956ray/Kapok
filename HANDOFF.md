# Kapok 完整交接

> 2026-11-16：最新学习库交互更新已部署，见 [发布记录](docs/RELEASE-2026-11-16.md)。

> 2026-11-15：学习库与账号更新的当前状态见 [发布记录](docs/RELEASE-2026-11-15.md)。下文2026-11-08线上信息作为既有基线；源码更新不代表生产已部署。

站点：[kapok.party](https://kapok.party)。源码：[3956ray/Kapok](https://github.com/3956ray/Kapok)。项目代号 KPK，当前阶段 CP03。线上运行在 Cloudflare Workers 与 D1，使用 Cloudflare Access 邮箱验证码。项目负责人控制部署、真实数据和验收。

## 接手先做什么

1. 核对 GitHub 分支、未提交改动和 Cloudflare 当前 Worker 版本。源文件、构建和部署回执分别记录，GitHub 提交并不自动部署。
2. 用 [README](README.md#本地验证) 的命令复现本地构建。真实业务验收通过已获授权的测试账号执行，合成账号只用于本机。
3. 按下表选择入口。修复前先复现可见问题或写入问题，保留旧数据和正在使用的回跳、草稿及权限行为。
4. 更新 [部署与验收](docs/DEPLOYMENT.md) 中的线上版本和待验项。涉及发布时，依次固定源码及构建、独立复审、备份、部署、线上复验。

## 当前产品行为

| 场景 | 规则 | 代码入口 |
|---|---|---|
| 注册和登录 | `/register` 先填盘名与背号，再邮箱验证，再确认建档。资料仅在当前标签页短暂预填，验证前零账号写入。`/login` 为已有用户，误走入口时解释状态。任何验证邮箱的人可以注册并直接入队。受限或已退出身份不能通过注册恢复。 | `lib/server/auth-entry.ts`、`app/auth/continue/`、`app/register/profile/`、`lib/client/registration-prefill.ts` |
| 工作区导航 | 桌面可折叠侧栏，手机四项导航。写复盘、编辑、分享时仍显示导航。训练与视频详情同列宽，视频内保留底部输入栏和独立滚动。 | `app/components/shell.tsx`、`navigation.tsx`、`app/globals.css` |
| 训练与视频 | 管理员同页发布训练，可带一条 B 站视频。训练、视频、动态与提交回执同一事务提交。可编辑、补视频并查看队员视图。归档只可回看。 | `app/admin/trainings/`、`lib/server/training.ts` |
| 讨论 | 根评论与一级展示的回复串。直接回复目标可指向根评论或某条回复，也支持回复自己。草稿按账号、视频和目标分开。视频时刻可定位，隐藏或删除的内容不能泄露原文。 | `app/components/video-discussion.tsx`、`lib/server/training.ts` |
| 成长、收藏与私人备注 | 收藏保留来源和可选时刻，私人备注仅本人可读，可转为私密复盘。访问失效时不展示已撤销的来源正文。 | `app/growth/`、`app/components/collections.tsx` |
| 复盘和分享 | 新记录默认私密。允许队内阅读和发布动态是两个动作。撤回动态不收回阅读，撤权后旧链接不可读。编辑已共享内容并保存会恢复为私密；取消保持原状态。恢复已删除内容保持私密。 | `app/reflections/`、`lib/server/reflections.ts` |
| 账号、后台 | 使用服务器判定的成员状态与角色。新成员默认普通队员。管理员可管理成员、训练和公告。不可撤掉最后一位有效管理员。导出只含本人有权数据。退出后清理本账号本机草稿和会话状态。 | `app/me/`、`app/admin/`、`lib/server/identity.ts`、`lib/server/data-rights.ts` |

B 站视频使用链接与播放器，不把外部视频写入 D1。训练、视频元数据、讨论、收藏、复盘、成员权限和提交回执都保存在 D1。当前线上学习图片通过 BUCKET 绑定私有 R2，由应用执行成员/所有权校验。生产认证适配在 `build/staging-worker.ts` 和 `lib/server/access-identity.ts`，API 分发在 `lib/server/http.ts`。公开入口仅为 `/`、`/login`、`/register`。邮箱准入开放后，业务页面仍需有效登录与成员权限。队员可访问队伍内容，私稿及私人备注仍按所有权隔离。

## 本地浏览器验证

在独立 checkout 安装依赖。以下是用于训练、复盘与权限交互的合成浏览器环境，独立于生产 Access。首次初始化时，停止同目录正在运行的本机服务。

```sh
npm run build
node tests/helpers/sharing-browser-fixture.mjs --confirm-local
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev \
  --config dist/server/wrangler.json --local \
  --persist-to .sites-runtime/reflection-sharing/state \
  --ip 127.0.0.1 --inspector-port 0 --port 8790
```

另开终端运行 `node tests/helpers/sharing-browser-proxy.mjs http://127.0.0.1:8790`。默认端口 `8791` 管理员、`8792` 作者、`8793` 队员、`8794` 非成员。读取 `.sites-runtime/reflection-sharing/fixture.json` 里的 `targetId`，用作者打开 `http://127.0.0.1:8792/reflections/<targetId>/sharing`。已初始化过的隔离状态直接复用；fixture 会拒绝覆盖同名目录。

真实 Access 行为用 `npm run build:staging` 和 `npm run test:staging` 验证编译产物。测试自动建立隔离 D1 与合成签名环境，覆盖匿名和伪造身份、登录与注册、迁移及并发。测试不会向邮箱发验证码。

## 当前待办与验收顺序

- 实际打开注册页，验证先填写、验证码、预填、确认和登录回跳。126 等国内邮箱与常用邮箱的真实收件由持有人操作，记录用时和结果。
- 在主域名用真实管理员和普通队员走发布、预览、播放与回复、收藏备注、复盘分享与撤权、退出和再次登录。测试前确认所见 Worker 版本。
- 首批四条视频日期已确认。真实导入由指定管理员在 [首批导入页](https://kapok.party/admin/trainings/import) 按手册预览、确认和逐条验证，不能把合成导入结果当成已入库。
- 手机软键盘、安全区、系统读屏、跨设备、实际 B 站播放、容量和恢复按 [部署与验收](docs/DEPLOYMENT.md) 复核。通过的测试要标注版本与环境。

设计参考和已获准的真实验收证据由项目负责人提供。对照以其确认的最新版本为准。
