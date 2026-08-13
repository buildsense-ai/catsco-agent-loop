# 并发 Run 运维说明

本文用于只读判断两个 Controller Run 是否彼此隔离，以及排查疑似串线。它只使用现有 Run 状态、Artifact、GitHub 和 Finding 证据，不新增协议、数据库、队列或运行时代码。

## 一、隔离指纹

对每个 Run 单独记录下面这一行：

`run_id → Monday Topic → Developer Topic → branch → PR → Head SHA → Artifact Run 卡片与 Finding`

应同时满足以下条件：

1. 两个 `run_id` 不同。Run 的状态、事件和 Finding 文件位于各自 `run_id` 命名空间下。
2. 两个 Run 的 Monday Topic 不同，Developer Topic 也不同。每个 Run 只创建并复用自己的一个 Monday Agent Task 和一个 Developer Agent Task。
3. 分支精确等于 `loop/<run_id>`，两个分支互不相同。不要只根据任务标题或创建时间判断归属。
4. 每个 Run 的 PR 都指向自己的分支，记录仓库、base、head branch、PR number 和当前 Head SHA。两个 Run 不应共用分支或 PR；同一 PR 的后续修订应保持 PR number 不变但产生新的 Head SHA。
5. Artifact 适合作为汇总入口：先确认卡片上的 Run ID、工作分支、PR 和 Head，再打开该 Run 的事件和 Finding 下载路径。页面本身不直接显示 Topic ID 或 Finding SHA-256，不能单独证明完整隔离。
6. Finding 的 `source_topic_id` 必须属于该 Run 的 Monday Topic；Finding 版本、SHA-256 和存储路径也必须与该 Run 的 `run.json` 或 API 记录对应。

注意：不仅要检查“各字段都不同”，还要检查同一行内的对应关系。例如，Run A 的 PR head 不能指向 Run B 的分支，Run A 的 Finding `source_topic_id` 不能等于 Run B 的 Monday Topic。

## 二、并发槽与状态

未配置时，Controller 默认使用两个并发槽。配置项 `maxActiveRuns` 或环境变量 `CATSLOOP_MAX_ACTIVE_RUNS` 可显式设置 1 到 4；4 是硬上限，超过 4 会被限制为 4。配置文件中的示例值只是部署示例，不等于代码默认值。

状态的基本含义如下：

- `queued`：Run 已持久化，正在等待可用的 Controller 执行槽，不代表创建失败。
- 处理中：运维上的概括，覆盖 `monday_finding`、`developer_implementing`、`waiting_ci`、`monday_review` 和 `recovering`。
- `paused`：人工暂停的非终态；应单独标记为暂停，不把它误称为正在处理，也不要把它当作已完成。
- 终态：`completed`、`cancelled`、`blocked`、`blocked_auth`、`blocked_github_auth`。`completed` 表示正常完成，`cancelled` 表示取消，`blocked` 系列表示停止自动推进并等待人工处理，不等于业务成功。

调度器会从非 `queued`、非 `paused` 的 Run 中计算占用槽位，再按剩余槽位选择排队 Run。并发槽限制调度容量，不改变 Run 之间的身份隔离。

## 三、疑似串线时的只读核对顺序

发现异常后，先停止手工发送、push、review、resume 或 reconcile 等写动作，保留现状；不要删除 Topic、分支、PR 或 Artifact。

按以下顺序核对：

1. 从 Artifact 或 `GET /api/runs` 抄下两个精确的 `run_id`。分别读取 `GET /api/runs/:id` 或对应的 `run.json`，不要只按标题判断。
2. 对每个 Run 核对 `monday.topic_id` 和 `developer.topic_id`，确认两个 Run 没有复用任一 Topic；再检查事件和 dispatch receipt 的 `topic_id` 是否属于本 Run 的对应角色。
3. 核对 `branch === loop/<run_id>`。通过 GitHub 只读查询确认仓库、base、head branch、PR number 和 Head SHA，检查是否共用或交叉引用分支、PR。
4. 回到 Artifact 核对卡片的 Run ID、分支、PR 和 Head；检查事件、Finding API 和下载路径中的 `run_id`。共享 Artifact 页面本身不是串线证据。
5. 核对 `latest_finding` 与 `finding_history` 的 `source_topic_id`、版本、SHA-256 和 `stored_path`，确认 Finding 来自当前 Run 的 Monday Topic，并确认 review cycle 绑定当前 PR number 与精确 Head SHA。
6. 最后分别查看两个 Run 的 `events.jsonl` 时间线，定位第一个不一致点，记录证据并升级处理。在归属未确认前，不通过写操作“修正”状态。

以上顺序只读取现有 API、状态文件、Artifact 和 GitHub 记录，不要求增加任何运行时机制。