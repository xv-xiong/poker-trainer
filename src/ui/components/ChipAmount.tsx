/**
 * 金额 + 单位后缀的展示组件（阶段六补丁）。
 *
 * 为什么需要它，而不是直接用 `formatAmount()` 的字符串：
 * BB 档下如果单位与数字同字号同颜色，「99 BB」里的 BB 会和数字抢注意力，
 * 座位筹码只有 13.5px，多两个等宽字符还可能把座位撑破。
 * 用独立 `<span>` 承载后缀，CSS 才能把它压到 0.72em 并降透明度 ——
 * **读的时候眼睛停在数字上，需要确认单位时才看到 BB**。
 *
 * 筹码档不渲染任何后缀（原样返回数字）：筹码是权威单位，加「筹码」两个字
 * 只会让牌桌变吵；而且 `.bankroll .amount` 的文本是既有 E2E 的断言对象
 * （`toHaveText('1000')`），必须保持纯数字。
 *
 * 注意：**下注输入框里不要用它**。输入框自带一枚 `raise-unit` 标签标注当前单位，
 * 若在输入框内再带后缀，`parseChipInput` 虽然能解析，但用户要继续编辑
 * （比如把 `99` 改成 `120`）时会先把后缀删掉，多一步无谓操作。
 * 输入框走 `formatChips`（纯数字）。
 */

import type { ChipUnit } from '../chipUnit.js';
import { formatChips } from '../chipUnit.js';

export function ChipAmount({
  chips,
  unit,
  bigBlind,
}: {
  chips: number;
  unit: ChipUnit;
  bigBlind: number;
}) {
  const text = formatChips(chips, unit, bigBlind);
  if (unit !== 'bb') return <>{text}</>;
  return (
    <>
      {text}
      <span className="unit-bb">BB</span>
    </>
  );
}
