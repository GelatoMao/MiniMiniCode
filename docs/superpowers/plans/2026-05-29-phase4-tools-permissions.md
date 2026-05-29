# Phase 4：工具层 + 权限系统 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 12 个工具和完整权限系统，让 Agent 能真实读写文件、执行命令，危险操作需用户确认。

**Architecture:** 工具层通过 `ToolContext.permissions` 字段获得权限管理器，`PermissionManager` 持久化允许/拒绝决策到磁盘，工具执行前调用 `ensurePathAccess` / `ensureCommand` / `ensureEdit` 三道门控。文件写入统一走 `applyReviewedFileChange`，展示 diff 后再落盘。

**Tech Stack:** Node.js fs/promises, node:child_process spawn, diff 库（createTwoFilesPatch）, ripgrep（rg），原生 fetch（Node 18+），Zod

---

## 文件结构

| 操作 | 文件 |
|------|------|
| 修改 | `src/tool.ts` — ToolContext 添加 `permissions` 字段；ToolRegistry 添加 `addDisposer`/`setMcpServers` |
| 修改 | `src/types.ts` — 添加 `BackgroundTaskResult` 类型 |
| 创建 | `src/workspace.ts` — `resolveToolPath` 路径解析 + 权限检查 |
| 创建 | `src/file-review.ts` — diff 生成 + 写入审查入口 |
| 创建 | `src/permissions.ts` — `PermissionManager` 完整权限系统 |
| 创建 | `src/background-tasks.ts` — 后台进程注册表 |
| 创建 | `src/utils/web.ts` — `fetchWebPage` + `searchDuckDuckGoLite` |
| 创建 | `src/skills.ts` — 最小化 skill 文件发现（供 Phase 4 用） |
| 修改 | `src/tools/read-file.ts` — 已存在，切换到 `resolveToolPath` |
| 创建 | `src/tools/write-file.ts` |
| 创建 | `src/tools/edit-file.ts` |
| 创建 | `src/tools/patch-file.ts` |
| 创建 | `src/tools/modify-file.ts` |
| 创建 | `src/tools/list-files.ts` |
| 创建 | `src/tools/grep-files.ts` |
| 创建 | `src/tools/run-command.ts` |
| 创建 | `src/tools/web-fetch.ts` |
| 创建 | `src/tools/web-search.ts` |
| 创建 | `src/tools/ask-user.ts` |
| 创建 | `src/tools/load-skill.ts` |
| 创建 | `src/tools/index.ts` |

---

## Task 1：扩展 ToolContext + ToolRegistry + 添加 BackgroundTaskResult 类型

**Files:**
- Modify: `src/tool.ts`
- Modify: `src/types.ts`

- [ ] **Step 1：阅读现有 tool.ts 和 types.ts**

```bash
cat src/tool.ts
cat src/types.ts | head -80
```

- [ ] **Step 2：在 types.ts 末尾添加 BackgroundTaskResult**

在文件末尾追加：

```typescript
// ── 后台任务（K-31）────────────────────────────────────────────────────────
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed'

export type BackgroundTaskResult = {
  taskId: string
  type: 'local_bash'
  command: string
  pid: number
  status: BackgroundTaskStatus
  startedAt: number
}
```

- [ ] **Step 3：在 tool.ts 中扩展 ToolContext，添加 permissions 可选字段**

在 `ToolContext` 类型声明中加入 `permissions` 字段（先用 `unknown` 占位，permissions.ts 建好后再换成具体类型）：

```typescript
// 在文件顶部添加前向类型引用（避免循环依赖）
export type PermissionManagerLike = {
  ensurePathAccess(targetPath: string, intent: 'read' | 'write' | 'list' | 'search' | 'command_cwd'): Promise<void>
  ensureCommand(command: string, args: string[], cwd: string, reason: string, opts?: { forcePromptReason?: string }): Promise<void>
  ensureEdit(targetPath: string, diffPreview: string): Promise<void>
  resetTurn(): void
}

export type ToolContext = {
  /** 工具操作的工作目录 */
  cwd: string
  /** [K-29] 可选权限管理器；无时默认仅限 workspace 内路径 */
  permissions?: PermissionManagerLike
}
```

- [ ] **Step 4：在 ToolRegistry 添加 addDisposer 和 setMcpServers（供 Phase 5 MCP 使用）**

在 `ToolRegistry` 类中追加：

```typescript
private disposers: Array<() => Promise<void>> = []

/** 注册清理函数（例如 MCP 连接关闭） */
addDisposer(fn: () => Promise<void>): void {
  this.disposers.push(fn)
}

/** 关闭所有已注册的清理资源 */
async dispose(): Promise<void> {
  await Promise.all(this.disposers.map(fn => fn()))
}

/** Phase 5 MCP 用：存储 server 摘要（此处先为占位 setter） */
setMcpServers(_servers: unknown[]): void {
  // Phase 5 实现
}
```

- [ ] **Step 5：验证 TypeScript 编译无报错**

```bash
cd /Users/maolu/Desktop/AI/haha/miniminicode
npx tsc --noEmit
```

期望：无报错（或只有 Phase 3 之前已知的警告）

- [ ] **Step 6：Commit**

```bash
git add src/tool.ts src/types.ts
git commit -m "feat(phase4): extend ToolContext with permissions + add BackgroundTaskResult type"
```

---

## Task 2：实现 workspace.ts

**Files:**
- Create: `src/workspace.ts`

`resolveToolPath` 是所有工具的路径入口：无权限管理器时校验路径不逃出 workspace；有权限管理器时调用 `ensurePathAccess`。

- [ ] **Step 1：创建 src/workspace.ts**

```typescript
/**
 * workspace.ts — 工具路径解析
 *
 * [K-05] 所有工具的路径入口：
 * 1. 无 permissions → 只允许 workspace 内路径
 * 2. 有 permissions → 委托给 PermissionManager.ensurePathAccess
 */
import path from 'node:path'
import type { ToolContext } from './tool.js'

/**
 * 解析工具请求的相对路径为绝对路径，并进行权限/边界检查。
 *
 * @param context - 工具运行上下文
 * @param targetPath - LLM 请求的路径（相对于 cwd）
 * @param intent - 操作意图（影响权限粒度）
 * @returns 绝对路径
 * @throws 路径逃出 workspace 时抛出错误
 */
export async function resolveToolPath(
  context: ToolContext,
  targetPath: string,
  intent: 'read' | 'write' | 'list' | 'search',
): Promise<string> {
  const resolved = path.resolve(context.cwd, targetPath)

  if (!context.permissions) {
    // 无权限管理器时的简单边界检查：不允许逃出 cwd
    const workspaceRoot = path.resolve(context.cwd)
    const relative = path.relative(workspaceRoot, resolved)

    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`路径逃出 workspace: ${targetPath}`)
    }

    return resolved
  }

  await context.permissions.ensurePathAccess(resolved, intent)
  return resolved
}
```

- [ ] **Step 2：写测试**

创建 `src/workspace.test.ts`：

```typescript
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { resolveToolPath } from './workspace.js'

describe('resolveToolPath', () => {
  const cwd = '/home/user/project'

  it('解析相对路径为绝对路径', async () => {
    const result = await resolveToolPath({ cwd }, 'src/main.ts', 'read')
    expect(result).toBe('/home/user/project/src/main.ts')
  })

  it('路径逃出 workspace 时抛出错误', async () => {
    await expect(
      resolveToolPath({ cwd }, '../../etc/passwd', 'read'),
    ).rejects.toThrow('路径逃出 workspace')
  })

  it('有 permissions 时调用 ensurePathAccess', async () => {
    let called = false
    const fakePermissions = {
      ensurePathAccess: async () => { called = true },
      ensureCommand: async () => {},
      ensureEdit: async () => {},
      resetTurn: () => {},
    }
    await resolveToolPath({ cwd, permissions: fakePermissions }, 'src/main.ts', 'write')
    expect(called).toBe(true)
  })
})
```

- [ ] **Step 3：运行测试**

```bash
npx vitest run src/workspace.test.ts
```

期望：3 个测试全部通过

- [ ] **Step 4：Commit**

```bash
git add src/workspace.ts src/workspace.test.ts
git commit -m "feat(phase4): add workspace resolveToolPath with boundary check"
```

---

## Task 3：实现 file-review.ts

**Files:**
- Create: `src/file-review.ts`

所有写文件操作的统一入口：生成 diff → 调用 `ensureEdit` 审查 → 原子写入。

- [ ] **Step 1：确认 diff 库已安装**

```bash
cat package.json | grep '"diff"'
```

如无，执行：
```bash
npm install diff
npm install --save-dev @types/diff
```

- [ ] **Step 2：创建 src/file-review.ts**

