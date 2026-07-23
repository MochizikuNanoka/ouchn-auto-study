# v2.0.16 发布说明

## 修复最新 Release 跳转缓存

- 更新检查继续使用 GitHub 最新正式 Release 跳转，不消耗 REST API 匿名额度。
- 请求增加时间戳和无缓存选项，避免新版本发布后短时间内仍读取到旧版本跳转。
- 不需要 GitHub Token，不读取分支文件。

## 验证

- 已验证裸 `releases/latest` 命中旧跳转缓存时，带时间戳请求可立即返回当前最新 Release。
- JavaScript 语法检查、Node 回归测试和 diff 空白检查全部通过。
