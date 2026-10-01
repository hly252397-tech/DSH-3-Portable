# Qoder MCP 集成指南

## 概述

本项目配置了 MCP (Model Context Protocol) 服务器，让 Qoder 可以指挥 opencode 执行任务。

## 文件结构

```
.opencode/
├── agent/
│   └── qoder.md          # Qoder 专用 Agent 定义
├── mcp/
│   └── qoder-server.mjs  # MCP 服务器实现
opencode.json              # opencode 配置（含 MCP 配置）
```

## MCP 工具列表

| 工具名 | 描述 |
|--------|------|
| `run_task` | 用 `opencode run` 非交互执行任务，返回任务 ID |
| `get_status` | 查询指定任务的状态，并带回最近 200 行实际输出 |
| `list_tasks` | 列出所有任务及其状态 |

说明：`opencode run` 是一次性非交互进程，不支持执行中途追发消息，因此没有 `send_message` 工具。

## Qoder 配置

在 Qoder 中添加 MCP 服务器配置：

```json
{
  "mcpServers": {
    "qoder": {
      "command": "node",
      "args": ["G:/DSH-3-Portable/.opencode/mcp/qoder-server.mjs"]
    }
  }
}
```

不需要设置 `OPENCODE_PATH`。服务器在 Windows 上会自动定位 npm 全局包里的
`opencode-ai/bin/opencode.exe`（npm 生成的 `opencode.cmd` 无法被 Node 直接 spawn）。
其他平台默认调用 PATH 里的 `opencode`；如需覆盖可用 `OPENCODE_PATH` 环境变量指定完整路径。

## 使用示例

### 1. 执行任务

```json
{
  "tool": "run_task",
  "arguments": {
    "task": "检查 src/main.ts 的类型错误",
    "working_dir": "G:/DSH-3-Portable"
  }
}
```

### 2. 查询状态和输出

```json
{
  "tool": "get_status",
  "arguments": {
    "task_id": "task-1"
  }
}
```

## 测试

手动冒烟（向服务器的 stdin 发 JSON-RPC）：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node .opencode/mcp/qoder-server.mjs
```

## 注意事项

1. MCP 服务器通过 stdio 通信，Qoder 需要能启动 `node` 进程
2. 任务异步执行，用 `get_status` 查询进度并读取输出
3. 服务器日志输出到 stderr，不会干扰 JSON-RPC 通信
4. 任务状态只存在内存里，服务器重启后队列清空
