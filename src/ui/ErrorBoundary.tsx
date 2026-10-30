/**
 * 全局错误边界（表现层兜底）。
 *
 * 为什么需要它：React 里任何未捕获的渲染期 / effect 异常都会让**整棵组件树卸载**，
 * 用户看到的就是一片白屏 —— 而且因为生产构建会摇掉 dev 断言，这类问题往往只在
 * `vite dev` 下暴露，排查成本极高。本任务修复的「点下一手白屏」就是典型：
 * dev 不变量断言 throw → 没有边界 → 整页空白，连错误信息都留在控制台里。
 *
 * 设计取舍：
 *   - 边界只负责「兜底 + 给出可操作的出口」，不试图自动恢复（React 的错误边界
 *     本身不支持自动重试，强行 reset state 也未必能修复已经损坏的引擎状态）。
 *   - 三个出口覆盖用户的真实诉求：继续玩（重新发牌）、保住数据（导出存档）、
 *     彻底重来（清空存档）。导出放在清空之前，顺序即是「安全优先级」。
 *   - 全部用原生 button，天然支持 Tab / Enter / Space 键盘操作。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

// 兜底界面的样式独立成文件：这个组件要在「全局样式可能没生效」的前提下
// 也能读，所以它不依赖 tokens.css 的变量（详见该 CSS 的头部说明）。
import './styles/errorboundary.css';
import { STORAGE_KEYS } from '../store/schema.js';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** 会被「清空存档」删除的键：只删状态与历史，归档键保留以便事后排查。 */
const CLEARABLE_KEYS = [STORAGE_KEYS.state, STORAGE_KEYS.history] as const;

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 安全地读一份存档快照；localStorage 不可用（隐私模式等）时返回错误说明而不是再抛。 */
function readStorageSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  try {
    for (const key of CLEARABLE_KEYS) {
      const raw = window.localStorage.getItem(key);
      if (raw === null) {
        snapshot[key] = null;
        continue;
      }
      try {
        snapshot[key] = JSON.parse(raw);
      } catch {
        // 损坏的存档也要原样导出，便于用户/开发者分析
        snapshot[key] = raw;
      }
    }
  } catch (err) {
    snapshot.__readError = toMessage(err);
  }
  return snapshot;
}

/** 导出存档为 JSON 文件（触发浏览器下载）。 */
function exportBackup(): void {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'poker-trainer',
    data: readStorageSnapshot(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `poker-trainer-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 稍后再释放，避免部分浏览器还没开始下载就失效
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 清空状态与历史（保留归档键），然后重新加载。 */
function clearStorageAndReload(): void {
  try {
    for (const key of CLEARABLE_KEYS) window.localStorage.removeItem(key);
  } catch {
    // 清不掉也必须能重新加载，否则用户会被卡死在错误页
  }
  window.location.reload();
}

/**
 * 错误边界组件。
 *
 * 用法：在入口处包住整棵树 ——
 * ```tsx
 * createRoot(el).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 控制台保留完整堆栈（含组件栈），方便开发者定位；生产环境也保留，便于用户反馈。
    console.error('[ui] 未捕获的渲染异常，已由 ErrorBoundary 兜底：', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleExport = (): void => {
    try {
      exportBackup();
    } catch (err) {
      // 导出失败不能影响页面可用性
      console.error('[ui] 导出存档失败：', err);
    }
  };

  private handleClear = (): void => {
    clearStorageAndReload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stack = error.stack ?? '';
    return (
      <div role="alert" aria-live="assertive" className="eb-root">
        <div className="eb-card">
          <h2 className="eb-title">页面遇到异常，但没有白屏</h2>
          <p className="eb-lede">
            界面渲染时发生了未捕获的错误。你的对局进度已保存在本机，可以先导出存档备份，
            再选择重新发牌继续练习。
          </p>

          <pre className="eb-error">
            {error.message}
          </pre>

          {stack ? (
            <details className="eb-details">
              <summary className="eb-summary">查看错误堆栈（便于反馈问题）</summary>
              <pre className="eb-stack">
                {stack}
              </pre>
            </details>
          ) : null}

          <div className="eb-actions">
            <button type="button" className="primary" onClick={this.handleReload}>
              重新发牌
            </button>
            <button type="button" className="ghost" onClick={this.handleExport}>
              导出存档
            </button>
            <button type="button" className="danger" onClick={this.handleClear}>
              清空存档
            </button>
          </div>

          <p className="eb-foot">
            「导出存档」会把本机的对局状态与历史记录下载为 JSON；「清空存档」会删除这两项后
            重新加载（归档数据保留）。也可以直接按 F5 / Ctrl+R 刷新重试。
          </p>
        </div>
      </div>
    );
  }
}
