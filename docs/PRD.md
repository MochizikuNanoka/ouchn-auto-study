# v2.0.10 空白题交卷适配 PRD

## Goal

当学习平台题目为空、答题插件跳过个别题时，已完成大多数题目的考试不再无限等待；仅在完成比例达到安全阈值且答题进度停滞后继续交卷。

## User Value

- A temporary platform outage or slow course directory no longer leaves the user at a stopped script after five attempts.
- Diagnostic records explain why the directory was not recognized, so a platform DOM change can be diagnosed from evidence rather than guesswork.
- The update panel only announces versions that are newer than the installed version and have actually been published as GitHub Releases.
- 题干、答题提示或平台正文中出现“500”不会中断答题；读到答题卡状态后持续等待插件完成。
- 个别空白题不会阻塞已完成大多数题目的自动交卷。
- A user can reset only assistant-owned cache without clearing login state or other platform data.
- Automatic recovery keeps the current task pointer but discards the prior directory model and rescans the directory.

## Acceptance Criteria

1. A missing, partial, or unparsable course directory records a structured diagnostic entry in the browser log and does not clear the recovery state.
2. Retry state survives F5 and continues past five attempts, using bounded exponential delay between refreshes.
3. Update checking reads the repository's latest published Release and treats `v2.0.1` as older than local `2.0.2`/`2.0.3`.
4. 课程目录或答题页出现任意 500/服务器错误/AxiosError 文本时，脚本不以该文本触发刷新；仅在目录或题目状态等待超时时恢复。
5. A visible cache-reset button clears only `ouchn_autoplay_*` storage entries, stops the running task, and reloads the course overview without logging the user out.
6. An automatic F5 recovery writes a unique directory-scan token, reloads the course overview with that token, and rebuilds pending tasks from the newly parsed directory.
7. User-visible comments, README prose, and runtime logs are Chinese, except unavoidable product names, protocol names, selectors, and code identifiers.
8. Unit tests cover cache clearing, fresh-scan recovery, version comparison, and existing recovery paths.
9. The v2.0.10 userscript is committed, pushed to GitHub, tagged, and published as a GitHub Release after verification.

## Constraints and Risks

- The userscript runs with `@grant none`; it cannot safely append to a local `log.txt` at runtime. `log.txt` is a diagnostic artifact for development; runtime evidence remains in the injected panel and browser console.
- Live browser testing may require an existing authenticated Edge session. Login, CAPTCHA, and credentials stay user-operated.
- Removing the retry cap can cause long-lived recovery loops during an outage; the delay remains exponentially backed off and capped per attempt.

## v2.0.14 Server酱³完成通知

### Goal

用户可从主操作区配置 Server酱³ SendKey 并发送测试消息；全部学习任务正常完成时，收到一条包含课程 ID、视频完成数、考试完成数和异常次数的手机通知。

### Acceptance Criteria

1. Server酱³入口位于主操作区，设置区域包含密码型 SendKey 输入框、测试消息按钮和官方使用文档链接；清缓存重置移入“调试与更新”。
2. SendKey 使用 Tampermonkey 私有存储，不写入页面 `localStorage`、日志、仓库或项目记忆。
3. 留空或格式无效时不发请求；有效 SendKey 按官方规则提取 UID 并发送表单编码的 POST 请求。
4. 一次正常完成流程最多发送一条通知；发送失败只记录不含 SendKey 的警告，不阻塞完成收尾。
5. 控制面板操作按钮的最小高度不低于 36px，提升点击面积但不改变现有视觉语言。
6. 启用 GM 权限后的 Tampermonkey 沙箱不得影响课程目录解析、任务点击、视频和考试处理等原有功能。
