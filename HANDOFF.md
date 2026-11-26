# Kapok 完整交接

Kapok 正式工作区运行在 Cloudflare Workers、D1 和私有 R2。2026-11-24 已上线 Bloom 工作区、复盘及公告留言。新接手者先读[本轮开发过程、产品决定与待验项](docs/RELEASE-2026-11-24.md)，再查[逐批生产回执](docs/DEPLOYMENT.md)。[正式站](https://kapok.party/home) · [GitHub](https://github.com/3956ray/Kapok)

## 接手先做什么

1. 核对 GitHub 分支、未提交改动和 Cloudflare 当前 Worker 版本。源文件、构建和部署回执分别记录，GitHub 提交并不自动部署。
2. 用 [README](README.md#本地验证) 的命令复现本地构建。真实业务验收通过已获授权的测试账号执行，合成账号只用于本机。
3. 按下表选择入口。修复前先复现可见问题或写入问题，保留旧数据和正在使用的回跳、草稿及权限行为。
4. 更新 [部署与验收](docs/DEPLOYMENT.md) 中的线上版本和待验项。涉及发布时，依次固定源码及构建、独立复审、备份、部署、线上复验。

## 当前产品行为

| 场景 | 规则 | 代码入口 |
|---|---|---|
| 注册和登录 | `/register` 先填盘名与背号，再邮箱验证，再确认建档。资料仅在当前标签页短暂预填，验证前零账号写入。`/login` 为已有用户，误走入口时解释状态。任何验证邮箱的人可以注册并直接入队。受限或已退出身份不能通过注册恢复。 | `lib/server/auth-entry.ts`、`app/auth/continue/`、`app/register/profile/`、`lib/client/registration-prefill.ts` |
| 工作区导航 | 正式入口为 `/home`。手机底栏有训练、动态、想和写、成长、我的五项，桌面使用可折叠侧栏。旧资料链接仍需核对来源权限。 | `app/workspace-ui/shell.jsx`、`app/workspace-ui/router.jsx` |
| 训练与日常 | 管理员管理队伍训练，队员可发布个人资料。日常图文可只发文字，进入动态。视频默认用平台封面，支持自选图。 | `app/workspace-ui/training.jsx`、`lib/server/video-covers.ts` |
| 合集与来源 | 合集可手动收录训练、单条视频、图文（含日常分享）与队内可读复盘。日常分享继续留在训练档案之外，复盘按原文授权读取，无需分发到动态。章节可前后切换。撤回合集后，队员打开旧链接须重新检查可见性。 | `app/workspace-ui/collections.jsx`、`lib/server/topic-collections.ts` |
| 讨论 | 训练和视频支持讨论与时间点引用。队内可读的复盘和已发布的公告支持文字留言、回复及删除自己的留言。动态入口可定位原留言。 | `app/workspace-ui/discussion.jsx`、`lib/server/reader-discussions.ts` |
| 成长与复盘 | 收藏和私人备注归本人。可从已保存的备注新建复盘。「想和写」默认私密，队内阅读和分发动态分别控制。作者有编辑和删除入口。 | `app/workspace-ui/journal.jsx`、`lib/server/reflections.ts` |
| 账号与管理 | 管理角色绑定队员账号，移交时保留原作者和至少一位可登录的有效管理员。支持头像与本人资料导出，暂停期间停止导出。 | `app/workspace-ui/manage.jsx`、`lib/server/profile-avatar.ts`、`lib/server/data-rights.ts` |

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

运行 `npm run build:staging` 和 `npm run test:staging` 可在隔离 D1 和合成签名环境中验证编译产物，覆盖身份校验、登录与注册、迁移及并发。真实邮箱收码和登录回跳需账号持有人在正式站另验。

## 当前待办与验收顺序

- 实际打开注册页，验证先填写、验证码、预填、确认和登录回跳。126 等国内邮箱与常用邮箱的真实收件由持有人操作，记录用时和结果。
- 在主域名用真实管理员和普通队员走发布、预览、播放与回复、收藏备注、复盘分享与撤权、退出和再次登录。测试前确认所见 Worker 版本。
- 视频导入已有正式清点结果。新增批次先核对账号、分类和重复链接，再查受限账本，避免再次执行历史批次。见[批次记录](docs/RELEASE-2026-11-24.md)。
- 手机软键盘、安全区、系统读屏、跨设备、实际 B 站播放、容量和恢复按 [部署与验收](docs/DEPLOYMENT.md) 复核。通过的测试要标注版本与环境。

设计参考和已获准的真实验收证据由项目负责人提供。对照以其确认的最新版本为准。
