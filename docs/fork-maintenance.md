# 本 Fork 的技术与维护说明

维护日期：2026-10-29。约束在 [AGENTS.md](../AGENTS.md)，通用发布方法在[定制部署指南](deployment.md)。这里描述与上游的差异和可复现工作方法，不包含任何部署方的私有运行信息。

## 代码与部署的四个版本

| 对象 | 核对方法 |
| --- | --- |
| 当前工作树 | `git status --short --branch`、相关 `git diff` |
| 本地/用户远程提交 | `git log`、`git remote -v`；联网核对 `origin/main` |
| 发布包 | 私有发布目录内 manifest、源码快照和构建产物 SHA-256 |
| 真正运行版本 | `docker inspect` 与 Compose 镜像引用、运行文件哈希 |

自己的远程为 `https://github.com/Sark1tama/PerPay.git`，上游为 `https://github.com/Mashiro0619/PerPay.git`。当前维护在 `main`；本次本地合并上游至 `a932e1e`，保留已有金额方向及收银台定制。此次合并不包含推送、Release 或生产部署；生产变更须另获明确同意。

当前源码应用版本 `1.0.0-alpha.2.fork.2`，数据库兼容声明24—38；以 `src/version.ts` 为准。上游 `1.0.0-alpha.2` 的上限是36，定制版本后缀用于区分兼容范围，不代表已发布镜像。根 `docker-compose.yml` 中的 GHCR `latest` 是通用上游模板，已有定制实例应以自己的私有部署配置为准。

## 必须理解的定制

| 定制 | 技术含义与维护检查 |
| --- | --- |
| 网站金额调整方向 | 同一网站可选择向上/向下，默认向上；向下不允许应付小于0.01元。金额槽位、冷却和订单快照仍走原流程 |
| 精确金额提示 | 桌面、手机、二维码放大及付款查询反馈都要保留；强调精确金额且不可四舍五入，不能只检查桌面一个 DOM 位置 |
| 手机弹窗 | 短视口/200%文字缩放下正文独立滚动，金额、二维码和提示可达，关闭按钮及键盘焦点仍可用 |
| 未确认付款的反馈 | 查账完成但未匹配时提示核对实际金额；不是直接宣布付款失败，也不自动再建订单或反复提交核实请求 |
| 24小时退回文案 | 用户确认的运营说明；PerPay 的退款标记只是人工声明，不执行支付宝退款，不能据此推导自动退款闭环 |

向下减价至少保留至官方提供等价能力后再评估替换，核对最低金额、占用与冷却、网站策略和旧单幂等。精确金额、手机、二维码弹窗和未确认付款提示永久作为本 Fork 定制保留。

向下分配从1分开始，未将原价作为额外槽位；原价优先曾讨论但明确暂不实施。金额调整方向、最大差额、付款有效期、金额复用等待和待付款上限是不同控制项；本地默认值不代表每个线上网站的实际设置。

关键代码入口：`web/src/checkout/CheckoutApp.tsx`、`web/src/checkout/controller.ts`、`src/database/amount-offset-migration.ts`、`src/database/migrations.ts`、`src/version.ts`。修改接口契约同时检查 `openapi.yaml`、生成类型和相关服务端校验，不只改表单选项。

## 数据库迁移冲突