```typescript
/**
 * file-review.ts — 文件写入 diff 审查
 *
 * [K-30] 所有写文件操作的统一入口：
 * 1. buildUnifiedDiff：生成可读的 unified diff
 * 2. applyReviewedFileChange：diff → permissions.ensureEdit → 原子写入
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { ToolContext, ToolResult } from './tool.js'
import { isEnoentError } from './utils/errors.js'

/**
 * 生成 unified diff 字符串，供用户 review 使用。
 * 内容相同时返回 "(no changes)" 提示。
 */
export function buildUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
): string {
  if (before === after) {
    return `(no changes for ${filePath})`
  }

  const raw = createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    before,
    after,
    '',
    '',
    { context: 3 },
  )

  // 去掉 createTwoFilesPatch 生成的首行分隔符，保持输出紧凑
  const lines = raw.split('\n')
  if (lines[0]?.startsWith('===')) {
    return lines.slice(1).join('\n')
  }
  return raw
}

/**
 * 读取现有文件内容；文件不存在时返回空字符串（视为新建文件）。
 */
export async function loadExistingFile(targetPath: string): Promise<string> {
  try {
    return await readFile(targetPath, 'utf8')
  } catch (error) {
    if (isEnoentError(error)) {
      return ''
    }
    throw error
  }
}

/**
 * 执行有审查的文件写入：
 * 1. 读取旧内容
 * 2. 内容相同时提前返回（幂等）
 * 3. 生成 diff 并调用 permissions.ensureEdit
 * 4. 确保目录存在后写入文件
 */
export async function applyReviewedFileChange(
  context: ToolContext,
  filePath: string,
  targetPath: string,
  nextContent: string,
): Promise<ToolResult> {
  const previousContent = await loadExistingFile(targetPath)

  if (previousContent === nextContent) {
    return { ok: true, output: `No changes needed for ${filePath}` }
  }

  const diff = buildUnifiedDiff(filePath, previousContent, nextContent)

  // [K-29] 有权限管理器时才触发 edit 审查提示
  await context.permissions?.ensureEdit(targetPath, diff)

  // [K-17] 先确保目录存在，再写入（mkdir recursive 是幂等的）
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, nextContent, 'utf8')

  return { ok: true, output: `Applied reviewed changes to ${filePath}` }
}
```

- [ ] **Step 3：写测试**

创建 `src/file-review.test.ts`：

```typescript
import { describe, it, expect } from 'vitest'
import { buildUnifiedDiff } from './file-review.js'

describe('buildUnifiedDiff', () => {
  it('内容相同时返回 no changes', () => {
    expect(buildUnifiedDiff('a.ts', 'hello', 'hello')).toContain('no changes')
  })

  it('内容不同时返回 diff 字符串', () => {
    const diff = buildUnifiedDiff('a.ts', 'hello', 'world')
    expect(diff).toContain('-hello')
    expect(diff).toContain('+world')
  })
})
```

- [ ] **Step 4：运行测试**

```bash
npx vitest run src/file-review.test.ts
```

期望：2 个测试通过

- [ ] **Step 5：Commit**

```bash
git add src/file-review.ts src/file-review.test.ts
git commit -m "feat(phase4): add file-review diff generation and atomic write"
```

---

## Task 4：实现 permissions.ts

**Files:**
- Create: `src/permissions.ts`

**[K-29] 多维度权限模型：path / command / edit 三个维度，四种生命周期（once / turn / always / deny_always）。**

- [ ] **Step 1：查看 config.ts 确认 MINI_CODE_DIR 路径**

```bash
cat src/config.ts
```

如 `MINI_CODE_DIR` 不存在，需要在 config.ts 添加：

```typescript
import os from 'node:os'
import path from 'node:path'

export const MINI_CODE_DIR = path.join(os.homedir(), '.mini-code')
```

- [ ] **Step 2：创建 src/permissions.ts**

