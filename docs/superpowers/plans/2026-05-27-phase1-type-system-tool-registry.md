# Phase 1: 类型系统 + 工具注册表 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建项目骨架——核心类型定义、工具注册表、运行时配置加载，无任何 I/O，纯逻辑可单测。

**Architecture:** `types.ts` 用可辨识联合定义所有消息类型；`tool.ts` 实现 `ToolRegistry`（注册、查找、执行工具，Zod 校验输入）；`config.ts` 从环境变量 + `~/.config/my-agent/config.json` 加载运行时配置；`workspace.ts` 封装工作目录路径操作。

**Tech Stack:** TypeScript 5.x、Node.js 22+（内置 `node:test`）、zod v4、tsx（开发时直接运行 TS）

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `package.json` | 项目配置、依赖声明、npm scripts |
| `tsconfig.json` | TypeScript 编译配置 |
| `src/types.ts` | 所有核心类型（`ChatMessage`、`AgentStep`、`ModelAdapter` 等） |
| `src/tool.ts` | `ToolRegistry` 类、`ToolDefinition` 类型、`ToolResult` 类型 |
| `src/config.ts` | `RuntimeConfig` 类型、`loadRuntimeConfig()` 函数 |
| `src/workspace.ts` | `resolveWorkspacePath()`、`isWithinDirectory()` 工具函数 |
| `test/types.test.ts` | `ChatMessage` 类型守卫测试 |
| `test/tool.test.ts` | `ToolRegistry` 单元测试 |
| `test/config.test.ts` | `loadRuntimeConfig` 单元测试 |
| `test/workspace.test.ts` | 路径工具函数测试 |

---

## Task 1: 项目初始化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "my-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "tsx --test 'test/**/*.test.ts'",
    "check": "tsc --noEmit",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "diff": "^8.0.4",
    "zod": "^4.1.5"
  },
  "devDependencies": {
    "@types/diff": "^7.0.2",
    "@types/node": "^22.0.0",
    "tsx": "^4.20.6",
    "typescript": "^5.9.2"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: 安装依赖**

```bash
cd /Users/maolu/Desktop/AI/haha/my-agent
npm install
```

期望输出：`added XX packages` 无报错。

- [ ] **Step 4: 创建测试目录**

```bash
mkdir -p test src
```

- [ ] **Step 5: 提交**

```bash
git add package.json tsconfig.json package-lock.json
git commit -m "chore: 初始化项目，添加 package.json 和 tsconfig.json"
```

---

## Task 2: 核心类型定义（`src/types.ts`）

> 知识点 `[K-01]`：可辨识联合类型（Discriminated Union）
> `ChatMessage` 用 `role` 字段作判别符，TypeScript 在 if/switch 分支中自动收窄类型，
> 消除大量 `as` 类型断言。

**Files:**
- Create: `src/types.ts`
- Create: `test/types.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/types.test.ts`：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, AgentStep } from '../src/types.js'

test('ChatMessage: user 消息只有 content 字段', () => {
  const msg: ChatMessage = { role: 'user', content: 'hello' }
  assert.equal(msg.role, 'user')
  assert.equal(msg.content, 'hello')
})

test('ChatMessage: tool_result 消息有 toolUseId、content、isError', () => {
  const msg: ChatMessage = {
    role: 'tool_result',
    toolUseId: 'id-123',
    toolName: 'read_file',
    content: 'file content',
    isError: false,
  }
  assert.equal(msg.role, 'tool_result')
  assert.equal(msg.isError, false)
})

test('ChatMessage: assistant_tool_call 消息有 toolUseId、toolName、input', () => {
  const msg: ChatMessage = {
    role: 'assistant_tool_call',
    toolUseId: 'id-456',
    toolName: 'write_file',
    input: { path: 'foo.ts', content: 'bar' },
  }
  assert.equal(msg.toolName, 'write_file')
})

test('AgentStep: assistant 类型有 content', () => {
  const step: AgentStep = { type: 'assistant', content: 'done' }
  assert.equal(step.type, 'assistant')
})

