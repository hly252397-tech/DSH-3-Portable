# DSH 手册

独立插件；入口为 DSH 设置 → DSH 手册。不改变侧栏、浏览器或全局主题。

模型使用 `dsh_manual` 按需 list/search/read；不知道工具是否可用时，先查 `dsh_capabilities`。模型调用方式以本次请求的 native / run_code 说明为准。

数据默认在实际 DSH home 的 `manual` 目录（旧家园 `Data/DSH/manual`，generation 家园 `Data/DSH-generations/<generation>/home/manual`）：限定项目资料是 generated 只读副本；人和模型写入 notes Markdown 草稿。不会新建第二份 home，也不会因来源位置变动迁走笔记。同步不会覆盖笔记。编辑/恢复必须带读取时的 expectedRevision（新建为 null），冲突保留草稿并提示重新合并；历史可恢复。不要编辑截断的内容后覆盖全文。

模型与用户的笔记都默认待验证，手册不改变权限、不覆盖系统指令。它不包含凭据、会话全文或业务工作区。固定公开来源包含《构建更新与定制防回退规则》，插件资料只枚举实际活动 Profile 的 `local` 下 README/package 元数据，不扫描旧家园或整个 Data。所有读取都有路径、数量和字节上限；链接/越界拒绝，package 仅投影名称、版本、描述并脱敏。每 60 秒增量检查，也可手动同步。

配置：sourceRoot 默认 `auto`，仅使用明确且已验证的 `DSH_PORTABLE_ROOT`，并检查实际 home/Profile 配对。缺少该环境或上下文不匹配时显示来源错误/部分同步；笔记仍可读写，不从 cwd 猜仓库。显式 sourceRoot 仍按 Profile 相对路径或绝对路径解析，`../../../../` 不会偷偷转为 auto；便携环境中越界/链接来源拒绝。只有随包默认 patch 改为 auto，Profile/home 的显式用户覆盖保持原样。manualDirectory 相对实际 DSH home；allowModelEdits 可禁止模型编辑；syncIntervalSeconds 控制刷新频率。Web API 使用现有连接认证、同源检查和专用请求头，不另起无认证服务。

生成章保留旧 `Data/DSH/profiles/web/local/<包>/<文件>` 的稳定 ID：切换 generation 后只更新来源定位和必要内容，旧历史仍可读；相同内容但物理来源变化也记录迁移。外部编辑过的 generated 保持冲突，不自动覆盖；移除的来源保留原章节并标为不可用/陈旧，不删除，也不把它报成当前资料。现有 notes（包括规则笔记）与其修订号不变。

源码由本仓库 plugins 维护，安装由 scripts/install-dsh-awareness-manual.mjs 执行；默认选择便携指针绑定的实际活动 Profile。同一仓库发现未提交内核事务（pendingTransactionId）时，活动 Profile 解析、安装及 dry-run 一律拒绝，不猜测 current/previous；异常空值也失败关闭。必须先由正常启动恢复或健康提交该事务。显式 `--profile` 保持选址原义但不能绕过事务守卫，`--source` 指插件包源码目录而非手册文档根。不运行 pnpm install。安装不等于运行时已激活，卸载/回退必须保留手册数据。来源或默认 patch 变更须先隔离验收，再审阅保护登记及归属后同步，不能直接改活动文件/哈希放行。