```typescript
/**
 * permissions.ts — 多维度权限管理系统
 *
 * [K-29] 三个维度的权限控制：
 * - path：文件系统读写权限
 * - command：shell 命令执行权限
 * - edit：文件编辑审查权限
 *
 * 四种生命周期：
 * - allow_once / deny_once：本次操作有效，记录在 session 集合中
 * - allow_turn / allow_all_turn：本轮 Agent 回合有效
 * - allow_always / deny_always：持久化到磁盘，下次启动仍有效
 * - deny_with_feedback：拒绝并把用户 feedback 传给模型
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR } from './config.js'
import { isEnoentError } from './utils/errors.js'
import type { PermissionManagerLike } from './tool.js'

// ── 公开类型 ─────────────────────────────────────────────────────────────

export type PermissionDecision =
  | 'allow_once'
  | 'allow_always'
  | 'allow_turn'
  | 'allow_all_turn'
  | 'deny_once'
  | 'deny_always'
  | 'deny_with_feedback'

export type PermissionChoice = {
  key: string
  label: string
  decision: PermissionDecision
}

export type PermissionPromptResult = {
  decision: PermissionDecision
  feedback?: string
}

export type PermissionRequest = {
  kind: 'path' | 'command' | 'edit'
  summary: string
  details: string[]
  scope: string
  choices: PermissionChoice[]
}

export type PermissionPromptHandler = (
  request: PermissionRequest,
) => Promise<PermissionPromptResult>

type PathIntent = 'read' | 'write' | 'list' | 'search' | 'command_cwd'

// ── 持久化格式 ───────────────────────────────────────────────────────────

type PermissionStore = {
  allowedDirectoryPrefixes?: string[]
  deniedDirectoryPrefixes?: string[]
  allowedCommandPatterns?: string[]
  deniedCommandPatterns?: string[]
  allowedEditPatterns?: string[]
  deniedEditPatterns?: string[]
}

const PERMISSIONS_PATH = path.join(MINI_CODE_DIR, 'permissions.json')

// ── 辅助函数 ─────────────────────────────────────────────────────────────

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath)
}

function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

function matchesDirectoryPrefix(
  targetPath: string,
  directories: Iterable<string>,
): boolean {
  for (const directory of directories) {
    if (isWithinDirectory(directory, targetPath)) {
      return true
    }
  }
  return false
}

function formatCommandSignature(command: string, args: string[]): string {
  return [command, ...args].join(' ').trim()
}

/**
 * 识别危险命令，返回风险说明；安全命令返回 null。
 */
function classifyDangerousCommand(command: string, args: string[]): string | null {
  const normalizedArgs = args.map(a => a.trim()).filter(Boolean)
  const signature = formatCommandSignature(command, normalizedArgs)

  if (command === 'git') {
    if (normalizedArgs.includes('reset') && normalizedArgs.includes('--hard')) {
      return `git reset --hard 会丢弃本地改动 (${signature})`
    }
    if (normalizedArgs.includes('clean')) {
      return `git clean 会删除未追踪文件 (${signature})`
    }
    if (
      normalizedArgs.includes('checkout') &&
      normalizedArgs.some(a => a.startsWith('--'))
    ) {
      return `git checkout 带 -- 参数可能覆盖工作区文件 (${signature})`
    }
  }

  if (command === 'rm') {
    return `rm 命令会永久删除文件 (${signature})`
  }
  if (command === 'sudo') {
    return `sudo 会以提升权限执行命令 (${signature})`
  }
  if (command === 'chmod' || command === 'chown') {
    return `${command} 会修改文件权限/所有者 (${signature})`
  }
  if (command === 'curl' || command === 'wget') {
    return `${command} 会发起网络请求 (${signature})`
  }

  return null
}

// ── PermissionManager 核心类 ─────────────────────────────────────────────

/**
 * [K-29] PermissionManager：三维度权限管理器
 *
 * 生命周期优先级（从高到低）：
 * 1. turnAllowAllEdits（本轮全局允许编辑）
 * 2. sessionDenied / sessionAllowed（本次会话）
 * 3. turnAllowed（本轮）
 * 4. persisted allowed/denied（持久化）
 * 5. 触发 prompt
 */
export class PermissionManager implements PermissionManagerLike {
  // ── 持久化集合 ─────────────────────────────
  private allowedDirectoryPrefixes = new Set<string>()
  private deniedDirectoryPrefixes = new Set<string>()
  private allowedCommandPatterns = new Set<string>()
  private deniedCommandPatterns = new Set<string>()
  private allowedEditPatterns = new Set<string>()
  private deniedEditPatterns = new Set<string>()

  // ── Session 级别（进程内有效）──────────────
  private sessionAllowedPaths = new Set<string>()
  private sessionDeniedPaths = new Set<string>()
  private sessionAllowedCommands = new Set<string>()
  private sessionDeniedCommands = new Set<string>()
  private sessionAllowedEdits = new Set<string>()
  private sessionDeniedEdits = new Set<string>()

  // ── Turn 级别（单次 Agent 回合有效）────────
  private turnAllowedEdits = new Set<string>()
  private turnAllowAllEdits = false

  private readonly prompt: PermissionPromptHandler | null
  /** 延迟加载的 Promise，确保磁盘状态只加载一次 */
  private readonly ready: Promise<void>

  constructor(prompt: PermissionPromptHandler | null = null) {
    this.prompt = prompt
    this.ready = this.load()
  }

  /** 加载持久化权限数据 */
  private async load(): Promise<void> {
    try {
      const raw = await readFile(PERMISSIONS_PATH, 'utf8')
      const store: PermissionStore = JSON.parse(raw)
      for (const p of store.allowedDirectoryPrefixes ?? []) this.allowedDirectoryPrefixes.add(p)
      for (const p of store.deniedDirectoryPrefixes ?? []) this.deniedDirectoryPrefixes.add(p)
      for (const p of store.allowedCommandPatterns ?? []) this.allowedCommandPatterns.add(p)
      for (const p of store.deniedCommandPatterns ?? []) this.deniedCommandPatterns.add(p)
      for (const p of store.allowedEditPatterns ?? []) this.allowedEditPatterns.add(p)
      for (const p of store.deniedEditPatterns ?? []) this.deniedEditPatterns.add(p)
    } catch (error) {
      if (!isEnoentError(error)) throw error
      // 文件不存在时正常：首次运行
    }
  }

  /** 持久化当前权限状态到磁盘 */
  private async persist(): Promise<void> {
    const store: PermissionStore = {
      allowedDirectoryPrefixes: [...this.allowedDirectoryPrefixes],
      deniedDirectoryPrefixes: [...this.deniedDirectoryPrefixes],
      allowedCommandPatterns: [...this.allowedCommandPatterns],
      deniedCommandPatterns: [...this.deniedCommandPatterns],
      allowedEditPatterns: [...this.allowedEditPatterns],
      deniedEditPatterns: [...this.deniedEditPatterns],
    }
    await mkdir(path.dirname(PERMISSIONS_PATH), { recursive: true })
    await writeFile(PERMISSIONS_PATH, JSON.stringify(store, null, 2), 'utf8')
  }

  /** 回合结束时调用，清除 turn 级别权限 */
  resetTurn(): void {
    this.turnAllowedEdits.clear()
    this.turnAllowAllEdits = false
  }

  // ── 路径权限 ────────────────────────────────────────────────────────────

  async ensurePathAccess(
    targetPath: string,
    _intent: PathIntent,
  ): Promise<void> {
    await this.ready
    const normalized = normalizePath(targetPath)

    if (matchesDirectoryPrefix(normalized, this.deniedDirectoryPrefixes)) {
      throw new Error(`路径访问被拒绝: ${normalized}`)
    }
    if (
      this.sessionAllowedPaths.has(normalized) ||
      matchesDirectoryPrefix(normalized, this.allowedDirectoryPrefixes)
    ) {
      return
    }

    if (!this.prompt) {
      // 无交互模式：默认允许（依赖 resolveToolPath 的 workspace 边界检查）
      return
    }

    const result = await this.prompt({
      kind: 'path',
      summary: 'mini-code 希望访问路径',
      details: [`目标: ${normalized}`],
      scope: normalized,
      choices: [
        { key: 'y', label: '本次允许', decision: 'allow_once' },
        { key: 'a', label: '始终允许此路径', decision: 'allow_always' },
        { key: 'n', label: '拒绝', decision: 'deny_once' },
      ],
    })

    if (result.decision === 'allow_once') {
      this.sessionAllowedPaths.add(normalized)
      return
    }
    if (result.decision === 'allow_always') {
      this.allowedDirectoryPrefixes.add(normalized)
      await this.persist()
      return
    }
    if (result.decision === 'deny_always') {
      this.deniedDirectoryPrefixes.add(normalized)
      await this.persist()
    } else {
      this.sessionDeniedPaths.add(normalized)
    }

    throw new Error(`路径访问被拒绝: ${normalized}`)
  }

  // ── 命令权限 ────────────────────────────────────────────────────────────

  async ensureCommand(
    command: string,
    args: string[],
    commandCwd: string,
    reason: string,
    options?: { forcePromptReason?: string },
  ): Promise<void> {
    await this.ready
    const signature = formatCommandSignature(command, args)

    if (this.deniedCommandPatterns.has(signature) || this.sessionDeniedCommands.has(signature)) {
      throw new Error(`命令被拒绝: ${signature}`)
    }

    if (
      this.sessionAllowedCommands.has(signature) ||
      this.allowedCommandPatterns.has(signature)
    ) {
      return
    }

    const danger = classifyDangerousCommand(command, args)
    if (!danger) {
      // 非危险命令直接放行
      return
    }

    if (!this.prompt) {
      throw new Error(
        `命令需要确认: ${signature}。请在 TTY 模式下运行 mini-code 以批准命令。`,
      )
    }

    const result = await this.prompt({
      kind: 'command',
      summary: options?.forcePromptReason ?? 'mini-code 想执行危险命令',
      details: [
        `cwd: ${commandCwd}`,
        `命令: ${signature}`,
        `原因: ${reason}`,
        `风险: ${danger}`,
      ],
      scope: signature,
      choices: [
        { key: 'y', label: '本次允许', decision: 'allow_once' },
        { key: 'a', label: '始终允许此命令', decision: 'allow_always' },
        { key: 'n', label: '本次拒绝', decision: 'deny_once' },
        { key: 'd', label: '始终拒绝此命令', decision: 'deny_always' },
      ],
    })

    if (result.decision === 'allow_once') {
      this.sessionAllowedCommands.add(signature)
      return
    }
    if (result.decision === 'allow_always') {
      this.allowedCommandPatterns.add(signature)
      await this.persist()
      return
    }
    if (result.decision === 'deny_always') {
      this.deniedCommandPatterns.add(signature)
      await this.persist()
    } else {
      this.sessionDeniedCommands.add(signature)
    }

    throw new Error(`命令被拒绝: ${signature}`)
  }

  // ── 编辑权限 ────────────────────────────────────────────────────────────

  async ensureEdit(targetPath: string, diffPreview: string): Promise<void> {
    await this.ready
    const normalized = normalizePath(targetPath)

    if (
      this.sessionDeniedEdits.has(normalized) ||
      this.deniedEditPatterns.has(normalized)
    ) {
      throw new Error(`编辑被拒绝: ${normalized}`)
    }

    if (
      this.sessionAllowedEdits.has(normalized) ||
      this.turnAllowedEdits.has(normalized) ||
      this.turnAllowAllEdits ||
      this.allowedEditPatterns.has(normalized)
    ) {
      return
    }

    if (!this.prompt) {
      // 无交互模式：直接允许（Phase 4 CLI 入口会传入 prompt）
      return
    }

    const result = await this.prompt({
      kind: 'edit',
      summary: 'mini-code 希望修改文件',
      details: [`目标: ${normalized}`, '', diffPreview],
      scope: normalized,
      choices: [
        { key: '1', label: '应用', decision: 'allow_once' },
        { key: '2', label: '本轮允许此文件', decision: 'allow_turn' },
        { key: '3', label: '本轮允许所有编辑', decision: 'allow_all_turn' },
        { key: '4', label: '始终允许此文件', decision: 'allow_always' },
        { key: '5', label: '本次拒绝', decision: 'deny_once' },
        { key: '6', label: '拒绝并反馈给模型', decision: 'deny_with_feedback' },
        { key: '7', label: '始终拒绝此文件', decision: 'deny_always' },
      ],
    })

    if (result.decision === 'allow_once') {
      this.sessionAllowedEdits.add(normalized)
      return
    }
    if (result.decision === 'allow_turn') {
      this.turnAllowedEdits.add(normalized)
      return
    }
    if (result.decision === 'allow_all_turn') {
      this.turnAllowAllEdits = true
      return
    }
    if (result.decision === 'allow_always') {
      this.allowedEditPatterns.add(normalized)
      await this.persist()
      return
    }
    if (result.decision === 'deny_with_feedback') {
      const guidance = result.feedback?.trim()
      if (guidance) {
        throw new Error(`编辑被拒绝: ${normalized}\n用户反馈: ${guidance}`)
      }
      this.sessionDeniedEdits.add(normalized)
      throw new Error(`编辑被拒绝: ${normalized}`)
    }
    if (result.decision === 'deny_always') {
      this.deniedEditPatterns.add(normalized)
      await this.persist()
    } else {
      this.sessionDeniedEdits.add(normalized)
    }

    throw new Error(`编辑被拒绝: ${normalized}`)
  }
}

export function getPermissionsPath(): string {
  return PERMISSIONS_PATH
}
```

- [ ] **Step 3：确保 config.ts 导出 MINI_CODE_DIR**

```bash
grep 'MINI_CODE_DIR' src/config.ts
```

如果不存在，在 config.ts 末尾添加：

```typescript
import os from 'node:os'
export const MINI_CODE_DIR = path.join(os.homedir(), '.mini-code')
```

- [ ] **Step 4：TypeScript 编译验证**

```bash
npx tsc --noEmit
```

期望：无新增报错

- [ ] **Step 5：Commit**

```bash
git add src/permissions.ts src/config.ts
git commit -m "feat(phase4): add PermissionManager with path/command/edit 3D permission model"
```

---

## Task 5：实现 background-tasks.ts

**Files:**
- Create: `src/background-tasks.ts`

