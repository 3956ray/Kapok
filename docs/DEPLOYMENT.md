# Kapok 部署、恢复与验收

> 2026-11-16：最新学习库交互更新已部署，见 [发布记录](RELEASE-2026-11-16.md)。

> 2026-11-15：学习库与账号更新的部署状态见 [发布记录](RELEASE-2026-11-15.md)。下文2026-11-08线上信息作为既有基线；源码更新不代表生产已部署。

线上入口 [kapok.party](https://kapok.party)。从 Cloudflare Dashboard 查看当前部署版本与 Worker、Access 应用及 D1 的绑定。部署负责人保存所用 Git 提交、实际构建 SHA-256、Cloudflare Worker 版本、迁移记录及验收结果。

## 最近已核对版本

2026-11-24 合集阅读与封面更新已上线。应用提交 `01428c9`，Worker `1841a711-4a7a-491f-9617-ad5e58aa46be` 承接 100% 流量。受限构建归档 SHA-256 为 `5aef6cc542561b7470570db15ce6117c4f6f46e597417ea109d7a960f43e232b`。生产 D1 已导出并验证可恢复，追加迁移 `0025_workspace_topic_covers.sql` 已核对入账及封面修订表。集成测试通过 593 项、跳过 2 项，Worker 测试通过 5 项。真实账号在 390px 和 1280px 下只读验证了现有三项合集、原资料与讨论、前后切换、返回目录、旧章节直链和编辑器封面入口。本地双账号验证讨论写回、自选封面、恢复默认、旧分享保留封面，以及单条视频被另一份合集收录后的指向。

2026-11-24 工作区阅读与删除修复已上线。应用提交 `5863b12`，Worker `d1daabfb-56a1-4730-bc91-45e6ef5e1297` 承接 100% 流量，受限构建归档 SHA-256 为 `f0c4e292e42ffa392bb217b4c04ece3a06afd64c94f87c9a05f4ff560100b1b4`。正式站已验证新建入口、已撤回图文的作者搜索、个人发布列表、阅读和编辑直链，以及历史复盘的网址跳转。记录日期与图文用途两种模式均在 320、390、1280px 同尺寸复测，上下边缘差为 0px。数据库无需迁移，发布前已校验 D1 备份。

本机合成账号验证删除取消、确认、跨标签页草稿和存储失败重试，以及公告清空标题后删除。集成测试首次通过 582 项、跳过 2 项，另有 7 项遇到本机连接故障，所属数据权限测试文件单独重跑 13/13 通过。构建 Worker 测试 5/5 通过。

2026-11-24 日常图文与训练归档已上线。应用提交 `135b912`，Worker `4ba3fc80-f688-4ab3-b221-47100adf4d6f` 承接 100% 流量，受限构建归档 SHA-256 为 `23b9c58dcb0823f0584c0f1d1491622cbe29e6d05191bd62d3891a11db2ef693`。本次无需数据库迁移，发布前已导出并校验 D1 备份。集成测试通过 586 项、跳过 2 项，Worker 测试通过 5 项。合成双账号验证纯文字图文发布及队友读取。正式站在 390px 和 1280px 验证训练档案、合集清单和图文用途选项，并确认历史复盘、队内动态与关联相册可读。

2026-11-24 个人头像已上线，应用提交 `cf062ec`，Worker `1ebd1c4d-01fd-4075-ba90-ade5672db6b3` 承接 100% 流量，受限构建归档 SHA-256 为 `2bfbea72e12113f3ca2729e9ff7e2ad7e1379ccbb9b32082da59574796d1d9b9`。迁移 `0024_profile_avatars.sql` 新增头像表，已核对恢复点、备份完整性和生产表结构。正式账号在 390px、1280px 下验证入口、预览和取消。上传、重开后显示、队友读取旧评论和恢复默认通过 Chrome、Firefox、WebKit 双账号合成测试。

2026-11-08 已部署 Worker `b80ed620-9bee-47a8-8bfe-f6558b3b4ecf`，正式构建归档 SHA-256 `54554af790f528fb9815c46503a5af716cf955a518df2c11b280cf0eca064d0e`。Access 开放邮箱 OTP，线上入口及保护冒烟 5/5。真实收件和完整设备验收待复测。

本公开快照以该版本的业务源码为基准。部署配置与视频数据改为合成或由授权环境补入，公开构建的哈希因此与正式归档不同。公开快照复现了锁定依赖安装、类型检查、lint、构建、真实编译 Worker 5 项检查、dry-run 和本地合成浏览器预览入口。整站集成 425 通过、2 项有条件跳过，最后的开放注册文案同步后另跑 8 项定向回归及 Worker 检查。

## 生产构建输入

默认 `npm run build:staging` 生成合成配置，没有自定义域路由。实际部署从独立发布 checkout 执行。通过 Cloudflare Dashboard 或授权连接器核对现有资源，使用以下格式创建忽略的 `kapok.deploy.local.json`，各字段填实际值：

| 字段 | 获取位置 |
|---|---|
| `worker` | Workers & Pages 中绑定 kapok.party 的 Worker 名称 |
| `accountId` | Cloudflare 账号 ID |
| `host` | `kapok.party` |
| `databaseName`、`databaseId` | 已部署 Worker 的 `DB` D1 绑定 |
| `accessIssuer` | Zero Trust 团队域名，含 `https://`，无尾斜线 |
| `accessAudience` | kapok.party 的 Access Application Audience |
| `bucketName` | 已建立的私有Standard R2桶，不开放r2.dev或自定义公共域 |

配置格式示例，值均为占位：

```json
{
  "worker": "kapok-example",
  "accountId": "00000000000000000000000000000000",
  "host": "kapok.example.test",
  "databaseName": "kapok-example",
  "databaseId": "00000000-0000-4000-8000-000000000001",
  "accessIssuer": "https://example.cloudflareaccess.com",
  "accessAudience": "0000000000000000000000000000000000000000000000000000000000000000",
  "bucketName": "kapok-example-media"
}
```

在该发布 checkout，将 `lib/import/initial-batch.json` 的公开合成样本替换为负责人提供的获准清单。构建会阻止将样本带入带生产配置的版本。真实清单不可提交到公开仓库。获取 `ACCESS_INITIAL_ADMIN_EMAIL` 等敏感 Worker 绑定用授权的 Cloudflare secret 流程，值留在正式环境。延续既有 D1、账号和域名。

```sh
KAPOK_DEPLOY_CONFIG_PATH="$PWD/kapok.deploy.local.json" npm run build:staging
npm run dry-run:staging
```

固定 `dist/staging/client`、`dist/staging/server` 和对应迁移。核对生成的 `dist/staging/server/wrangler.json`。部署必须传明确配置路径，避免拿错 Sites 或本机配置。线上通过 BUCKET 绑定私有 R2，默认 `workers.dev` 和预览域关闭，静态资源由 Worker 优先处理。

## 部署顺序

1. 本地运行完整检查，独立复测实际构建。核对当前线上 Worker、Access 和 D1，保存回退用构建与配置。备份数据库和导入账本，备份留在受限存储。用隔离副本实际恢复，检查完整性、外键、所有权、删除和撤权状态。
2. 查 D1 迁移账本。现有版本使用 `0000`–`0010`，已应用文件不改写。仅有经审查的新增迁移才用 Wrangler `d1 migrations apply DB --remote --config dist/staging/server/wrangler.json`。回读账本与列状态。出现部分失败先诊断，不盲目重跑 ALTER。
3. 在仓库根目录使用 `node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js deploy --config dist/staging/server/wrangler.json`，记录版本。保留精确公开根与登录注册，其他子路径和业务 API 继续由 Access 保护。Access 当前使用邮箱 OTP 与 Everyone Allow，新账号验证完成后可自行注册，Worker 仍执行成员和管理员判断。
4. 检查 `/`、`/login`、`/register`、`/register/profile`、`/auth/continue` 和 `/api/v1/me` 的真实响应。公开注册页先显示字段，资料页和 API 要求认证。真人复验注册、既有账号登录、回跳、退出和受限账号。
5. 如需回退，先核对旧构建与现有数据及登录状态兼容。回退代码保持现有 D1，不用旧库覆盖新写入。若必须恢复数据，先在隔离副本核验删除、私密与撤权，确定恢复窗口后再由负责人处理。

## 首批导入

指定管理员用真实会话打开 [首批视频导入页](https://kapok.party/admin/trainings/import)。核对显示的发布者和精确计划，确认日期、训练匹配和冲突。执行前导出账本；执行后再次导出并验证四条日期、训练关联、署名、队员可见性及播放。超时或中断使用原账本核对，避免重复创建。相同账本重跑预期零新增。审批后映射变化必须重新核对。未确认活动日期的另外四条不进入本批。验证码、Cookie、令牌和账本都无需上传。

## 验收清单

| 核验 | 通过标准 |
|---|---|
| 版本与构建 | 源码、配置和构建哈希一致，类型、lint、串行集成、真实编译 Worker 与 dry-run 通过。 |
| 注册 | 授权的真实国内邮箱和 Gmail 走完整注册，记录 OTP 用时、失败及回退。注册前零写入，确认后只创建一个账号。已有账号正确登录，停用账号不能复活。 |
| 权限与数据 | 队员无法直访管理动作和他人私稿。撤回与撤权语义正确，旧链接与晚到响应不泄露正文。重复提交、断网、超时和恢复不会重复写入。 |
| 核心任务 | 管理员有/无视频一次发布、补视频、队员预览、B站播放和时刻、直接回复、私人备注转复盘、分享撤权、账户与后台完整通过。真实首批逐条检查。 |
| 真机和视觉 | 同尺寸核对实际构建与设计。320/390/桌面及 200% 缩放无横向溢出，底部输入和导航不遮挡操作。用大陆 iOS/Android 的 Wi-Fi 和移动网络，实测键盘、读屏和 B 站。 |
| 性能和恢复 | 登录后页面 Lighthouse 三次中位数目标为性能 ≥90、可访问性 ≥95、最佳实践 ≥95。隔离容量测试 60 并发、30 分钟、每会话约 5 秒请求、80/20 读写，p95 ≤2 秒、5xx <1%。备份恢复目标 RPO 24 小时、人工介入后 RTO 2 小时。 |

更新后观察 48 小时，并在首次队伍使用后复查。源码测试、合成浏览器测试、线上冒烟和真人验收分别记录。前一阶段的通过不能代替后续真实验收。
