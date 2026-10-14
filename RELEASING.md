# 版本发布流程

应用按语义化版本发布。发布 v1.1.0 时：

1. 确认 `CHANGELOG.md` 的「未发布」条目完整，并将其标题更新为 `## [1.1.0] - YYYY-MM-DD`。
2. 更新 `package.json` 中的 `version`；提交并合并到 `main`。
3. 创建带注释的 Git tag 并推送：

   ```bash
   git tag -a v1.1.0 -m "v1.1.0"
   git push origin v1.1.0
   ```

4. 在 GitHub 的 Releases 页面，以 `v1.1.0` tag 创建 Release，标题使用 `v1.1.0`，正文复制对应的 `CHANGELOG.md` 条目。
5. 等待 `Deploy to GitHub Pages` 成功，再检查线上地址和 GitHub Pages 部署记录。

## 发布检查清单

- [ ] `npm run verify` 全绿
- [ ] `LICENSE` 与 `package.json` 的 SPDX 许可证一致
- [ ] 变更日志已更新
- [ ] README 的截图与线上版本一致
- [ ] GitHub Actions 的 CI 和 Pages 部署均成功
- [ ] Release 使用语义化版本 tag（例如 `v1.1.0`）

## 回滚

如发布后发现阻断性问题，提交修复到 `main` 并等待 Pages 自动部署；不要移动或重写已公开的版本 tag。若确需回滚到旧构建，应新增修复提交，而非强制推送覆盖历史。
