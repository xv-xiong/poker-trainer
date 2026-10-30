/**
 * 演出层用到的两个 React 小工具。
 *
 * 单独成文件的原因：`useTableShowcase.ts` 在阶段四被拆到目标行数以内，
 * 而这两段与「演出调度」本身无关——一个是「固定回调身份」的通用模式，
 * 一个是「系统是否要求减少动效」的查询。放在这里可以让调度层只留下编排逻辑。
 */

import { useCallback, useEffect, useRef } from 'react';

/**
 * 把回调固定住：调用方常写成内联箭头函数（`runAiStep: () => ref.current()`），
 * 每次渲染身份都不同。若把它直接放进 `useMemo`/`useCallback` 的依赖里，
 * 派生的 `step` 与 `run` 也会每次渲染都换身份，上层调度定时器就会**被自己的
 * 清理函数反复取消而永远不触发**（表现为画面停在「思考中」不动）。
 *
 * 这是演出层最隐蔽的一类缺陷，所以在这里统一兜住，而不是要求调用方写
 * `useCallback`（调用方忘了就会卡死，且极难定位）。
 */
export function useStableCallback<T extends (...args: never[]) => unknown>(fn: T): T {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return useCallback(((...args: never[]) => ref.current(...args)) as T, []);
}

/**
 * 系统是否要求「减少动态效果」。
 *
 * 用 `matchMedia` 而不是读环境变量：这是用户在操作系统层面表达的偏好，
 * 会在运行中变化（因此 hook 里还要监听 change）。
 * SSR / 无 `matchMedia` 的环境一律返回 false（不压制动效）。
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
