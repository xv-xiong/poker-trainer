# 文档资源

## screenshots/

README 中展示的四张截图，均截取自**线上地址**
（<https://xv-xiong.github.io/poker-trainer/>），保证与用户实际看到的一致。

| 文件 | 内容 |
|---|---|
| `start.png` | 开始界面：眉字 + 大标题 + A♠/K♥ 装饰牌 + 参数/战绩面板 + 「开始练习」入口 |
| `table.png` | 牌桌与 AI 分步演出：思考气泡、动作气泡、底池胶囊、当前行动座位光晕 |
| `settlement.png` | 结算面板：分配明细（主池 / 边池 / 未跟注退还）+ 未跟注退还说明 |
| `review.png` | 决策复盘：逐决策点的 EV 损失、底池赔率、估算胜率与分级 |

重新截图：

```bash
# 需先全局安装 playwright 并在项目内可用
node scripts/capture-screenshots.mjs
```

## 设计参考

`../_local_only/outputs/poker-trainer-ref-research/`（不在版本库内）保存了对参考站
`http://115.159.33.124:3000/` 的取证笔记、结算审计报告与设计参考文档。
