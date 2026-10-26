# 文档入口

维护日期：2026-10-27。本仓库是 `Sark1tama/PerPay` 的定制 Fork；规则看 [AGENTS.md](../AGENTS.md)，不要用旧开发交接的分支和路径指导当前操作。

| 任务 | 入口 |
| --- | --- |
| 产品说明、上游通用部署 | [README](../README.md) |
| 本 Fork 的差异、迁移冲突、开发和测试 | [Fork 维护](fork-maintenance.md) |
| 定制镜像部署、版本记录和回退边界 | [通用部署指南](deployment.md)；实际环境单独私有留存 |
| 查账故障、备份恢复、锁与租约 | [维护与恢复](maintenance.md) |
| API 和通知接入 | [USAGE](../USAGE.md)、[多网站](multi-site.md) |
| 支付宝应用与代理 | [支付宝配置](alipay-setup.md)、[反向代理](reverse-proxy.md) |
| 管理端和收银台架构、交互标准 | [前端 README](../web/README.md) |
| 无外部传输的页面预览与 UI 验证 | [合成场景](development/preview-scenarios.md)、[验证说明](development/ui-verification.md) |
| 上游历史交接 | [历史快照](development/handoff.md)，只作设计背景 |

版本、健康状态和测试数量都需要注明核验日期。调查保留结论与技术边界，原始账单、会话、日志和本地发布证据不进入公共文档。