**[K-31] 后台进程生命周期：taskId 注册 + 状态追踪 + 进程清理。**

- [ ] **Step 1：创建 src/background-tasks.ts**

```typescript
/**
 * background-tasks.ts — 后台 shell 任务注册表
 *
 * [K-31] run_command 工具以后台模式启动命令时，
 * 通过 registerBackgroundShellTask 记录进程信息。
 * 状态查询用 process.kill(pid, 0) 探活，不发送真实信号。
 */
import process from 'node:process'
import type { BackgroundTaskResult, BackgroundTaskStatus } from './types.js'
import { getErrorCode } from './utils/errors.js'

type BackgroundTaskRecord = BackgroundTaskResult & {
  cwd: string
}

// 模块级 Map：进程内全局任务注册表
const tasks = new Map<string, BackgroundTaskRecord>()

function makeTaskId(): string {
  // shell_ + 时间戳(36进制) + 随机6位
  return `shell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 用 process.kill(pid, 0) 刷新任务状态：
 * - ESRCH 错误 = 进程不存在 → completed
 * - 其他错误 → failed
 * - 无错误 = 进程存活 → running（保持不变）
 */
function refreshRecord(record: BackgroundTaskRecord): BackgroundTaskRecord {
  if (record.status !== 'running') {
    return record
  }

  try {
    process.kill(record.pid, 0)
    return record
  } catch (error) {
    const code = getErrorCode(error)
    const nextStatus: BackgroundTaskStatus = code === 'ESRCH' ? 'completed' : 'failed'
    const next = { ...record, status: nextStatus }
    tasks.set(record.taskId, next)
    return next
  }
}

/**
 * 注册后台 shell 任务，返回任务元信息。
 */
export function registerBackgroundShellTask(args: {
  command: string
  pid: number
  cwd: string
}): BackgroundTaskResult {
  const task: BackgroundTaskRecord = {
    taskId: makeTaskId(),
    type: 'local_bash',
    command: args.command,
    pid: args.pid,
    cwd: args.cwd,
    status: 'running',
    startedAt: Date.now(),
  }
  tasks.set(task.taskId, task)
  return task
}

/**
 * 获取所有后台任务列表（刷新 running 状态后返回）。
 */
export function listBackgroundTasks(): BackgroundTaskResult[] {
  return [...tasks.values()].map(refreshRecord)
}

/**
 * 向后台任务发送 SIGTERM 信号，将其从注册表移除。
 * 进程不存在时静默忽略。
 */
export function killBackgroundTask(taskId: string): boolean {
  const record = tasks.get(taskId)
  if (!record) return false

  try {
    process.kill(record.pid, 'SIGTERM')
  } catch {
    // 进程已退出，忽略错误
  }
  tasks.delete(taskId)
  return true
}
```

- [ ] **Step 2：Commit**

```bash
git add src/background-tasks.ts
git commit -m "feat(phase4): add background task registry with PID probe"
```

---

## Task 6：实现 utils/web.ts

**Files:**
- Create: `src/utils/web.ts`

**[K-24][K-25] 抓取网页（HTML → 纯文本）+ 搜索 API 封装（DuckDuckGo Lite + Sogou 双后备）。**

- [ ] **Step 1：创建 src/utils/web.ts**

```typescript
/**
 * utils/web.ts — 网络工具
 *
 * [K-24] fetchWebPage：抓取 URL，HTML 转纯文本，处理重定向
 * [K-25] searchDuckDuckGoLite：DuckDuckGo Lite + Sogou 双后备搜索
 *
 * 设计原则：
 * - 用 AbortController 实现超时，不依赖任何外部库
 * - 指数退避重试（最多 2 次），只对 429/5xx 和网络错误重试
 * - HTML 解析只用正则，不引入额外解析库
 */
import { getErrorCode } from './errors.js'

// ── 类型 ─────────────────────────────────────────────────────────────────

type SearchResult = {
  title: string
  link: string
  snippet: string
  date: string
  display_link: string
}

type SearchProvider = 'duckduckgo-lite' | 'sogou'

// ── 常量 ─────────────────────────────────────────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 MiniCode/0.1'
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_RETRIES = 2

// ── 工具函数 ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (!code) return error instanceof Error && error.name === 'AbortError'
  return ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)
}

function formatWebErrorMessage(url: string, error: unknown, timeoutMs: number): string {
  const code = getErrorCode(error)
  if (code) return `request failed (${code}) for ${url}`
  if (error instanceof Error && error.name === 'AbortError')
    return `request timed out after ${timeoutMs}ms for ${url}`
  if (error instanceof Error && error.message) return `${error.message} (${url})`
  return `request failed for ${url}`
}

async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options?: { timeoutMs?: number; maxRetries?: number },
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
  const target = typeof url === 'string' ? url : url.toString()

  let lastError: unknown = null
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      clearTimeout(timeout)
      lastResponse = response

      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        await sleep(300 * Math.pow(2, attempt))
        continue
      }
      return response
    } catch (error) {
      clearTimeout(timeout)
      lastError = error
      if (attempt < maxRetries && isRetryableNetworkError(error)) {
        await sleep(300 * Math.pow(2, attempt))
        continue
      }
      throw new Error(formatWebErrorMessage(target, error, timeoutMs))
    }
  }

  if (lastResponse) return lastResponse
  throw new Error(formatWebErrorMessage(target, lastError, timeoutMs))
}

// ── HTML 解析工具 ─────────────────────────────────────────────────────────

function firstMatch(pattern: RegExp, text: string, group = 1): string | null {
  return text.match(pattern)?.[group] ?? null
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/gu, '&').replace(/&quot;/gu, '"')
    .replace(/&#x27;/gu, "'").replace(/&#39;/gu, "'")
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>')
    .replace(/&#x2F;/gu, '/').replace(/&#47;/gu, '/')
    .replace(/&nbsp;/gu, ' ')
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)
  return match ? decodeHtml(stripTags(match[1] ?? '')).trim() : null
}

function extractReadableText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/giu, ' ')
      .replace(/<style[\s\S]*?<\/style>/giu, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/giu, ' ')
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
}

