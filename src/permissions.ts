/**
 * permissions.ts — 多维度权限管理系统
 *
 * [K-29] 三个维度的权限控制：
 * - path：文件系统路径访问权限
 * - command：shell 命令执行权限
 * - edit：文件编辑审查权限
 *
 * 四种生命周期（优先级从高到低）：
 * - allow_once / deny_once：本次操作，记录在 session 集合
 * - allow_turn / allow_all_turn：本轮 Agent 回合有效
 * - allow_always / deny_always：持久化到磁盘，下次启动仍有效
 * - deny_with_feedback：拒绝并把用户 feedback 文字传给模型
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MINI_CODE_DIR } from './config.js'
import type { PermissionManagerLike } from './tool.js'
import { isEnoentError } from './utils/errors.js'

// ── 公开类型 ──────────────────────────────────────────────────────────────

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

// ── 持久化格式 ────────────────────────────────────────────────────────────

type PermissionStore = {
  allowedDirectoryPrefixes?: string[]
  deniedDirectoryPrefixes?: string[]
  allowedCommandPatterns?: string[]
  deniedCommandPatterns?: string[]
  allowedEditPatterns?: string[]
  deniedEditPatterns?: string[]
}

const PERMISSIONS_PATH = path.join(MINI_CODE_DIR, 'permissions.json')

// ── 辅助函数 ──────────────────────────────────────────────────────────────

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
    if (isWithinDirectory(directory, targetPath)) return true
  }
  return false
}

function formatCommandSignature(command: string, args: string[]): string {
  return [command, ...args].join(' ').trim()
}

/**
 * 识别危险命令并返回风险说明字符串；安全命令返回 null。
 *
 * [K-23] 危险命令列表与 Claude Code 保持对齐：
 * git reset --hard / git clean / rm / sudo / chmod / curl 等。
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
    if (normalizedArgs.includes('checkout') && normalizedArgs.some(a => a.startsWith('--'))) {
      return `git checkout 带 -- 参数可能覆盖工作区文件 (${signature})`
    }
  }

  if (command === 'rm') return `rm 会永久删除文件 (${signature})`
  if (command === 'sudo') return `sudo 以提升权限执行 (${signature})`
  if (command === 'chmod' || command === 'chown') return `${command} 修改权限/所有者 (${signature})`
  if (command === 'curl' || command === 'wget') return `${command} 发起网络请求 (${signature})`

  return null
}

// ── PermissionManager 核心类 ──────────────────────────────────────────────

/**
 * [K-29] PermissionManager：三维度权限管理器
 *
 * 实现 PermissionManagerLike 接口，允许通过接口注入到 ToolContext，
 * 避免工具代码直接依赖此具体类。
 *
 * 生命周期优先级（从高到低检查）：
 * 1. turnAllowAllEdits — 本轮全局编辑许可
 * 2. session denied/allowed — 进程内有效
 * 3. turn allowed — 本轮有效
 * 4. persisted allowed/denied — 持久化磁盘
 * 5. 触发 prompt（无 prompt 时直接放行或报错）
 */
export class PermissionManager implements PermissionManagerLike {
  // ── 持久化集合（磁盘读取后填充）──────────────
  private allowedDirectoryPrefixes = new Set<string>()
  private deniedDirectoryPrefixes = new Set<string>()
  private allowedCommandPatterns = new Set<string>()
  private deniedCommandPatterns = new Set<string>()
  private allowedEditPatterns = new Set<string>()
  private deniedEditPatterns = new Set<string>()

  // ── Session 级别（进程内有效）────────────────
  private sessionAllowedPaths = new Set<string>()
  private sessionDeniedPaths = new Set<string>()
  private sessionAllowedCommands = new Set<string>()
  private sessionDeniedCommands = new Set<string>()
  private sessionAllowedEdits = new Set<string>()
  private sessionDeniedEdits = new Set<string>()

  // ── Turn 级别（单次 Agent 回合有效）──────────
  private turnAllowedEdits = new Set<string>()
  private turnAllowAllEdits = false

  private readonly prompt: PermissionPromptHandler | null
  /** 延迟加载 Promise：确保磁盘状态只读取一次 */
  private readonly ready: Promise<void>

  constructor(prompt: PermissionPromptHandler | null = null) {
    this.prompt = prompt
    this.ready = this.load()
  }

  /** 从磁盘加载持久化权限数据 */
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
      // 文件不存在时正常：首次运行，使用空权限集
    }
  }

  /** 把当前持久化集合写入磁盘 */
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

  /** 回合结束时调用：清除 turn 级别权限 */
  resetTurn(): void {
    this.turnAllowedEdits.clear()
    this.turnAllowAllEdits = false
  }

  // ── 路径权限 ────────────────────────────────────────────────────────────

  async ensurePathAccess(targetPath: string, _intent: PathIntent): Promise<void> {
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
      // 无交互模式：默认允许（依赖 resolveToolPath 的 workspace 边界）
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

    if (result.decision === 'allow_once') { this.sessionAllowedPaths.add(normalized); return }
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
    if (this.sessionAllowedCommands.has(signature) || this.allowedCommandPatterns.has(signature)) {
      return
    }

    const danger = classifyDangerousCommand(command, args)
    if (!danger) return // 非危险命令直接放行

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

    if (result.decision === 'allow_once') { this.sessionAllowedCommands.add(signature); return }
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

    if (this.sessionDeniedEdits.has(normalized) || this.deniedEditPatterns.has(normalized)) {
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
      // 无交互模式：直接允许（Phase 6 TUI 会传入 prompt）
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

    if (result.decision === 'allow_once') { this.sessionAllowedEdits.add(normalized); return }
    if (result.decision === 'allow_turn') { this.turnAllowedEdits.add(normalized); return }
    if (result.decision === 'allow_all_turn') { this.turnAllowAllEdits = true; return }
    if (result.decision === 'allow_always') {
      this.allowedEditPatterns.add(normalized)
      await this.persist()
      return
    }
    if (result.decision === 'deny_with_feedback') {
      const guidance = result.feedback?.trim()
      if (guidance) throw new Error(`编辑被拒绝: ${normalized}\n用户反馈: ${guidance}`)
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
