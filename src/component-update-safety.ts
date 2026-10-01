export type UpdateComponent = 'desktop' | 'harness'

/** One in-process mutation lease. Pure checks may run together; preparing shared
 * runtime caches, staging pointers and changing homes may not. */
export class ComponentUpdateSafety {
  private owner: UpdateComponent | undefined

  async run<T>(component: UpdateComponent, operation: () => Promise<T>): Promise<T> {
    if (this.owner !== undefined) throw new Error(`组件更新正在处理 ${this.owner}，本次 ${component} 变更已阻止；请稍后重试。`)
    this.owner = component // Claim synchronously, before the first await.
    try { return await operation() } finally { this.owner = undefined }
  }
}

/** rc.2 has no global reject-before-persist admission barrier for followup,
 * MCP, IM and scheduled producers. Hiding the GUI is not such a barrier.
 * Do not open a copied production home in an automatic rollback window until
 * a real barrier and crash/recovery protocol have been implemented and tested.
 * Policy/compatibility declarations must never act as an unsafe bypass. */
export function harnessActivationSafety(): { readonly allowed: boolean; readonly reason: string } {
  return {
    allowed: false,
    reason: '独立内核候选已可下载和隔离验证；全局任务入站隔离与新家园安全回滚尚未实现，已阻止正式激活。现役服务、家园绑定和运行时指针保持不变。',
  }
}
