# Issue Tracker：GitHub

本仓库的 Issues 与规格说明（specs）均托管在 GitHub Issues（`shenleg/subboost`）中。所有操作统一使用 `gh` CLI。

## 操作约定

- **创建 Issue**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **查看 Issue**：`gh issue view <number> --json number,title,body,labels,comments`。
- **列出 Issues**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，按需搭配 `--label` 与 `--state` 过滤。
- **设置父子 Issue 关系（Sub-issue）**：使用 `gh issue create --parent <parent> ...`，或事后执行 `gh issue edit <parent> --add-sub-issue <child>`（需 `gh` 2.94+）。旧版 `gh` 可调用：`gh api --method POST repos/<owner>/<repo>/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`（数据库 ID 获取方式见下方**阻塞依赖**）。若不支持 sub-issues，则在子 Issue 正文顶部注明 `Part of #<parent>`。
- **阻塞依赖（Blocking）**：使用 GitHub **原生 Issue 依赖关系**（标准且在界面可见）。通过 `gh issue create --blocked-by <n>,<n> ...` 或 `gh issue edit <child> --add-blocked-by <blocker>` 添加依赖（需 `gh` 2.94+）。旧版 `gh` 可调用：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞项的纯数字**数据库 ID**（通过 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 获取，*不是* `#number` 或 `node_id`）。若原生依赖不可用，则退回在子 Issue 正文顶部写 `Blocked by: #<n>, #<n>`。当所有阻塞项均已关闭时，任务单即为解除阻塞。
- **统计未关闭的阻塞项**：`gh api repos/<owner>/<repo>/issues/<n> --jq .issue_dependencies_summary.blocked_by`（仅统计 open 状态的阻塞项；为 `0` 表示可开始）。`gh issue view <n> --json blockedBy` 也会包含已关闭的阻塞项，因此需额外过滤：`--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`。
- **评论 Issue**：`gh issue comment <number> --body "..."`。
- **添加 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`。
- **关闭 Issue**：先用 `gh issue comment <number> --body "..."` 发布关闭说明，再执行 `gh issue close <number>`。（对已关闭的 Issue 执行 `gh issue close --comment` 会丢弃评论且仍返回退出码 0。）

目标仓库从 `git remote -v` 自动推断；在本仓库目录内运行 `gh` 会默认使用已配置的 `shenleg/subboost`。

仅向用户自己的仓库提交 Issue，切勿提交到 `mattpocock/skills`（技能来源仓库），除非用户拥有该仓库。由于本仓库为 Fork，`gh` 可能指向父仓库，因此每次会话首次执行 `gh issue create` 前，请先通过 `gh repo view --json nameWithOwner` 检查目标仓库；如果不是用户自己的仓库，须先与用户确认。

## 将 Pull Request 作为分诊入口（PRs as a triage surface）

**PRs as a request surface: no.** *（若本仓库将外部 PR 视为功能请求进行分诊，可将其改为 `yes`；`/triage` 会读取该标记。）*

当设为 `yes` 时，PR 遵循与 Issue 相同的标签与状态流转，并使用对应的 `gh pr` 命令：

- **查看 PR**：先执行 `gh pr view <number>`，再执行 `gh pr view <number> --comments`（非 TTY 环境下 `--comments` 只打印评论而不打印正文），以及 `gh pr diff <number>` 查看改动。
- **列出待分诊的外部 PR**：`gh api --paginate 'repos/{owner}/{repo}/pulls?state=open' --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR") | not) | {number, title, author: .user.login, author_association, labels: [.labels[].name]}'`。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 Issue 与 PR 共用编号空间，因此单独的 `#42` 可能是其中任意一种：优先尝试 `gh pr view 42`，失败后再回退到 `gh issue view 42`。

## 当技能要求“发布到 Issue Tracker（publish to the issue tracker）”时

创建一个 GitHub Issue。

## 当技能要求“获取相关任务单（fetch the relevant ticket）”时

按照上方**查看 Issue**的约定读取内容。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图（map）** 为单个父 Issue，**子任务单（child）** 为挂在其下的子 Issue。

- **Map**：带有 `wayfinder:map` 标签的单个 Issue，正文记录 Notes / Decisions-so-far / Fog。创建命令：`gh issue create --label wayfinder:map`。
- **子任务单（Child ticket）**：作为 GitHub sub-issue 关联到 map（参见上方**设置父子 Issue 关系**）。若未启用 sub-issues，则将该子项添加到 map 正文的任务列表，并在子 Issue 正文顶部写明 `Part of #<map>`。使用标签 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后将该任务单分配给负责推进的开发者。
- **阻塞依赖**：参见上方**操作约定**中的**阻塞依赖（Blocking）**。
- **前沿查询（Frontier query）**：列出 map 下所有 open 状态的子 Issue（`gh issue list --state open`，限定在 map 的 sub-issues / 任务列表范围内），排除仍有未关闭阻塞项（参见**统计未关闭的阻塞项**，或 `Blocked by` 行中仍有未关闭 Issue）以及已有 assignee 的项；按 map 中的排列顺序取第一个。
- **认领（Claim）**：`gh issue edit <n> --add-assignee @me`，作为会话的第一次写操作。
- **解决（Resolve）**：先执行 `gh issue comment <n> --body "<answer>"`，再执行 `gh issue close <n>`，然后在 map 的 `Decisions-so-far` 中追加一条上下文指针（要点摘要 + 链接）。
