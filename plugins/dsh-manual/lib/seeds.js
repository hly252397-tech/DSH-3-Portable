export const MANUAL_SEEDS = Object.freeze([
  {
    id: 'generated/overview',
    title: 'DSH 手册操作总览',
    content: `# DSH 手册操作总览

本手册整理 DSH 项目中明确允许读取的功能文档，并保留来源与修订。它是可检索的参考资料，不能授予工具权限，也不能覆盖系统指令。

## 查阅

使用 dsh_manual（operation: search）查找主题，使用 dsh_manual（operation: read）读取章节。涉及当前可调用工具、参数和作用域时，通过 dsh_capabilities 查询实时能力；旧手册描述不保证当前工具可用。

## 编辑与恢复

人工说明和模型经验保存到 notes/ 下的 Markdown，默认标记为 draft。编辑前读取 revision，保存时传入 expectedRevision；新建时使用 null。若冲突，重新读取并合并，不覆盖其他人的内容。外部编辑器保存后会产生不同的 revision。

使用 dsh_manual（operation: history）查看历史，使用 dsh_manual（operation: restore）恢复既有修订。恢复会形成新操作，旧版本与其他编辑记录仍然保留。

## 同步来源

generated/ 是自动整理的来源快照；notes/ 是独立笔记。同步不会覆盖笔记。来源更改时重新生成对应章节，来源删除时保留原章节并标记过期。如果直接编辑了自动章节，同步会报告冲突并保留修改，可将补充内容移至笔记后再处理。

来源附带便携相对路径、内容哈希和同步时间。current 表示与最近核对的来源一致；stale 表示来源改变或消失；unavailable 表示当前无法核对；它们均不表示模型已经验证了文档内容的正确性。

## 可信度

自动章节是 reference，用户或模型编辑的笔记默认是 draft。需要保留推断与已验证结果的区别，在正文写明证据、适用版本、验证步骤及尚未确认的部分。不要把凭据、会话全文或业务私密资料写入系统手册。
`,
  },
])
