# 双 Agent 自迭代 Loop 架构基线

## 目标与边界

唯一人工入口显式创建 Controller Run。Controller 创建并永久复用一个 Monday Topic 和一个 Developer Topic，按以下机械证据推进：

```text
自然语言要求
→ Monday Finding ZIP
→ Developer 创建/更新固定 PR
→ CI
→ 原 Monday Topic Review 当前 Head SHA
  ├─ GitHub comment/review + 新 ZIP → 原 Developer Topic 继续
  └─ 当前 SHA APPROVED → 完成，不 merge
```

普通 Monday 会话和普通 ZIP 永远不会自动进入 Loop。Controller 不审查代码、不修改代码、不代替 Agent comment/approve、不 merge/close PR，也不要求 Agent 输出结构化 JSON。

本 Controller 只驱动可接受自然语言任务的通用 Developer。要求原生 `execute_attempt`、workspace lease 和 candidate event 的严格 Worker 属于独立 A2A Harness；两套协议不混合。若误选严格 Worker，Controller 识别其确定性协议拒绝并立即 `blocked`，不进行无意义恢复重试。

## 状态与证据

```text
queued → monday_finding → developer_implementing → waiting_ci → monday_review
                              ↑                         │             │
                              └──── CI failure ─────────┘             ├─ developer_implementing
                                                                     └─ completed

任意非终态 → recovering → 原阶段
任意阶段 → blocked / blocked_auth / blocked_github_auth / cancelled
```

Topic 是长期会话 ID；Episode `run_id` 是每次输入触发的运行 ID，不是 Controller 阶段。发送前记录旧 Episode、消息 seq 和稳定 `client_msg_id`；只有新 Episode 或发送后 Agent 消息才能证明本轮已启动。旧 `completed` 不能完成新一轮。

Episode 状态同时记录 `episode_observed_at`，只表示最后一次观测；界面必须以 `active_actor` 判断当前由谁工作，不能把非活跃 Agent 的旧 `running` 快照显示为仍在调度。

Run 目录保存原子 `run.json`、只追加 `events.jsonl`、`request.md` 和经 SHA-256/ZIP 合约验证的 `files/finding-vN.zip`。Controller 重启后先 Reconcile CatsCompany 与 GitHub 副作用，再决定是否续发。

## 完成条件

- Finding：来自本轮 dispatch seq 之后，可下载、路径安全，包含 `FINDING.md` 和 `manifest.json`。
- Developer 首轮：由配置的 Developer GitHub login 创建、来自正确仓库、base/`loop/<run_id>` 的 open PR；后续轮：同一 PR 的新 Head SHA。
- CI：当前 SHA 的 checks 成功；明确无 checks 时经过 grace window 后视为 no-check success。
- Monday 继续：本轮之后由配置的 Monday GitHub login 留下 comment/review，同时原 Monday Topic 产生新的有效 Finding ZIP。
- Monday 完成：配置的 Monday GitHub login 对当前 Head SHA 提交 `APPROVED`，且当前 SHA 的 CI 已通过。
- 任意新 commit 使旧 CI 与 Approval 失效。

## 恢复与安全

- 网络请求采用有界退避；Episode 缺交付采用 1/3/8/15 分钟恢复，45 分钟无机械进展进入 `blocked`。
- 续接只回到原 Topic，并附短 Resume Capsule；不会创建替代会话。
- 同一逻辑消息始终复用相同 `client_msg_id`。
- Agent Task 创建前按唯一 Run 名称回查，封闭“建群成功、落盘前崩溃”的重复创建窗口。
- 发现受控 Topic 中出现非 Controller 发送的人工消息时暂停，避免双重驱动。
- CatsCompany 401 可用保存的账号密码刷新 persistent token；403 不循环登录。
- Monday 与 Developer GitHub login 必须不同；Controller GitHub 身份只查询状态。
- 密钥只存 root-owned 环境文件；Artifact 静态文件不包含任何 CatsCompany/GitHub/操作员密钥。