test('AgentStep: tool_calls 类型有 calls 数组', () => {
  const step: AgentStep = {
    type: 'tool_calls',
    calls: [{ id: '1', toolName: 'read_file', input: { path: 'x.ts' } }],
  }
  assert.equal(step.calls.length, 1)
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
tsx --test test/types.test.ts 2>&1 | head -5
```

期望输出包含：`Cannot find module '../src/types.js'`

- [ ] **Step 3: 实现 `src/types.ts`**

```typescript
// [K-01] 可辨识联合类型（Discriminated Union）
// role 字段是"判别符"——TypeScript 在 if(msg.role === 'tool_result') 后
// 自动知道 msg.toolUseId 一定存在，无需类型断言。

export type ProviderUsage = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  source: string
}

export type ProviderUsageMetadata = {
  providerUsage?: ProviderUsage
  usageStale?: boolean
  usageStaleReason?: string
}

export type ProviderThinkingBlock = {
  type: 'thinking' | 'redacted_thinking'
  [key: string]: unknown
}

export type MessageIdentity = {
  id?: string
}

// ChatMessage：系统内所有消息的统一类型
// 每种 role 对应不同的字段集合，role 是可辨识联合的判别符
export type ChatMessage =
  | ({ role: 'system'; content: string } & MessageIdentity)
  | ({ role: 'user'; content: string } & MessageIdentity)
  | ({ role: 'assistant_thinking'; blocks: ProviderThinkingBlock[] } & MessageIdentity)
  | ({ role: 'assistant'; content: string } & ProviderUsageMetadata & MessageIdentity)
  | ({ role: 'assistant_progress'; content: string } & ProviderUsageMetadata & MessageIdentity)
  | ({
      role: 'assistant_tool_call'
      toolUseId: string
      toolName: string
      input: unknown
    } & ProviderUsageMetadata & MessageIdentity)
  | ({
      role: 'tool_result'
      toolUseId: string
      toolName: string
      content: string
      isError: boolean
    } & MessageIdentity)
  | ({
      role: 'context_summary'
      content: string
      compressedCount: number
      timestamp: number
    } & MessageIdentity)
  | ({
      role: 'snip_boundary'
      content: string
      removedMessageIds: string[]
      removedCount: number
      tokensFreed: number
      timestamp: number
    } & MessageIdentity)

export type ToolCall = {
  id: string
  toolName: string
  input: unknown
}

export type StepDiagnostics = {
  stopReason?: string
  blockTypes?: string[]
  ignoredBlockTypes?: string[]
}

// AgentStep：模型单次调用的返回结果
// type 是判别符：'assistant'（纯文本回复）或 'tool_calls'（需要执行工具）
export type AgentStep =
  | {
      type: 'assistant'
      content: string
      kind?: 'final' | 'progress'
      thinkingBlocks?: ProviderThinkingBlock[]
      diagnostics?: StepDiagnostics
      usage?: ProviderUsage
    }
  | {
      type: 'tool_calls'
      calls: ToolCall[]
      content?: string
      contentKind?: 'progress'
      thinkingBlocks?: ProviderThinkingBlock[]
      diagnostics?: StepDiagnostics
      usage?: ProviderUsage
    }

// ModelAdapter：模型适配器接口
// [K-09] 适配器模式：Agent Loop 只依赖这个接口，
// 不感知底层是 Anthropic、OpenAI 还是 Mock。
export interface ModelAdapter {
  next(messages: ChatMessage[]): Promise<AgentStep>
}

export type CompressionResult = {
  messages: ChatMessage[]
  summary: Extract<ChatMessage, { role: 'context_summary' }>
  removedCount: number
  tokensBefore: number
  tokensAfter: number
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
tsx --test test/types.test.ts
```

期望输出：所有测试 `✓ passed`，0 failed。

- [ ] **Step 5: 提交**

```bash
git add src/types.ts test/types.test.ts
git commit -m "feat(phase1): 实现核心类型定义 [K-01]"
```

---

## Task 3: 工具注册表（`src/tool.ts`）

> 知识点 `[K-02]`：Zod 运行时校验——LLM 返回的工具参数是 `unknown`，
> `.safeParse()` 在运行时验证结构，不抛异常，返回 `{ success, data }` 或 `{ success, error }`。
>
> 知识点 `[K-03]`：注册表模式——集中管理 `ToolDefinition` 实例，支持按名字查找和执行，
> 是整个工具系统的唯一入口。

**Files:**
- Create: `src/tool.ts`
- Create: `test/tool.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/tool.test.ts`：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { ToolRegistry } from '../src/tool.js'
import type { ToolDefinition, ToolContext } from '../src/tool.js'

// 辅助：创建一个简单的测试用工具
function makeEchoTool(): ToolDefinition<{ message: string }> {
  return {
    name: 'echo',
    description: '回显消息',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    schema: z.object({ message: z.string() }),
    async run(input, _ctx) {
      return { ok: true, output: input.message }
    },
  }
}

const ctx: ToolContext = { cwd: '/tmp' }

test('ToolRegistry: list() 返回所有已注册工具', () => {
  const registry = new ToolRegistry([makeEchoTool()])
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0]!.name, 'echo')
})

test('ToolRegistry: find() 按名字查找工具', () => {
  const registry = new ToolRegistry([makeEchoTool()])
  assert.ok(registry.find('echo'))
  assert.equal(registry.find('nonexistent'), undefined)
})

test('ToolRegistry: execute() 成功调用工具并返回结果', async () => {
  const registry = new ToolRegistry([makeEchoTool()])
  const result = await registry.execute('echo', { message: 'hello' }, ctx)
  assert.equal(result.ok, true)
  assert.equal(result.output, 'hello')
})

test('ToolRegistry: execute() 未知工具名返回 ok=false', async () => {
  const registry = new ToolRegistry([makeEchoTool()])
  const result = await registry.execute('unknown_tool', {}, ctx)
  assert.equal(result.ok, false)
  assert.match(result.output, /Unknown tool/)
})

test('ToolRegistry: execute() Zod 校验失败返回 ok=false，不抛异常', async () => {
  const registry = new ToolRegistry([makeEchoTool()])
  // 传入空对象，缺少必填字段 message
  const result = await registry.execute('echo', {}, ctx)
  assert.equal(result.ok, false)
  // 输出包含 zod 错误信息
  assert.ok(result.output.length > 0)
})

test('ToolRegistry: execute() 工具运行时抛异常，返回 ok=false', async () => {
  const errorTool: ToolDefinition<{ x: number }> = {
    name: 'broken',
    description: '总是抛异常',
    inputSchema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    schema: z.object({ x: z.number() }),
    async run() {
      throw new Error('something went wrong')
    },
  }
  const registry = new ToolRegistry([errorTool])
  const result = await registry.execute('broken', { x: 1 }, ctx)
  assert.equal(result.ok, false)
  assert.match(result.output, /something went wrong/)
})

test('ToolRegistry: addTools() 跳过重名工具', () => {
  const registry = new ToolRegistry([makeEchoTool()])
  const duplicate = { ...makeEchoTool(), description: 'duplicate' }
  registry.addTools([duplicate])
  assert.equal(registry.list().length, 1)
  assert.equal(registry.list()[0]!.description, '回显消息') // 原始描述不变
})

test('ToolRegistry: dispose() 调用所有 disposer', async () => {
  let disposed = false
  const registry = new ToolRegistry([], {}, async () => { disposed = true })
  await registry.dispose()
  assert.equal(disposed, true)
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
tsx --test test/tool.test.ts 2>&1 | head -5
```

期望输出：`Cannot find module '../src/tool.js'`

- [ ] **Step 3: 实现 `src/tool.ts`**

```typescript
import { z } from 'zod'

// ToolContext：工具执行时的运行时环境（当前工作目录 + 权限管理器）
// Phase 4 实现 PermissionManager 后，将 permissions 类型替换为具体类型
export type ToolContext = {
  cwd: string
  permissions?: unknown  // 临时占位，Phase 4 替换为 PermissionManager
}

export type BackgroundTaskResult = {
  taskId: string
  type: 'local_bash'
  command: string
  pid: number
  status: 'running' | 'completed' | 'failed'
  startedAt: number
}

// ToolResult：工具执行结果
// ok=false 时 output 是错误信息，模型会把它当作工具失败反馈
export type ToolResult = {
  ok: boolean
  output: string
  backgroundTask?: BackgroundTaskResult
  // [K-26] awaitUser=true 时 Agent Loop 暂停等待用户输入
  awaitUser?: boolean
}

// ToolDefinition：描述一个工具的完整信息
// inputSchema 给 Anthropic API（JSON Schema 格式）
// schema 给本地 Zod 运行时校验
export type ToolDefinition<TInput> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schema: z.ZodType<TInput>
  run(input: TInput, context: ToolContext): Promise<ToolResult>
}

type ToolRegistryMetadata = {
  skills?: unknown[]
  mcpServers?: unknown[]
}

// [K-03] 注册表模式（Registry Pattern）
// 集中管理所有 ToolDefinition，是工具系统的唯一入口。
// 优点：Agent Loop 不需要知道工具的具体实现，只通过名字执行。
export class ToolRegistry {
  private readonly toolsStore: ToolDefinition<unknown>[]
  private metadataStore: ToolRegistryMetadata
  private readonly disposers: Array<() => Promise<void>> = []

  constructor(
    tools: ToolDefinition<unknown>[],
    metadata: ToolRegistryMetadata = {},
    disposer?: () => Promise<void>,
  ) {
    this.toolsStore = [...tools]
    this.metadataStore = metadata
    if (disposer) {
      this.disposers.push(disposer)
    }
  }

  list(): ToolDefinition<unknown>[] {
    return this.toolsStore
  }

  getSkills(): unknown[] {
    return this.metadataStore.skills ?? []
  }

  getMcpServers(): unknown[] {
    return this.metadataStore.mcpServers ?? []
  }

  setMcpServers(servers: unknown[]): void {
    this.metadataStore = { ...this.metadataStore, mcpServers: [...servers] }
  }

  // addTools：批量追加工具，重名的跳过（不覆盖已注册工具）
  addTools(nextTools: ToolDefinition<unknown>[]): void {
    const existingNames = new Set(this.toolsStore.map(t => t.name))
    for (const tool of nextTools) {
      if (existingNames.has(tool.name)) continue
      this.toolsStore.push(tool)
      existingNames.add(tool.name)
    }
  }

  addDisposer(disposer: () => Promise<void>): void {
    this.disposers.push(disposer)
  }

  find(name: string): ToolDefinition<unknown> | undefined {
    return this.toolsStore.find(t => t.name === name)
  }

  // execute：按名字执行工具
  // 依次经过：工具查找 → Zod 校验 → 执行 → 捕获异常
  // 任何环节失败都返回 ok=false，不向上抛异常
  async execute(
    toolName: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.find(toolName)
    if (!tool) {
      return { ok: false, output: `Unknown tool: ${toolName}` }
    }

    // [K-02] Zod 运行时校验
    // safeParse 不抛异常，失败时返回 { success: false, error }
    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, output: parsed.error.message }
    }

    try {
      return await tool.run(parsed.data, context)
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(this.disposers.map(d => d()))
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
tsx --test test/tool.test.ts
```

期望输出：8 个测试全部 `✓ passed`，0 failed。

- [ ] **Step 5: 提交**

```bash
git add src/tool.ts test/tool.test.ts
git commit -m "feat(phase1): 实现 ToolRegistry，Zod 校验 + 注册表模式 [K-02] [K-03]"
```

---

## Task 4: 运行时配置加载（`src/config.ts`）

> 知识点 `[K-04]`：配置分层加载——优先级：环境变量 > 配置文件 > 默认值。
> 这样可以在不修改代码的情况下，通过环境变量覆盖任何配置项。

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/config.test.ts`：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadRuntimeConfig } from '../src/config.js'
import type { RuntimeConfig } from '../src/config.js'

test('loadRuntimeConfig: 从环境变量读取 API key', async () => {
  process.env['ANTHROPIC_API_KEY'] = 'test-key-123'
  const config = await loadRuntimeConfig()
  assert.equal(config.apiKey, 'test-key-123')
  delete process.env['ANTHROPIC_API_KEY']
})

test('loadRuntimeConfig: 从环境变量读取 model', async () => {
  process.env['ANTHROPIC_MODEL'] = 'claude-opus-4-5'
  const config = await loadRuntimeConfig()
  assert.equal(config.model, 'claude-opus-4-5')
  delete process.env['ANTHROPIC_MODEL']
})

test('loadRuntimeConfig: model 默认值是 claude-opus-4-7', async () => {
  delete process.env['ANTHROPIC_MODEL']
  const config = await loadRuntimeConfig()
  assert.equal(config.model, 'claude-opus-4-7')
})

test('loadRuntimeConfig: 从环境变量读取 baseUrl', async () => {
  process.env['ANTHROPIC_BASE_URL'] = 'https://custom.api.com'
  const config = await loadRuntimeConfig()
  assert.equal(config.baseUrl, 'https://custom.api.com')
  delete process.env['ANTHROPIC_BASE_URL']
})

test('loadRuntimeConfig: baseUrl 默认值是 Anthropic 官方地址', async () => {
  delete process.env['ANTHROPIC_BASE_URL']
  const config = await loadRuntimeConfig()
  assert.equal(config.baseUrl, 'https://api.anthropic.com')
})

test('RuntimeConfig 类型：apiKey 和 authToken 互斥，至少有一个', () => {
  // 这是类型测试，编译通过即视为通过
  const config1: RuntimeConfig = {
    model: 'claude-opus-4-7',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-xxx',
  }
  const config2: RuntimeConfig = {
    model: 'claude-opus-4-7',
    baseUrl: 'https://api.anthropic.com',
    authToken: 'Bearer xxx',
  }
  assert.ok(config1.apiKey)
  assert.ok(config2.authToken)
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
tsx --test test/config.test.ts 2>&1 | head -5
```

期望输出：`Cannot find module '../src/config.js'`

- [ ] **Step 3: 实现 `src/config.ts`**

```typescript
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// [K-04] 配置分层加载
// 优先级：环境变量 > 配置文件 > 默认值
// 好处：无需修改代码就能通过环境变量覆盖任何配置（CI/CD 场景常用）

export type RuntimeConfig = {
  model: string
  baseUrl: string
  maxOutputTokens?: number
  apiKey?: string
  authToken?: string
}

// 配置文件存储在 ~/.config/my-agent/config.json
const CONFIG_DIR = path.join(os.homedir(), '.config', 'my-agent')
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json')

type ConfigFile = Partial<RuntimeConfig>

async function readConfigFile(): Promise<ConfigFile> {
  try {
    const content = await readFile(CONFIG_PATH, 'utf8')
    return JSON.parse(content) as ConfigFile
  } catch {
    // 配置文件不存在或解析失败，返回空对象（使用默认值）
    return {}
  }
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const file = await readConfigFile()

  // 环境变量优先级最高，覆盖配置文件和默认值
  const model =
    process.env['ANTHROPIC_MODEL'] ??
    file.model ??
    'claude-opus-4-7'

  const baseUrl =
    process.env['ANTHROPIC_BASE_URL'] ??
    file.baseUrl ??
    'https://api.anthropic.com'

  const apiKey =
    process.env['ANTHROPIC_API_KEY'] ??
    file.apiKey

  const authToken =
    process.env['ANTHROPIC_AUTH_TOKEN'] ??
    file.authToken

  const maxOutputTokens =
    process.env['ANTHROPIC_MAX_OUTPUT_TOKENS']
      ? Number(process.env['ANTHROPIC_MAX_OUTPUT_TOKENS'])
      : file.maxOutputTokens

  return {
    model,
    baseUrl,
    maxOutputTokens,
    ...(apiKey ? { apiKey } : {}),
    ...(authToken ? { authToken } : {}),
  }
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
tsx --test test/config.test.ts
```

期望输出：6 个测试全部 `✓ passed`，0 failed。

- [ ] **Step 5: 提交**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(phase1): 实现运行时配置加载，环境变量优先 [K-04]"
```

---

## Task 5: 工作目录感知（`src/workspace.ts`）

> 知识点 `[K-05]`：Node.js 路径处理——`path.resolve` 把相对路径转为绝对路径，
> `path.relative` 计算两个绝对路径的相对关系，`isWithinDirectory` 用它判断文件是否在目录内。

**Files:**
- Create: `src/workspace.ts`
- Create: `test/workspace.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `test/workspace.test.ts`：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isWithinDirectory, resolveWorkspacePath, normalizeWorkspacePath } from '../src/workspace.js'

test('isWithinDirectory: 子路径返回 true', () => {
  assert.equal(isWithinDirectory('/home/user/project', '/home/user/project/src/index.ts'), true)
})

test('isWithinDirectory: 完全相同路径返回 true', () => {
  assert.equal(isWithinDirectory('/home/user/project', '/home/user/project'), true)
})

test('isWithinDirectory: 父路径返回 false', () => {
  assert.equal(isWithinDirectory('/home/user/project', '/home/user'), false)
})

test('isWithinDirectory: 同级不同目录返回 false', () => {
  assert.equal(isWithinDirectory('/home/user/project', '/home/user/other'), false)
})

test('isWithinDirectory: 路径前缀相似但不在目录内返回 false', () => {
  // /home/user/project2 不在 /home/user/project 里
  assert.equal(isWithinDirectory('/home/user/project', '/home/user/project2'), false)
})

test('resolveWorkspacePath: 相对路径转绝对路径', () => {
  const result = resolveWorkspacePath('/home/user/project', 'src/index.ts')
  assert.equal(result, '/home/user/project/src/index.ts')
})

test('resolveWorkspacePath: 绝对路径直接返回（不重复拼接）', () => {
  const result = resolveWorkspacePath('/home/user/project', '/tmp/other.ts')
  assert.equal(result, '/tmp/other.ts')
})

test('normalizeWorkspacePath: 解析 ~ 为 home 目录', () => {
  const result = normalizeWorkspacePath('~/foo/bar')
  assert.match(result, /^\//)  // 应该是绝对路径
  assert.ok(!result.startsWith('~'))
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
tsx --test test/workspace.test.ts 2>&1 | head -5
```

期望输出：`Cannot find module '../src/workspace.js'`

- [ ] **Step 3: 实现 `src/workspace.ts`**

```typescript
import path from 'node:path'
import os from 'node:os'

// [K-05] Node.js 路径处理
// path.resolve：把路径转为绝对路径（相对于 process.cwd() 或指定 base）
// path.relative：计算从 from 到 to 的相对路径
// 关键规则：用 path.relative 的结果判断包含关系，而不是用字符串 startsWith
// 原因：'/home/user/project2'.startsWith('/home/user/project') === true，但这是错误的

export function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  // relative 为空字符串：root === target
  // relative 不以 '..' 开头且不是绝对路径：target 在 root 内部
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

// resolveWorkspacePath：把相对路径解析为基于 cwd 的绝对路径
// 绝对路径直接返回（path.resolve 的行为）
export function resolveWorkspacePath(cwd: string, filePath: string): string {
  return path.resolve(cwd, filePath)
}

// normalizeWorkspacePath：解析 ~ 为 home 目录
export function normalizeWorkspacePath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1))
  }
  return path.resolve(filePath)
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
tsx --test test/workspace.test.ts
```

期望输出：8 个测试全部 `✓ passed`，0 failed。

- [ ] **Step 5: 提交**

```bash
git add src/workspace.ts test/workspace.test.ts
git commit -m "feat(phase1): 实现工作目录路径工具函数 [K-05]"
```

---

## Task 6: 运行全部 Phase 1 测试并整理

**Files:**
- Modify: `package.json`（更新 test 脚本）

- [ ] **Step 1: 确认 test 脚本**

Task 1 中 `package.json` 已设置正确，无需修改：

```json
"test": "tsx --test 'test/**/*.test.ts'"
```

- [ ] **Step 2: 运行全部测试**

```bash
npm test
```

期望输出：所有测试（共约 22 个）全部 `✓ passed`，0 failed，类似：

```
✓ ChatMessage: user 消息只有 content 字段
✓ ChatMessage: tool_result 消息有 toolUseId、content、isError
...
ℹ tests 22
ℹ pass 22
ℹ fail 0
```

- [ ] **Step 3: 类型检查**

```bash
npm run check
```

期望输出：无报错。`src/tool.ts` 已使用 `permissions?: unknown` 临时占位，Phase 4 实现 `PermissionManager` 后再替换为具体类型。

- [ ] **Step 4: 最终提交**

```bash
git add package.json src/tool.ts
git commit -m "chore(phase1): 整理测试脚本，Phase 1 全部测试通过"
```

---

## Phase 1 验收清单

完成后逐项确认：

- [ ] `npm test` 全部通过，0 failed
- [ ] `npm run check` 无 TypeScript 错误
- [ ] `ToolRegistry` 能注册工具、按名字执行、Zod 校验失败返回 `ok=false` 而非抛异常
- [ ] `loadRuntimeConfig()` 环境变量优先级高于配置文件
- [ ] `isWithinDirectory('/a/b', '/a/b2')` 返回 `false`（路径前缀陷阱已处理）
- [ ] git log 有 6 个清晰的提交

---

## 后续计划

Phase 1 完成后，进入 **Phase 2：Anthropic API 适配器**：

计划文件将保存为：`docs/superpowers/plans/2026-05-27-phase2-anthropic-adapter.md`

Phase 2 核心任务：
- `src/anthropic-adapter.ts`：内部 `ChatMessage[]` → Anthropic API 格式转换
- 指数退避重试（429 / 5xx）
- Tool Use 响应块解析、Thinking Block 保留
- `src/mock-model.ts`：离线 Mock 适配器
