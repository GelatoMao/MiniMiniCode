/**
 * background-tasks.ts — 后台 shell 任务注册表
 *
 * [K-31] run_command 工具以后台模式启动命令时，
 * 通过 registerBackgroundShellTask 记录进程信息。
 *
 * 状态追踪策略：
 * - process.kill(pid, 0) 探活：不发送真实信号，只检查进程是否存在
 * - ESRCH 错误 = 进程不存在 → completed
 * - 其他错误 → failed
 * - 无错误 = 进程存活 → running
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
  // shell_ + 时间戳(36进制) + 随机6位，兼顾唯一性和可读性
  return `shell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 用 process.kill(pid, 0) 刷新运行中任务的状态。
 * 只修改 running 状态的记录，其他状态直接返回。
 */
function refreshRecord(record: BackgroundTaskRecord): BackgroundTaskRecord {
  if (record.status !== 'running') return record

  try {
    process.kill(record.pid, 0)
    return record // 进程存活，保持 running
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
 * 进程已退出时静默忽略。
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