function extractHtmlRedirectUrl(html: string, baseUrl: string): string | null {
  const raw = decodeHtml((
    firstMatch(/window\.location(?:\.href)?(?:\.replace)?\((['"])(.*?)\1\)/iu, html, 2) ??
    firstMatch(/window\.location(?:\.href)?\s*=\s*(['"])(.*?)\1/iu, html, 2) ??
    firstMatch(/<meta[^>]*http-equiv=(['"])refresh\1[^>]*content=(['"])[\s\S]*?url\s*=\s*('?)([^"'>;]+)\3[\s\S]*?\2[^>]*>/iu, html, 4) ?? ''
  ).trim())
  if (!raw) return null
  try { return new URL(raw, baseUrl).toString() } catch { return null }
}

// ── 搜索结果解析 ───────────────────────────────────────────────────────────

function normalizeDuckDuckGoLink(rawHref: string): string {
  const href = decodeHtml(rawHref).trim()
  if (!href) return ''
  const absolute = href.startsWith('//') ? `https:${href}` : href
  try {
    const url = new URL(absolute)
    const redirect = url.searchParams.get('uddg')
    return redirect ? decodeURIComponent(redirect) : url.toString()
  } catch { return absolute }
}

function parseDuckDuckGoLite(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const matches = [...html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu)]

  for (let i = 0; i < matches.length; i++) {
    const anchorHtml = matches[i]?.[0] ?? ''
    const classValue = firstMatch(/class=(['"])([\s\S]*?)\1/iu, anchorHtml, 2) ?? ''
    if (!/\bresult-link\b/i.test(classValue)) continue

    const rawHref = firstMatch(/href=(['"])([\s\S]*?)\1/iu, anchorHtml, 2) ?? ''
    const title = decodeHtml(stripTags(firstMatch(/<a\b[^>]*>([\s\S]*?)<\/a>/iu, anchorHtml) ?? ''))
    const next = matches[i + 1]
    const block = html.slice(matches[i]?.index ?? 0, next?.index ?? html.length)
    const snippet = decodeHtml(stripTags(
      firstMatch(/<td[^>]*class=(['"])[^'"]*\bresult-snippet\b[^'"]*\1[^>]*>\s*([\s\S]*?)\s*<\/td>/iu, block, 2) ?? '',
    ))
    const displayLink = decodeHtml(stripTags(
      firstMatch(/<span[^>]*class=(['"])[^'"]*\blink-text\b[^'"]*\1[^>]*>([\s\S]*?)<\/span>/iu, block, 2) ?? '',
    ))
    const link = normalizeDuckDuckGoLink(rawHref)
    if (!title || !link) continue
    results.push({ title, link, snippet, date: '', display_link: displayLink })
  }
  return results
}

function parseSogouSearch(html: string): SearchResult[] {
  const matches = [...html.matchAll(/<h3\b[^>]*>\s*([\s\S]*?)<\/h3>/giu)]
  return matches.flatMap((match, i) => {
    const h3Html = match[0]
    const rawHref = decodeHtml(firstMatch(/href=(['"])([\s\S]*?)\1/iu, h3Html, 2) ?? '')
    const title = decodeHtml(stripTags(firstMatch(/<a\b[^>]*>([\s\S]*?)<\/a>/iu, h3Html, 1) ?? ''))
    const link = rawHref.startsWith('/') ? `https://www.sogou.com${rawHref}` :
                 rawHref.startsWith('//') ? `https:${rawHref}` : rawHref
    if (!title || !link) return []
    const next = matches[i + 1]
    const block = html.slice(match.index ?? 0, next?.index ?? html.length)
    const snippet = decodeHtml(stripTags(
      firstMatch(/<(div|p)\b[^>]*class=(['"])[^'"]*(fz-mid|str-text-info|text-layout|space-txt)[^'"]*\2[^>]*>([\s\S]*?)<\/\1>/iu, block, 4) ?? '',
    ))
    let displayLink = ''
    try { displayLink = new URL(link).hostname } catch { displayLink = link }
    return [{ title, link, snippet, date: '', display_link: displayLink }]
  })
}

function fetchSearchPage(provider: SearchProvider, query: string): Promise<Response> {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }
  if (provider === 'duckduckgo-lite') {
    const url = new URL('https://lite.duckduckgo.com/lite/')
    url.searchParams.set('q', query)
    headers['accept-language'] = 'en-US,en;q=0.9'
    return fetchWithRetry(url, { headers })
  }
  const url = new URL('https://www.sogou.com/web')
  url.searchParams.set('query', query)
  headers['accept-language'] = 'zh-CN,zh;q=0.9,en;q=0.6'
  return fetchWithRetry(url, { headers })
}

// ── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 搜索网页，DuckDuckGo Lite 优先，失败降级到 Sogou。
 */
export async function searchDuckDuckGoLite(options: {
  query: string
  maxResults?: number
}): Promise<{
  organic: SearchResult[]
  base_resp: { status_code: number; status_msg: string; source: string }
}> {
  const maxResults = options.maxResults ?? 5
  const providers: SearchProvider[] = ['duckduckgo-lite', 'sogou']
  const errors: string[] = []

  for (const provider of providers) {
    try {
      const response = await fetchSearchPage(provider, options.query)
      if (!response.ok) { errors.push(`${provider}: HTTP ${response.status}`); continue }
      const html = await response.text()
      const parsed = provider === 'duckduckgo-lite' ? parseDuckDuckGoLite(html) : parseSogouSearch(html)
      const organic = parsed.slice(0, maxResults)
      if (organic.length > 0) {
        return { organic, base_resp: { status_code: response.status, status_msg: response.statusText, source: provider } }
      }
      errors.push(`${provider}: no results`)
    } catch (error) {
      errors.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (errors.length > 0) throw new Error(`所有搜索服务均失败 (${errors.join('; ')})`)
  return { organic: [], base_resp: { status_code: 200, status_msg: 'OK', source: 'fallback-empty' } }
}

/**
 * 抓取网页并提取可读文本内容。
 */
export async function fetchWebPage(options: {
  url: string
  maxChars?: number
}): Promise<{
  url: string
  finalUrl: string
  status: number
  statusText: string
  contentType: string
  title: string | null
  content: string
}> {
  const requestInit: RequestInit = {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  }

  let response = await fetchWithRetry(options.url, requestInit)
  let text = await response.text()
  let contentType = response.headers.get('content-type') ?? ''
  let finalUrl = response.url || options.url

  if (contentType.includes('html')) {
    const redirectUrl = extractHtmlRedirectUrl(text, finalUrl)
    if (redirectUrl && redirectUrl !== finalUrl) {
      response = await fetchWithRetry(redirectUrl, requestInit)
      text = await response.text()
      contentType = response.headers.get('content-type') ?? ''
      finalUrl = response.url || redirectUrl
    }
  }

  const maxChars = options.maxChars ?? 12_000

  if (contentType.includes('html')) {
    return {
      url: options.url, finalUrl,
      status: response.status, statusText: response.statusText, contentType,
      title: extractTitle(text),
      content: extractReadableText(text).slice(0, maxChars),
    }
  }

  return {
    url: options.url, finalUrl,
    status: response.status, statusText: response.statusText, contentType,
    title: null, content: text.slice(0, maxChars),
  }
}
```

- [ ] **Step 2：TypeScript 编译验证**

```bash
npx tsc --noEmit
```

- [ ] **Step 3：Commit**

```bash
git add src/utils/web.ts
git commit -m "feat(phase4): add web utils with retry, HTML-to-text, DuckDuckGo+Sogou search"
```

---

## Task 7：实现最小化 skills.ts（供 load-skill 工具使用）

**Files:**
- Create: `src/skills.ts`

Phase 5 会扩展完整的 skill 发现逻辑；此处只实现 Phase 4 所需的最小接口。

- [ ] **Step 1：创建 src/skills.ts**

```typescript
/**
 * skills.ts — Skill 文件发现与加载（最小化实现）
 *
 * [K-27] Phase 4 最小实现：只扫描 <cwd>/.mini-code/skills/ 目录。
 * Phase 5 会扩展为全层级发现、兼容 .claude/skills 等。
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isEnoentError } from './utils/errors.js'

export type SkillFile = {
  name: string
  path: string
  source: string
  content: string
}

/**
 * 扫描 <cwd>/.mini-code/skills/ 目录下的所有 .md 文件。
 * 目录不存在时返回空数组（不报错）。
 */
export async function discoverSkills(cwd: string): Promise<SkillFile[]> {
  const skillsDir = path.join(cwd, '.mini-code', 'skills')

  let entries: Awaited<ReturnType<typeof readdir>>
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch (error) {
    if (isEnoentError(error)) return []
    throw error
  }

  const skills: SkillFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const filePath = path.join(skillsDir, entry.name)
    try {
      const content = await readFile(filePath, 'utf8')
      const name = entry.name.replace(/\.md$/i, '')
      skills.push({ name, path: filePath, source: 'local', content })
    } catch {
      // 跳过无法读取的文件
    }
  }
  return skills
}

/**
 * 按名称查找 skill（大小写不敏感）。
 */
export async function loadSkill(
  cwd: string,
  name: string,
): Promise<SkillFile | null> {
  const skills = await discoverSkills(cwd)
  const normalized = name.trim().toLowerCase()
  return skills.find(s => s.name.toLowerCase() === normalized) ?? null
}
```

- [ ] **Step 2：Commit**

```bash
git add src/skills.ts
git commit -m "feat(phase4): add minimal skills discovery for load-skill tool"
```

---

## Task 8：升级 read-file.ts 使用 resolveToolPath

**Files:**
- Modify: `src/tools/read-file.ts`

现有 read-file.ts 用 `path.resolve` 直接处理路径，升级为调用 `resolveToolPath` 统一走权限层。

- [ ] **Step 1：修改 src/tools/read-file.ts**

将文件中路径解析部分替换：

```typescript
// 原来的
import path from 'node:path'
// ...
const target = path.resolve(context.cwd, input.path)
```

改为：

```typescript
import { resolveToolPath } from '../workspace.js'
// ...
const target = await resolveToolPath(context, input.path, 'read')
```

- [ ] **Step 2：确认编译通过**

```bash
npx tsc --noEmit
```

- [ ] **Step 3：Commit**

```bash
git add src/tools/read-file.ts
git commit -m "refactor(phase4): read-file uses resolveToolPath for permission-aware path resolution"
```

---

## Task 9：实现文件写入工具（write-file, edit-file, patch-file, modify-file）

**Files:**
- Create: `src/tools/write-file.ts`
- Create: `src/tools/edit-file.ts`
- Create: `src/tools/patch-file.ts`
- Create: `src/tools/modify-file.ts`

这四个工具都走 `applyReviewedFileChange`，区别只在于"如何计算新内容"。

- [ ] **Step 1：创建 src/tools/write-file.ts**

```typescript
/**
 * write_file — 写入完整文件内容
 *
 * [K-17] 通过 applyReviewedFileChange 触发 diff 审查后写入，
 * 不直接调用 writeFile，确保用户看到 diff。
 */
import { z } from 'zod'
import { applyReviewedFileChange } from '../file-review.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

type Input = { path: string; content: string }

export const writeFileTool: ToolDefinition<Input> = {
  name: 'write_file',
  description: 'Write a UTF-8 text file relative to the workspace root.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to cwd' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['path', 'content'],
  },
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    return applyReviewedFileChange(context, input.path, target, input.content)
  },
}
```

- [ ] **Step 2：创建 src/tools/edit-file.ts**

```typescript
/**
 * edit_file — 精确字符串替换
 *
 * [K-18] search 必须在文件中唯一匹配，否则返回错误。
 * replaceAll=true 时替换所有出现位置。
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { applyReviewedFileChange } from '../file-review.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

type Input = { path: string; search: string; replace: string; replaceAll?: boolean }

export const editFileTool: ToolDefinition<Input> = {
  name: 'edit_file',
  description: 'Edit a text file by replacing exact text.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      search: { type: 'string', description: 'Exact text to find' },
      replace: { type: 'string', description: 'Text to replace it with' },
      replaceAll: { type: 'boolean', description: 'Replace all occurrences (default false)' },
    },
    required: ['path', 'search', 'replace'],
  },
  schema: z.object({
    path: z.string().min(1),
    search: z.string().min(1),
    replace: z.string(),
    replaceAll: z.boolean().optional(),
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    const original = await readFile(target, 'utf8')

    if (!original.includes(input.search)) {
      return { ok: false, output: `Text not found in ${input.path}` }
    }

    const next = input.replaceAll
      ? original.split(input.search).join(input.replace)
      : original.replace(input.search, input.replace)

    return applyReviewedFileChange(context, input.path, target, next)
  },
}
```

- [ ] **Step 3：创建 src/tools/patch-file.ts**

```typescript
/**
 * patch_file — 一次提交多个精确替换
 *
 * [K-19] replacements 按顺序应用，任一 search 不存在时整体失败。
 * 比多次调用 edit_file 效率高，且只产生一次 diff 审查。
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { applyReviewedFileChange } from '../file-review.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

const ReplacementSchema = z.object({
  search: z.string().min(1),
  replace: z.string(),
  replaceAll: z.boolean().optional(),
})

type Input = {
  path: string
  replacements: Array<{ search: string; replace: string; replaceAll?: boolean }>
}

export const patchFileTool: ToolDefinition<Input> = {
  name: 'patch_file',
  description: 'Apply multiple exact-text replacements to one file in a single operation.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      replacements: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            search: { type: 'string' },
            replace: { type: 'string' },
            replaceAll: { type: 'boolean' },
          },
          required: ['search', 'replace'],
        },
      },
    },
    required: ['path', 'replacements'],
  },
  schema: z.object({
    path: z.string().min(1),
    replacements: z.array(ReplacementSchema).min(1),
  }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    let content = await readFile(target, 'utf8')

    for (const [index, replacement] of input.replacements.entries()) {
      if (!content.includes(replacement.search)) {
        return { ok: false, output: `Replacement ${index + 1} not found in ${input.path}` }
      }
      content = replacement.replaceAll
        ? content.split(replacement.search).join(replacement.replace)
        : content.replace(replacement.search, replacement.replace)
    }

    return applyReviewedFileChange(context, input.path, target, content)
  },
}
```

- [ ] **Step 4：创建 src/tools/modify-file.ts**

```typescript
/**
 * modify_file — 带 diff 审查的全文件替换
 *
 * [K-20] 功能与 write_file 相同，语义上强调"修改已有文件"而非"创建文件"。
 * 适合模型在已读取文件后整体改写的场景。
 */
import { z } from 'zod'
import { applyReviewedFileChange } from '../file-review.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

type Input = { path: string; content: string }

export const modifyFileTool: ToolDefinition<Input> = {
  name: 'modify_file',
  description: 'Replace a file with reviewed content so the user can approve the diff first.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path, 'write')
    return applyReviewedFileChange(context, input.path, target, input.content)
  },
}
```

- [ ] **Step 5：TypeScript 编译验证**

```bash
npx tsc --noEmit
```

期望：无报错

- [ ] **Step 6：写集成测试**

创建 `src/tools/write-edit-tools.test.ts`：

```typescript
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, afterEach } from 'vitest'
import { writeFileTool } from './write-file.js'
import { editFileTool } from './edit-file.js'
import { patchFileTool } from './patch-file.js'
import { modifyFileTool } from './modify-file.js'

let tmpDir: string

async function setup() {
  tmpDir = await mkdtemp(path.join(tmpdir(), 'minicode-test-'))
  return { cwd: tmpDir }
}

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

describe('write_file', () => {
  it('写入新文件', async () => {
    const ctx = await setup()
    const result = await writeFileTool.run({ path: 'hello.txt', content: 'hello world' }, ctx)
    expect(result.ok).toBe(true)
    const content = await readFile(path.join(tmpDir, 'hello.txt'), 'utf8')
    expect(content).toBe('hello world')
  })
})

describe('edit_file', () => {
  it('精确替换文本', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'a.txt', content: 'foo bar baz' }, ctx)
    const result = await editFileTool.run({ path: 'a.txt', search: 'bar', replace: 'qux' }, ctx)
    expect(result.ok).toBe(true)
    const content = await readFile(path.join(tmpDir, 'a.txt'), 'utf8')
    expect(content).toBe('foo qux baz')
  })

  it('search 不存在时返回 ok: false', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'b.txt', content: 'hello' }, ctx)
    const result = await editFileTool.run({ path: 'b.txt', search: 'notexist', replace: 'x' }, ctx)
    expect(result.ok).toBe(false)
  })
})

describe('patch_file', () => {
  it('按顺序应用多个替换', async () => {
    const ctx = await setup()
    await writeFileTool.run({ path: 'c.txt', content: 'a b c' }, ctx)
    const result = await patchFileTool.run({
      path: 'c.txt',
      replacements: [{ search: 'a', replace: '1' }, { search: 'b', replace: '2' }],
    }, ctx)
    expect(result.ok).toBe(true)
    const content = await readFile(path.join(tmpDir, 'c.txt'), 'utf8')
    expect(content).toBe('1 2 c')
  })
})
```

- [ ] **Step 7：运行测试**

```bash
npx vitest run src/tools/write-edit-tools.test.ts
```

期望：全部通过

- [ ] **Step 8：Commit**

```bash
git add src/tools/write-file.ts src/tools/edit-file.ts src/tools/patch-file.ts src/tools/modify-file.ts src/tools/write-edit-tools.test.ts
git commit -m "feat(phase4): add write-file, edit-file, patch-file, modify-file tools"
```

---

## Task 10：实现目录和搜索工具（list-files, grep-files）

**Files:**
- Create: `src/tools/list-files.ts`
- Create: `src/tools/grep-files.ts`

- [ ] **Step 1：创建 src/tools/list-files.ts**

```typescript
/**
 * list_files — 列举目录内容
 *
 * [K-21] 用 readdir withFileTypes 区分文件和目录。
 * 最多返回 200 条，防止超大目录淹没上下文。
 */
import { readdir } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

type Input = { path?: string }

export const listFilesTool: ToolDefinition<Input> = {
  name: 'list_files',
  description: 'List files in a directory relative to the workspace root.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to cwd (default: ".")' },
    },
  },
  schema: z.object({ path: z.string().optional() }),
  async run(input, context) {
    const target = await resolveToolPath(context, input.path ?? '.', 'list')
    const entries = await readdir(target, { withFileTypes: true })
    const lines = entries
      .slice(0, 200)
      .map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)

    return { ok: true, output: lines.join('\n') || '(empty)' }
  },
}
```

- [ ] **Step 2：创建 src/tools/grep-files.ts**

```typescript
/**
 * grep_files — 跨文件正则搜索
 *
 * [K-22] 依赖 ripgrep (rg) 实现高性能跨文件搜索。
 * 无 rg 时给出安装提示，而非静默失败。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

const execFileAsync = promisify(execFile)

type Input = { pattern: string; path?: string }

export const grepFilesTool: ToolDefinition<Input> = {
  name: 'grep_files',
  description: 'Search for text in files using ripgrep (rg).',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory or file to search (default: workspace root)' },
    },
    required: ['pattern'],
  },
  schema: z.object({ pattern: z.string().min(1), path: z.string().optional() }),
  async run(input, context) {
    const args = ['-n', '--no-heading', input.pattern]
    if (input.path) {
      args.push(await resolveToolPath(context, input.path, 'search'))
    } else {
      args.push('.')
    }

    try {
      const result = await execFileAsync('rg', args, {
        cwd: context.cwd,
        maxBuffer: 1024 * 1024,
      })
      return { ok: true, output: (result.stdout || result.stderr || '').trim() || '(no matches)' }
    } catch (error) {
      // rg 无匹配时以非零状态码退出，但这不是工具错误
      if (error && typeof error === 'object' && 'stdout' in error) {
        const out = ((error as { stdout?: unknown }).stdout as string | undefined ?? '').trim()
        const err = ((error as { stderr?: unknown }).stderr as string | undefined ?? '').trim()
        if (err.includes('command not found') || err.includes('not found')) {
          return { ok: false, output: 'ripgrep (rg) 未安装。请运行: brew install ripgrep' }
        }
        return { ok: true, output: out || '(no matches)' }
      }
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  },
}
```

- [ ] **Step 3：TypeScript 验证**

```bash
npx tsc --noEmit
```

- [ ] **Step 4：Commit**

```bash
git add src/tools/list-files.ts src/tools/grep-files.ts
git commit -m "feat(phase4): add list-files and grep-files tools"
```

---

## Task 11：实现命令执行工具（run-command）

**Files:**
- Create: `src/tools/run-command.ts`

**[K-23] child_process spawn + 超时控制 + 权限门控。**

- [ ] **Step 1：创建 src/tools/run-command.ts**

```typescript
/**
 * run_command — 执行 shell 命令
 *
 * [K-23] 设计要点：
 * 1. shell=false 避免 shell 注入（直接 spawn 命令，不通过 /bin/sh）
 * 2. SIGTERM 超时控制（默认 30s）
 * 3. 只读命令（pwd/ls/grep 等）直接放行；危险命令触发 permissions.ensureCommand
 * 4. background=true 时以分离模式运行，注册到 background-tasks
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { registerBackgroundShellTask } from '../background-tasks.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

const execFileAsync = promisify(execFile)

// 只读命令：直接放行，无需权限确认
const READONLY_COMMANDS = new Set([
  'pwd', 'ls', 'find', 'rg', 'grep', 'cat', 'head', 'tail',
  'wc', 'sed', 'echo', 'df', 'du', 'free', 'uname', 'uptime', 'whoami',
])

// 开发常用命令：允许执行但危险操作仍需权限
const DEVELOPMENT_COMMANDS = new Set([
  'git', 'npm', 'node', 'python3', 'pytest', 'bash', 'sh', 'bun',
])

function isAllowedCommand(command: string): boolean {
  return READONLY_COMMANDS.has(command) || DEVELOPMENT_COMMANDS.has(command)
}

/**
 * 简易命令行解析：处理单/双引号和反斜杠转义。
 */
function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of commandLine) {
    if (escaping) { current += char; escaping = false; continue }
    if (char === '\\') { escaping = true; continue }
    if (quote) { if (char === quote) { quote = null } else { current += char }; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === ' ' || char === '\t') {
      if (current) { parts.push(current); current = '' }
      continue
    }
    current += char
  }
  if (current) parts.push(current)
  return parts
}

type Input = {
  command: string
  args?: string[]
  cwd?: string
  background?: boolean
  timeout?: number
}

export const runCommandTool: ToolDefinition<Input> = {
  name: 'run_command',
  description:
    'Execute a shell command. Supports read-only commands freely; dangerous commands require approval. ' +
    'Set background=true for long-running processes.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Command name or full command line' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command arguments' },
      cwd: { type: 'string', description: 'Working directory (default: workspace cwd)' },
      background: { type: 'boolean', description: 'Run in background (default: false)' },
      timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
    },
    required: ['command'],
  },
  schema: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    background: z.boolean().optional(),
    timeout: z.number().int().min(1).optional(),
  }),
  async run(input, context) {
    // 解析命令行
    const parts = input.args !== undefined
      ? [input.command, ...input.args]
      : splitCommandLine(input.command)

    const [cmd, ...cmdArgs] = parts
    if (!cmd) return { ok: false, output: '命令为空' }

    if (!isAllowedCommand(cmd)) {
      return { ok: false, output: `命令不在允许列表中: ${cmd}。只允许: ${[...READONLY_COMMANDS, ...DEVELOPMENT_COMMANDS].join(', ')}` }
    }

    // 解析运行目录
    const commandCwd = input.cwd
      ? await resolveToolPath(context, input.cwd, 'command_cwd' as 'read')
      : context.cwd

    // [K-29] 危险命令权限检查
    if (!READONLY_COMMANDS.has(cmd) && context.permissions) {
      const reason = `执行 ${[cmd, ...cmdArgs].join(' ')}`
      await context.permissions.ensureCommand(cmd, cmdArgs, commandCwd, reason)
    }

    const timeoutMs = input.timeout ?? 30_000

    // 后台模式：spawn 分离进程，立即返回 taskId
    if (input.background) {
      const proc = spawn(cmd, cmdArgs, {
        cwd: commandCwd,
        detached: true,
        stdio: 'ignore',
      })
      proc.unref()
      if (!proc.pid) {
        return { ok: false, output: `启动后台进程失败: ${cmd}` }
      }
      const task = registerBackgroundShellTask({
        command: [cmd, ...cmdArgs].join(' '),
        pid: proc.pid,
        cwd: commandCwd,
      })
      return {
        ok: true,
        output: `已在后台启动 (taskId: ${task.taskId}, pid: ${task.pid})`,
      }
    }

    // 前台模式：等待命令完成
    try {
      const result = await execFileAsync(cmd, cmdArgs, {
        cwd: commandCwd,
        maxBuffer: 1024 * 1024 * 5, // 5MB
        timeout: timeoutMs,
      })
      return {
        ok: true,
        output: (result.stdout + result.stderr).trim() || '(no output)',
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'stdout' in error) {
        const stdout = (error as { stdout?: unknown }).stdout as string ?? ''
        const stderr = (error as { stderr?: unknown }).stderr as string ?? ''
        const output = (stdout + stderr).trim()
        if (output) return { ok: false, output }
      }
      if (error instanceof Error && error.message.includes('TIMEDOUT')) {
        return { ok: false, output: `命令超时 (${timeoutMs}ms): ${cmd}` }
      }
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  },
}
```

- [ ] **Step 2：TypeScript 编译验证**

```bash
npx tsc --noEmit
```

- [ ] **Step 3：Commit**

```bash
git add src/tools/run-command.ts
git commit -m "feat(phase4): add run-command tool with permission gating and background mode"
```

---

## Task 12：实现网络工具（web-fetch, web-search）

**Files:**
- Create: `src/tools/web-fetch.ts`
- Create: `src/tools/web-search.ts`

- [ ] **Step 1：创建 src/tools/web-fetch.ts**

```typescript
/**
 * web_fetch — 抓取网页可读文本
 *
 * [K-24] 用 utils/web.ts 的 fetchWebPage 抓取 URL，
 * HTML 转纯文本后按 max_chars 截断。
 */
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { fetchWebPage } from '../utils/web.js'

type Input = { url: string; max_chars?: number }

export const webFetchTool: ToolDefinition<Input> = {
  name: 'web_fetch',
  description:
    'Fetch a web page and extract its readable text content. ' +
    'Use after web_search when you need the full content of a specific page.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
      max_chars: { type: 'number', description: 'Max characters to return (default: 12000)' },
    },
    required: ['url'],
  },
  schema: z.object({ url: z.string().url(), max_chars: z.number().int().min(500).optional() }),
  async run(input) {
    try {
      const result = await fetchWebPage({ url: input.url, maxChars: input.max_chars ?? 12_000 })
      if (result.status >= 400) {
        return { ok: false, output: `HTTP ${result.status} ${result.statusText}: ${input.url}` }
      }
      const lines = [
        `URL: ${result.finalUrl}`,
        `STATUS: ${result.status}`,
        `CONTENT_TYPE: ${result.contentType}`,
      ]
      if (result.title) lines.push(`TITLE: ${result.title}`)
      lines.push('', result.content)
      return { ok: true, output: lines.join('\n') }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  },
}
```

- [ ] **Step 2：创建 src/tools/web-search.ts**

```typescript
/**
 * web_search — 网页搜索
 *
 * [K-25] 封装 searchDuckDuckGoLite（DuckDuckGo Lite + Sogou 双后备），
 * 返回结构化搜索结果供模型进一步 web_fetch。
 */
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { searchDuckDuckGoLite } from '../utils/web.js'

type Input = { query: string; max_results?: number }

export const webSearchTool: ToolDefinition<Input> = {
  name: 'web_search',
  description:
    'Search the web for information. Returns links and snippets. ' +
    'Use web_fetch to read the full content of specific pages.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'number', description: 'Max results to return (default: 5)' },
    },
    required: ['query'],
  },
  schema: z.object({ query: z.string().min(1), max_results: z.number().int().min(1).max(10).optional() }),
  async run(input) {
    try {
      const result = await searchDuckDuckGoLite({
        query: input.query,
        maxResults: input.max_results ?? 5,
      })
      if (result.organic.length === 0) {
        return { ok: true, output: '(no results)' }
      }
      const lines = result.organic.map((r, i) =>
        `[${i + 1}] ${r.title}\n    URL: ${r.link}\n    ${r.snippet}`,
      )
      return { ok: true, output: lines.join('\n\n') }
    } catch (error) {
      return { ok: false, output: error instanceof Error ? error.message : String(error) }
    }
  },
}
```

- [ ] **Step 3：TypeScript 编译验证**

```bash
npx tsc --noEmit
```

- [ ] **Step 4：Commit**

```bash
git add src/tools/web-fetch.ts src/tools/web-search.ts
git commit -m "feat(phase4): add web-fetch and web-search tools"
```

---

## Task 13：实现 ask-user 和 load-skill 工具

**Files:**
- Create: `src/tools/ask-user.ts`
- Create: `src/tools/load-skill.ts`

- [ ] **Step 1：创建 src/tools/ask-user.ts**

```typescript
/**
 * ask_user — 向用户提问并暂停 Agent Loop
 *
 * [K-26] awaitUser: true 信号让 Agent Loop 停止本轮循环，
 * 把 question 以 assistant 身份展示给用户，等待用户回复后继续。
 */
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'