- 本 Fork 已上线的迁移36实现双向金额调整；它的历史编号和校验和是生产数据库的一部分。
- 上游新增的36是管理员会话登录 IP/UA，合入时在本 Fork 顺延为37，旧会话未知字段保持空值。
- 因此“上游36”“本 Fork36”不能互换；同样声称支持37也不能跳过迁移内容比较。
- 上游多账号迁移37在本 Fork 顺延为38，重建金额占用表时保留最低1分。原有1—37的编号、SQL与校验和不变；新版本 `1.0.0-alpha.2.fork.2` 对应38，旧 `fork.1` 的37上限仍冻结。
- 多账号下同账号的网站共享金额占用与冷却，不同账号可使用相同金额；每个候选账号仍按网站的向上/向下方向分配。旧订单固定账号、金额与二维码，不能用更换方向或账号配置重解释幂等请求。
- 合并上游应先 diff `migrations.ts`、配套迁移文件及 `version.ts`，在隔离副本迁移后验证完整性、外键和既有财务表/配置/密钥；详见[维护与恢复](maintenance.md#固定版本与回滚)。

## 开发与验证

Node.js 使用 `package.json` 要求的24.x；Docker与CI另有固定补丁版本，修改时核对各处一致性。依赖以锁文件为准，采用 `npm ci --ignore-scripts`；Windows 用 `npm.cmd`/`npx.cmd` 避免 PowerShell 脚本策略干扰。

```powershell
npm.cmd run typecheck
npx.cmd vitest run --config web/vite.config.ts web/test/checkout-lifecycle.test.ts
npm.cmd run build:checkout
```

范围更广的代码/迁移合并执行 `npm.cmd run check`，按改动再验证完整构建和 UI。UI 夹具使用合成库并禁止外部 fetch，不是真实支付宝验收：

```powershell
npm.cmd run build
npx.cmd playwright test ui-tests/checkout-touch.spec.ts --project core
```

默认 Playwright 配置使用其安装的 Chromium。缺少对应版本时可以安装浏览器；当前本地另可用忽略的 `data/push-review.config.ts` 覆盖 `channel: 'msedge'` 与测试目录：

```powershell
npx.cmd playwright test --config data/push-review.config.ts checkout-touch.spec.ts --project core
```

该忽略文件不是仓库自带前提；新机器需自行准备测试环境或使用标准 Chromium。前端测试前重建产物，避免源码测试与 UI 夹具读取不同版本。2026-10-27 推送前通过类型检查、81项收银台逻辑测试、checkout双构建和Edge移动端测试；该次并未重新执行所有上游测试或真实付款。

2026-10-28 合并验证：Node.js 24.22.1 下 `npm run check` 通过，包含版本/API校验、类型检查、1275项后端测试、1897项前端测试及管理端、checkout客户端/SSR、服务端构建；Edge浏览器34项通过，覆盖收银台布局、复制金额、状态、200%文字缩放、无脚本展示、弹窗键盘滚动、网站必填项及详情来源。仅使用合成数据，未运行生产验收或本机Docker双架构验收。

2026-10-29 合并上游至 `a932e1e`：`npm run check` 通过，版本/API校验、三组类型检查、1336项后端测试、1966项前端测试及全部构建通过，测试无跳过。新增验证包含多账号向下减价、候选账号金额耗尽后的分配、冷却、改方向/账号后的旧单重放，以及含1分旧订单的 Fork37→38升级、密钥保留与备份恢复。Edge浏览器23项通过，覆盖390/1440宽度的账号配置、保存减价策略、1元下单显示0.99元、精确金额及二维码提示、200%字体、无脚本收银台、手动查账和更新偏好；截图另在禁用过渡动画后复核。仅使用临时库、合成订单和模拟支付宝响应，未验证真实付款、生产升级或Docker双架构运行。

本次macOS验证将 `TMPDIR` 指向真实路径，避免 `/var` 与 `/private/var` 的符号链接差异；临时Node预加载脚本仅将测试客户端 `http.globalAgent.maxSockets` 限为32，避免160条并发连接超过本机监听队列，原测试请求总数及限流断言保持不变。前端菜单弹窗测试等待焦点进入后才发送Escape，避免把异步聚焦尚未完成当作关闭失败。

## 合并与交付

1. 确认工作树和 `origin`/`upstream`；获取上游后核对合并范围，尤其迁移编号、金额分配、收银台与安全链路。
2. 解决冲突时保留本 Fork 已落库行为及用户要求的提示，不整文件覆盖；检查移动端独立提示位置和 SSR。
3. 按范围验证、提交；用户要求推送时推自己的 `origin/main`。推送成功不等于云端已更新。
4. 需要部署时按云端文档先准备、验证、等待空闲；生产镜像、备份、源码快照和测试记录用 manifest 关联。不要把仅有源码提交号当作旧 dirty-tree 镜像的完整依据。

商城适配插件属于独立的集成方。PerPay提供支付订单与签名通知，商城验签核单后才确认付款并发放商品权益；不能直接由收银台回跳发放权益。对接时按 [USAGE](../USAGE.md) 核对契约，私有集成代码与路径不写入此公开仓库。
