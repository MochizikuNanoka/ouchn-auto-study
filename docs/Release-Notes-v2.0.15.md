# v2.0.15 发布说明

## 修复更新检查 HTTP 403

- 更新检查不再调用匿名 GitHub REST API，避免共享 IP 的每小时额度耗尽。
- 改为访问 GitHub 最新正式 Release 跳转地址，并从最终地址读取版本标签。
- 保持原有语义：只比较已正式发布的 Release，不读取分支文件，不需要 GitHub Token。

## 验证

- 已复现匿名 GitHub API 返回 HTTP 403 且额度归零。
- GitHub `releases/latest` 跳转地址可正常解析最新发布标签。
- JavaScript 语法检查、Node 回归测试和 diff 空白检查全部通过。