type Input = { question: string }

export const askUserTool: ToolDefinition<Input> = {
  name: 'ask_user',
  description:
    'Ask the user a clarifying question and stop the current turn until the user replies.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
    },
    required: ['question'],
  },
  schema: z.object({ question: z.string().min(1) }),
  async run(input) {
    return {
      ok: true,
      output: input.question.trim(),
      awaitUser: true,  // [K-26] 发出暂停信号
    }
  },
}
```

- [ ] **Step 2：创建 src/tools/load-skill.ts**

```typescript
/**
 * load_skill — 动态加载 skill 文件内容
 *
 * [K-27] 运行时把 skill 的 Markdown 内容注入到对话，
 * 让模型能遵循特定工作流指令。
 */
import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'
import { loadSkill } from '../skills.js'

type Input = { name: string }

export function createLoadSkillTool(cwd: string): ToolDefinition<Input> {
  return {
    name: 'load_skill',
    description:
      'Load the full contents of a named SKILL.md file so you can follow that workflow accurately.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (without .md extension)' },
      },
      required: ['name'],
    },
    schema: z.object({ name: z.string().min(1) }),
    async run(input) {
      const skill = await loadSkill(cwd, input.name)
      if (!skill) {
        return { ok: false, output: `未知 skill: ${input.name}` }
      }
      return {
        ok: true,
        output: [
          `SKILL: ${skill.name}`,
          `SOURCE: ${skill.source}`,
          `PATH: ${skill.path}`,
          '',
          skill.content,
        ].join('\n'),
      }
    },
  }
}
```

- [ ] **Step 3：测试 ask_user awaitUser 信号**

```typescript
// 在 src/tools/ask-user.test.ts
import { describe, it, expect } from 'vitest'
import { askUserTool } from './ask-user.js'

