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
      <div
        role="alert"
        aria-live="assertive"
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          background: '#0f172a',
          color: '#e5e7eb',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        }}
      >
        <div
          style={{
            maxWidth: '720px',
            width: '100%',
            background: '#111827',
            border: '1px solid #334155',
            borderRadius: '12px',
            padding: '24px',
            boxShadow: '0 10px 40px rgba(0, 0, 0, 0.45)',
          }}
        >
          <h2 style={{ margin: '0 0 8px', fontSize: '20px' }}>页面遇到异常，但没有白屏</h2>
          <p style={{ margin: '0 0 12px', color: '#94a3b8', lineHeight: 1.6 }}>
            界面渲染时发生了未捕获的错误。你的对局进度已保存在本机，可以先导出存档备份，
            再选择重新发牌继续练习。
          </p>

          <pre
            style={{
              margin: '0 0 16px',
              padding: '12px',
              maxHeight: '180px',
              overflow: 'auto',
              background: '#0b1220',
              border: '1px solid #1e293b',
              borderRadius: '8px',
              color: '#fca5a5',
              fontSize: '13px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {error.message}
          </pre>

          {stack ? (
            <details style={{ margin: '0 0 16px', color: '#94a3b8', fontSize: '12px' }}>
              <summary style={{ cursor: 'pointer' }}>查看错误堆栈（便于反馈问题）</summary>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: '8px' }}>
                {stack}
              </pre>
            </details>
          ) : null}

          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
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

          <p style={{ margin: '14px 0 0', color: '#64748b', fontSize: '12px', lineHeight: 1.6 }}>
            「导出存档」会把本机的对局状态与历史记录下载为 JSON；「清空存档」会删除这两项后
            重新加载（归档数据保留）。也可以直接按 F5 / Ctrl+R 刷新重试。
          </p>
        </div>
      </div>
    );
  }
}
