# Agent 原理知识库

> 本文档是 MiniCode TypeScript 重实现过程中积累的知识点详细说明。
> 代码中用 `// [K-XX]` 标注知识点编号，在此对应展开。

---

## 使用方法

- 看代码时遇到 `// [K-XX]`，来这里查阅对应知识点的详细解释
- 知识点按实现阶段分层，可按需跳转

---

## 第一层：类型系统基础

### [K-01] 可辨识联合类型（Discriminated Union）

**文件**：`src/types.ts`

TypeScript 通过字面量类型作为辨别字段（discriminant），在 if/switch 分支里自动收窄类型，无需手写类型断言。

```typescript
type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant_tool_call'; toolUseId: string; toolName: string; input: unknown }

function handle(msg: ChatMessage) {
  if (msg.role === 'user') {
    console.log(msg.content) // 这里 msg 被自动收窄，只有 content 字段
  }
}
```

**为什么用它**：一个类型涵盖所有消息形态；编译器穷举检查；避免运行时 `instanceof`。

---

### [K-02] Zod 运行时校验

**文件**：`src/tool.ts` → `ToolRegistry.execute()`

TypeScript 类型只在编译期存在，LLM 返回的 JSON 是 `unknown`。Zod 的 `.safeParse()` 在运行时桥接两者：

```typescript
const parsed = tool.schema.safeParse(input) // 不抛异常
if (!parsed.success) {
  return { ok: false, output: parsed.error.message }
}
// parsed.data 类型已被收窄为 TInput
await tool.run(parsed.data, context)
```

**关键 API**：`.safeParse()` 返回 `{ success, data | error }`；`z.infer<typeof schema>` 从 schema 推断 TS 类型（DRY）。

---

### [K-03] 注册表模式（Registry Pattern）

**文件**：`src/tool.ts` → `ToolRegistry`

集中管理工具的注册、查找和执行。Agent Loop 只通过 ToolRegistry 与工具交互。

```
Agent Loop
  → registry.execute(name, input, ctx)
    → find(name)         # 查找
    → schema.safeParse() # 验证 [K-02]
    → tool.run()         # 执行
```

**SOLID 对应**：S（单一职责）、O（开放/封闭：addTools 无需改 Loop）、D（Loop 依赖 Registry 抽象）。

---

### [K-04] 配置分层加载

**文件**：`src/config.ts`

Phase 2 仅从环境变量加载，Phase 5 会扩展为 `settings.json` → `.claude/settings.json` → 环境变量 三层合并：

```typescript
const apiKey = (process.env['ANTHROPIC_API_KEY'] ?? '').trim() || undefined
```

**设计原则**：`async` 函数而非模块顶层执行，方便测试注入和动态刷新。

---

### [K-05] ToolContext 依赖注入

**文件**：`src/tool.ts`

```typescript
type ToolContext = { cwd: string }
```

通过参数传入运行时环境而非全局变量，测试时可注入任意 `cwd`，无副作用。

---

## 第二层：模型接入

### [K-06] Anthropic Messages API 格式转换

**文件**：`src/anthropic-adapter.ts` → `toAnthropicMessages()`

内部 `ChatMessage[]` 与 Anthropic API 格式的关键差异：

| 内部格式 | Anthropic API |
|---------|--------------|
| `system` | 独立 `system` 字段，不进 messages |
| `user` | `{ role: 'user', content: [{ type: 'text', text }] }` |
| `assistant_tool_call` | `{ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }` |
| `tool_result` | `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }` |
| `assistant_progress` | `{ type: 'text', text: '<progress>...</progress>' }` |

**关键约束**：相邻同角色消息必须合并为一条（`pushBlock` 函数处理）。

---

### [K-07] 指数退避 + Jitter 重试策略

**文件**：`src/anthropic-adapter.ts` → `getRetryDelayMs()`

触发条件：HTTP 429（限流）或 5xx（服务端错误）。

```
delay = min(500 × 2^(attempt-1), 8000) × (1 + random × 0.25)
```

- **指数退避**：每次重试间隔翻倍，避免持续冲击限流 API
- **Jitter（抖动）**：加入随机因子，防止多客户端同时重试的"惊群效应"
- **Retry-After 优先**：服务端返回等待时间时直接使用

---

### [K-08] Tool Use 响应块解析

**文件**：`src/anthropic-adapter.ts` → `AnthropicModelAdapter.next()`

Anthropic API 响应的 `content` 是混合块数组，按 `type` 分拣：

```typescript
for (const block of data.content ?? []) {
  if (block.type === 'text')      textParts.push(block.text)
  else if (block.type === 'tool_use')  toolCalls.push(...)
  else if (block.type === 'thinking') thinkingBlocks.push(block)
  else ignoredBlockTypes.add(block.type) // 容错未来新块类型
}
```