describe('ask_user', () => {
  it('返回 awaitUser: true 信号', async () => {
    const result = await askUserTool.run({ question: '你确定吗？' }, { cwd: '/' })
    expect(result.ok).toBe(true)
    expect(result.awaitUser).toBe(true)
    expect(result.output).toBe('你确定吗？')
  })
})
```

```bash
npx vitest run src/tools/ask-user.test.ts
```

期望：测试通过

- [ ] **Step 4：TypeScript 编译验证**

```bash
npx tsc --noEmit
```

- [ ] **Step 5：Commit**

```bash
git add src/tools/ask-user.ts src/tools/ask-user.test.ts src/tools/load-skill.ts
git commit -m "feat(phase4): add ask-user (awaitUser signal) and load-skill tools"
```

---

## Task 14：组装工具注册表（tools/index.ts）

**Files:**
- Create: `src/tools/index.ts`

**[K-28] 把所有内置工具注册到 ToolRegistry，供 Agent Loop 使用。**

- [ ] **Step 1：创建 src/tools/index.ts**

```typescript
/**
 * tools/index.ts — 工具注册表组装
 *
 * [K-28] 集中注册所有内置工具。
 * Phase 5 会扩展：加入 MCP 动态工具、完整 skill 列表。
 */
import { ToolRegistry } from '../tool.js'
import { askUserTool } from './ask-user.js'
import { editFileTool } from './edit-file.js'
import { grepFilesTool } from './grep-files.js'
import { createLoadSkillTool } from './load-skill.js'
import { listFilesTool } from './list-files.js'
import { modifyFileTool } from './modify-file.js'
import { patchFileTool } from './patch-file.js'
import { readFileTool } from './read-file.js'
import { runCommandTool } from './run-command.js'
import { webFetchTool } from './web-fetch.js'
import { webSearchTool } from './web-search.js'
import { writeFileTool } from './write-file.js'

