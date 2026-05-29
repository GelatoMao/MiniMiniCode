/**
 * run_command — 执行 shell 命令
 *
 * [K-23] 设计要点：
 * 1. shell=false — execFile/spawn 直接执行，不通过 /bin/sh，避免 shell 注入
 * 2. SIGTERM 超时控制（默认 30s）
 * 3. 只读命令（pwd/ls/grep 等）直接放行；危险命令需 permissions.ensureCommand
 * 4. background=true 时以分离模式运行，注册到 background-tasks 注册表
 */
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { registerBackgroundShellTask } from '../background-tasks.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

const execFileAsync = promisify(execFile)

// ── 命令分类 ──────────────────────────────────────────────────────────────

/** 只读命令：直接放行，无需权限确认 */
const READONLY_COMMANDS = new Set([
  'pwd', 'ls', 'find', 'rg', 'grep', 'cat', 'head', 'tail',
  'wc', 'sed', 'echo', 'df', 'du', 'free', 'uname', 'uptime', 'whoami',
])

/** 开发常用命令：允许执行，但危险参数仍需权限 */
const DEVELOPMENT_COMMANDS = new Set([
  'git', 'npm', 'node', 'python3', 'pytest', 'bash', 'sh', 'bun',
])

function isAllowedCommand(command: string): boolean {
  return READONLY_COMMANDS.has(command) || DEVELOPMENT_COMMANDS.has(command)
}

// ── 命令行解析 ────────────────────────────────────────────────────────────

/**
 * 简易命令行解析：处理单/双引号和反斜杠转义。
 * 当 input.args 未提供时，用此函数解析 input.command 字符串。
 */
function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of commandLine) {
    if (escaping) { current += char; escaping = false; continue }
    if (char === '\\') { escaping = true; continue }
    if (quote) {
      if (char === quote) { quote = null } else { current += char }
      continue
    }
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

// ── Tool 定义 ─────────────────────────────────────────────────────────────

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
    'Execute a shell command. Read-only commands run freely; dangerous commands require approval. ' +
    'Set background=true for long-running processes.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Command name or full command line string',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command arguments (optional; if omitted, command is parsed as shell line)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the command (default: workspace cwd)',
      },
      background: {
        type: 'boolean',
        description: 'Run as detached background process and return taskId immediately',
      },
      timeout: {
        type: 'number',
        description: 'Execution timeout in milliseconds (default: 30000)',
      },
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
    // 解析命令和参数
    const parts = input.args !== undefined
      ? [input.command, ...input.args]
      : splitCommandLine(input.command)

    const [cmd, ...cmdArgs] = parts
    if (!cmd) return { ok: false, output: '命令为空' }

    if (!isAllowedCommand(cmd)) {
      return {
        ok: false,
        output: `命令不在允许列表中: ${cmd}。` +
          `允许: ${[...READONLY_COMMANDS, ...DEVELOPMENT_COMMANDS].join(', ')}`,
      }
    }

    // 解析运行目录（支持相对路径）
    const commandCwd = input.cwd
      ? await resolveToolPath(context, input.cwd, 'read')
      : context.cwd

    // [K-29] 非只读命令需要权限检查
    if (!READONLY_COMMANDS.has(cmd) && context.permissions) {
      const reason = `执行 ${[cmd, ...cmdArgs].join(' ')}`
      await context.permissions.ensureCommand(cmd, cmdArgs, commandCwd, reason)
    }

    const timeoutMs = input.timeout ?? 30_000

    // ── 后台模式 ────────────────────────────────────────────────────────────
    if (input.background) {
      const proc = spawn(cmd, cmdArgs, {
        cwd: commandCwd,
        detached: true,  // 进程与父进程分离
        stdio: 'ignore', // 不持有任何 fd，父进程退出不影响子进程
      })
      proc.unref() // 允许父进程退出而无需等待子进程

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

    // ── 前台模式 ────────────────────────────────────────────────────────────
    try {
      const result = await execFileAsync(cmd, cmdArgs, {
        cwd: commandCwd,
        maxBuffer: 1024 * 1024 * 5, // 5MB 输出上限
        timeout: timeoutMs,
      })
      return {
        ok: true,
        output: (result.stdout + result.stderr).trim() || '(no output)',
      }
    } catch (error) {
      // execFile 失败时 error 对象包含 stdout/stderr
      if (error && typeof error === 'object') {
        const stdout = ((error as { stdout?: unknown }).stdout as string | undefined ?? '')
        const stderr = ((error as { stderr?: unknown }).stderr as string | undefined ?? '')
        const output = (stdout + stderr).trim()
        if (output) return { ok: false, output }
      }
      if (error instanceof Error && error.message.includes('TIMEDOUT')) {
        return { ok: false, output: `命令超时 (${timeoutMs}ms): ${cmd}` }
      }
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