**决策**：`toolCalls.length > 0` → `tool_calls`；否则 → `assistant`。

---

### [K-09] 适配器模式（Adapter Pattern）

**文件**：`src/anthropic-adapter.ts`、`src/mock-model.ts`

`ModelAdapter` 接口将 Agent Loop 与具体 LLM 提供商解耦：

```typescript
interface ModelAdapter {
  next(messages: ChatMessage[]): Promise<AgentStep>
}
```

- `AnthropicModelAdapter` → 真实 API 调用
- `MockModelAdapter` → slash 命令解析，无网络，测试专用

**依赖倒置（DIP）**：Agent Loop 只依赖 `ModelAdapter` 接口，不关心底层实现。

---

## 第三层：Agent 核心

### [K-10] ReAct 框架

**文件**：`src/agent-loop.ts` → `runAgentTurn()`

ReAct = **Re**ason（推理）+ **Act**（执行）的交替循环。

```
┌──────────────────────────────────────────────┐
│  for step in maxSteps:                       │
│    next = model.next(messages)               │
│    ┌── 'assistant' ──► 退出循环（或重试）    │
│    └── 'tool_calls' ──► 执行工具 ──► 继续   │
└──────────────────────────────────────────────┘
```

每一轮都向 `messages` 追加新消息，消息历史是模型"记忆"的唯一载体。
`maxSteps` 是安全阀，防止模型进入无限工具调用循环。

---

### [K-11] 工具执行与错误收集

**文件**：`src/agent-loop.ts` → `tool_calls` 分支

**三个设计决策：**

1. **顺序执行（非并行）**：工具 B 的输入可能依赖工具 A 的输出，串行更安全。
2. **失败不中断**：一个工具失败后继续执行剩余工具，错误作为 `isError=true` 的 `tool_result` 反馈给模型，让模型自行决策是重试还是换策略。
3. **awaitUser 信号例外**：收到此信号后立即 `break`，不再执行后续工具，因为需要等待用户输入后才能继续。

```typescript
for (const call of next.calls) {
  const result = await tools.execute(call.toolName, call.input, { cwd })
  toolCallMessages.push({ role: 'assistant_tool_call', ... })
  toolResultMessages.push({ role: 'tool_result', isError: !result.ok, ... })
  if (result.awaitUser) break  // [K-26] 暂停等待用户
}
messages = [...messages, ...toolCallMessages, ...toolResultMessages]
```

---

### [K-12] 韧性设计模式（Resilience Patterns）

**文件**：`src/agent-loop.ts`

三类异常情况及恢复策略：

| 异常 | 触发条件 | 恢复策略 |
|------|---------|---------|
| 空响应 | `content.trim() === ''` | 注入 continuation prompt，最多重试 2 次；耗尽后降级输出提示消息 |
| Thinking 阶段中断 | `stopReason=pause_turn/max_tokens` 且有 thinking block | 注入 continuation prompt，最多重试 3 次 |
| maxSteps 超限 | `step >= maxSteps` | 退出循环，输出"达到最大步数"提示消息 |

**为什么空响应要重试而不立即报错？**
LLM 在复杂上下文下偶尔会产生空输出（特别是 Extended Thinking 场景），通常一次 continuation prompt 就能恢复。重试成本低，直接报错会中断本可以完成的任务。

---

### [K-13] Continuation Prompt 工程

**文件**：`src/agent-loop.ts` → `pushContinuationPrompt()`

Agent Loop 在三种情况下注入 continuation prompt（作为 `user` 角色消息追加到历史）：

1. **空响应**：`'Your last response was empty. Continue immediately...'`
2. **Progress 消息**：`'Continue immediately from your <progress> update...'`
3. **Thinking 中断**：`'Your previous response hit max_tokens during thinking. Resume immediately...'`

设计要点：
- 必须是 `user` 角色（模型视角：用户催促继续），而非 `assistant`
- 措辞要求"立即"行动（immediately），防止模型再次产生纯文字分析
- 根据上下文（是否有工具结果、错误）选择不同措辞，帮助模型理解当前状态

---

### [K-14] Extended Thinking 跨轮次状态管理

**文件**：`src/agent-loop.ts` → `appendThinkingBlocks()`

Extended Thinking 的关键约束：

> Anthropic API 要求：如果上一轮响应包含 `thinking` 块，下一轮请求的 messages 中必须包含对应的 `assistant_thinking` 消息，否则 API 会报错（thinking block 缺失）。