/**
 * 创建包含所有内置工具的 ToolRegistry。
 *
 * @param args.cwd - 工作目录（load-skill 工具需要）
 */
export function createDefaultToolRegistry(args: { cwd: string }): ToolRegistry {
  return new ToolRegistry([
    askUserTool,
    listFilesTool,
    grepFilesTool,
    readFileTool,
    writeFileTool,
    modifyFileTool,
    editFileTool,
    patchFileTool,
    runCommandTool,
    createLoadSkillTool(args.cwd),
    webFetchTool,
    webSearchTool,
  ])
}
```

- [ ] **Step 2：TypeScript 全量编译验证**

```bash
npx tsc --noEmit
```

期望：无报错

- [ ] **Step 3：运行所有测试**

```bash
npx vitest run
```

期望：全部测试通过

- [ ] **Step 4：Commit**

```bash
git add src/tools/index.ts
git commit -m "feat(phase4): assemble createDefaultToolRegistry with all 12 built-in tools"
```

---

## Task 15：端到端验证

**Files:**
- Create: `src/tools/integration.test.ts`（测试文件，不进入生产 build）

**可验证里程碑：** Agent 自主读取文件 → 修改 → 写回，全程通过 ToolRegistry 执行。

- [ ] **Step 1：写集成测试（用 MockModelAdapter 模拟 Agent 行为）**

创建 `src/tools/integration.test.ts`：

```typescript
/**
 * 集成测试：ToolRegistry + runAgentTurn + MockModelAdapter
 * 验证 Phase 4 工具层在 Agent Loop 中能正常工作。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, afterEach } from 'vitest'
import { MockModelAdapter } from '../mock-model.js'
import { runAgentTurn } from '../agent-loop.js'
import { createDefaultToolRegistry } from './index.js'

let tmpDir: string

afterEach(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

describe('Phase 4 集成：read → edit → verify', () => {
  it('Agent 通过工具链完成读改写任务', async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'p4-integration-'))
    const filePath = path.join(tmpDir, 'target.txt')
    await writeFile(filePath, 'hello world', 'utf8')

    const tools = createDefaultToolRegistry({ cwd: tmpDir })

    // Mock 模型模拟：先 read_file，再 write_file，最后给出 final 响应
    const model = new MockModelAdapter([
      {
        type: 'tool_calls',
        calls: [{ toolName: 'read_file', input: { path: 'target.txt' } }],
      },
      {
        type: 'tool_calls',
        calls: [{ toolName: 'write_file', input: { path: 'target.txt', content: 'hello mini-code' } }],
      },
      {
        type: 'assistant',
        content: '<final>文件已更新为 "hello mini-code"',
        kind: 'final',
      },
    ])

    const finalMessages = await runAgentTurn({
      model,
      tools,
      messages: [{ role: 'user', content: '把 target.txt 的内容改成 "hello mini-code"' }],
      cwd: tmpDir,
    })

    // 验证文件确实被写入
    const content = await readFile(filePath, 'utf8')
    expect(content).toBe('hello mini-code')

    // 验证消息历史里有 final 响应
    const lastMsg = finalMessages.at(-1)
    expect(lastMsg?.role).toBe('assistant')
    expect(lastMsg?.content).toContain('hello mini-code')
  })
})
```

- [ ] **Step 2：运行集成测试**

```bash
npx vitest run src/tools/integration.test.ts
```

期望：测试通过

- [ ] **Step 3：运行全量测试**

```bash
npx vitest run
```

期望：全部通过

- [ ] **Step 4：最终 Commit**

```bash
git add src/tools/integration.test.ts
git commit -m "test(phase4): add integration test for read-edit-write agent flow"
```

---

## 验收标准

| 验收项 | 方法 |
|--------|------|
| TypeScript 编译无报错 | `npx tsc --noEmit` |
| 所有单元测试通过 | `npx vitest run` |
| 12 个工具均已注册 | 检查 `createDefaultToolRegistry` 返回的 `tools.list().length === 12` |
| write/edit 工具走 diff 审查 | 集成测试中 `applyReviewedFileChange` 被调用 |
| ask_user 返回 awaitUser:true | ask-user.test.ts 通过 |
| 权限管理器类型安全 | `PermissionManager implements PermissionManagerLike` 无类型错误 |

---

## 知识点覆盖

| 知识点 | 代码位置 |
|--------|---------|
| K-16 Node.js fs/promises | `read-file.ts`, `write-file.ts` |
| K-17 原子写入 | `file-review.ts` applyReviewedFileChange |
| K-18 字符串精确替换 | `edit-file.ts` |
| K-19 Unified Diff | `file-review.ts` buildUnifiedDiff |
| K-20 多块编辑合并 | `patch-file.ts` |
| K-21 递归遍历 | `list-files.ts` |
| K-22 正则搜索 + 截断 | `grep-files.ts` |
| K-23 child_process spawn + 超时 | `run-command.ts` |
| K-24 HTML → 纯文本 | `utils/web.ts` fetchWebPage |
| K-25 搜索 API 封装 | `utils/web.ts` searchDuckDuckGoLite |
| K-26 awaitUser 信号机制 | `ask-user.ts` |
| K-27 动态指令注入 | `load-skill.ts` |
| K-28 工具注册表组装 | `tools/index.ts` |
| K-29 多维度权限模型 | `permissions.ts` |
| K-30 diff 可视化 | `file-review.ts` |
| K-31 后台进程生命周期 | `background-tasks.ts` |
