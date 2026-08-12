---
name: start-agent-loop
description: 通过 CatsCompany Loop Controller 启动 Monday 审查与 Developer 实现的自迭代任务。仅在用户明确希望启动、开启、交给或使用双 Agent 自迭代循环完成任务时使用；若用户只是在讨论该能力或意图不明确，先向用户确认，不得自行启动。
---

# 启动自迭代

## 判断是否启动

- 根据完整语义判断，不匹配固定关键词。
- 用户明确要求让任务进入自迭代、循环修改直至审核通过时，直接启动。
- 用户只询问功能、普通要求开发或意图含糊时，不启动；含糊时只问一次是否启用自迭代。
- 普通 Monday 会话、Finding ZIP 或任务复杂度都不能自动触发。

## 收集输入

只收集两项：

1. `request`：保留用户完整要求、验收标准和限制，不自行缩减关键约束。
2. `repo`：从当前对话中确定 `owner/name`。不知道或存在多个候选仓库时，先请用户确认，不要猜测。

不要让用户填写基础分支、Agent UID、GitHub 身份、Topic 或分支名。Controller 会查询仓库默认分支并管理这些值。

## 创建任务

运行：

```bash
node <SKILL_DIR>/scripts/start-loop.mjs --request-file <utf8-file> --repo <owner/name> --idempotency-key <stable-id>
```

- 将当前 CatsCompany 用户消息 ID 用作稳定 ID；确认消息后启动时使用确认消息 ID。
- 网络重试必须复用同一个 ID。
- 不在消息、日志或参数回显中暴露 Controller Token。
- 成功后只向用户返回 Run ID、当前状态和 Artifact 查看入口。

Skill 只负责创建一次 Run。后续 Monday、Developer、PR、CI、恢复和完成判断全部由 Controller 负责。