**实现**：每次模型返回（无论是 `assistant` 还是 `tool_calls`），都先检查 `thinkingBlocks` 字段，非空时立即追加 `assistant_thinking` 消息到 `messages`，然后再处理其他逻辑。

```typescript
// 保留 thinking blocks 的位置：先于一切其他消息追加
messages = appendThinkingBlocks(messages, next.thinkingBlocks)
```

---

### [K-15] System Prompt 工程

**文件**：`src/prompt.ts` → `buildSystemPrompt()`

System Prompt 是模型行为的"宪法"，需要覆盖：

| 内容 | 作用 |
|------|------|
| 角色定义 | 告诉模型它是谁（mini-code，终端编程助手）|
| 工作目录 `cwd` | 让模型知道工具操作的默认路径 |
| 行为偏好 | 优先动手而非给建议；不做未被要求的主观选择 |
| 结构化响应协议 | 约定 `<progress>`/`<final>` 标签，Agent Loop 据此判断是否退出 |

Phase 5 会在此基础上扩展：注入权限摘要、skills 列表、MCP 服务器信息、MEMORY 文件内容（K-40）。

---

## 第四层：工具与权限

### [K-16] Node.js fs/promises

> 待实现 Phase 4 时填写

### [K-17] 原子写入（Atomic Write）

> 待实现 Phase 4 时填写

### [K-18] 字符串精确替换策略

> 待实现 Phase 4 时填写

### [K-19] Unified Diff 格式解析与应用

> 待实现 Phase 4 时填写

### [K-20] 多块编辑合并策略

> 待实现 Phase 4 时填写

### [K-21] 递归目录遍历 + gitignore 过滤

> 待实现 Phase 4 时填写

### [K-22] 正则搜索 + 结果截断

> 待实现 Phase 4 时填写

### [K-23] child_process spawn + 超时控制

> 待实现 Phase 4 时填写

### [K-24] fetch + HTML → 纯文本提取

> 待实现 Phase 4 时填写

### [K-25] 搜索 API 封装

> 待实现 Phase 4 时填写

### [K-26] awaitUser 信号机制

> 待实现 Phase 4 时填写

### [K-27] 动态指令注入（Skill 加载）

> 待实现 Phase 4 时填写

### [K-28] 工具注册表组装

> 待实现 Phase 4 时填写

### [K-29] 多维度权限模型

> 待实现 Phase 4 时填写

### [K-30] diff 库可视化 diff

> 待实现 Phase 4 时填写

### [K-31] 后台进程生命周期管理

> 待实现 Phase 4 时填写

---

## 第五层：上下文管理

### [K-32] Token 计数与上下文窗口管理

> 待实现 Phase 5 时填写

### [K-33] 超大输出落盘替换策略

> 待实现 Phase 5 时填写

### [K-34] 四种压缩策略定位

> 待实现 Phase 5 时填写

### [K-35] 安全中段历史移除（Snip Compact）

> 待实现 Phase 5 时填写

### [K-36] LLM 驱动片段摘要（Context Collapse）

> 待实现 Phase 5 时填写

### [K-37] 临界压缩触发策略（Auto Compact）

> 待实现 Phase 5 时填写

### [K-38] 用户主动触发压缩（Manual Compact）

> 待实现 Phase 5 时填写

### [K-39] JSONL 追加写入 + parentUuid 树结构

> 待实现 Phase 5 时填写

### [K-40] 分层指令文件加载（Memory）

> 待实现 Phase 5 时填写

### [K-41] stdio MCP 协议（JSON-RPC + 动态工具注册）

> 待实现 Phase 5 时填写

### [K-42] 本地 Skill 文件发现与加载

> 待实现 Phase 5 时填写

---

## 第六层：终端界面

### [K-43] 终端 UI 状态模型

> 待实现 Phase 6 时填写

### [K-44] ANSI 转义码 + 双缓冲渲染

> 待实现 Phase 6 时填写

### [K-45] 终端 Markdown 渲染

> 待实现 Phase 6 时填写

### [K-46] 虚拟滚动 + CJK 字符宽度计算

> 待实现 Phase 6 时填写

### [K-47] 终端原始字节序列解析

> 待实现 Phase 6 时填写

### [K-48] 光标移动 + 行编辑状态机

> 待实现 Phase 6 时填写

### [K-49] 状态栏 Badge 渲染

> 待实现 Phase 6 时填写

### [K-50] 事件驱动渲染（组件组合）

> 待实现 Phase 6 时填写

### [K-51] raw mode + resize 事件（SIGWINCH）

> 待实现 Phase 6 时填写

### [K-52] 非交互模式降级

> 待实现 Phase 6 时填写
