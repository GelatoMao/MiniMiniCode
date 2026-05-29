import { z } from 'zod'

/**
 * [K-29] PermissionManagerLike：权限管理器接口
 *
 * 用接口而非具体类型，避免 tool.ts ↔ permissions.ts 循环依赖。
 * permissions.ts 中的 PermissionManager 实现此接口。
 */
export type PermissionManagerLike = {
  ensurePathAccess(
    targetPath: string,
    intent: 'read' | 'write' | 'list' | 'search' | 'command_cwd',
  ): Promise<void>
  ensureCommand(
    command: string,
    args: string[],
    cwd: string,
    reason: string,
    opts?: { forcePromptReason?: string },
  ): Promise<void>
  ensureEdit(targetPath: string, diffPreview: string): Promise<void>
  resetTurn(): void
}

/**
 * [K-05] ToolContext：工具执行时的运行时环境
 *
 * 通过依赖注入而非全局变量传递，方便测试隔离。
 */
export type ToolContext = {
  /** 工具操作的工作目录 */
  cwd: string
  /** [K-29] 可选权限管理器；无时默认仅限 workspace 内路径访问 */
  permissions?: PermissionManagerLike
}

/**
 * [K-26] ToolResult：工具执行结果
 *
 * awaitUser = true 时，Agent Loop 会暂停并等待用户输入，
 * 而不是继续下一步推理。这是实现"ask_user"工具的核心机制。
 */
export type ToolResult = {
  ok: boolean
  output: string
  /** true = 工具希望 Agent Loop 暂停，等待用户响应 */
  awaitUser?: boolean
}

/**
 * [K-03] ToolDefinition<TInput>：单个工具的完整描述
 *
 * 泛型参数 TInput 代表经过 Zod 验证后的输入类型。
 * 这样 run() 的参数类型是已验证的安全类型，无需内部再做防御性判断。
 *
 * 字段分工：
 * - name/description/inputSchema → 发送给 LLM 的工具描述（JSON Schema 格式）
 * - schema                       → 运行时 Zod 验证器（[K-02]）
 * - run                          → 实际执行逻辑
 */
export type ToolDefinition<TInput> = {
  name: string
  description: string
  /** JSON Schema 格式，直接传给 LLM API 的 tools 字段 */
  inputSchema: Record<string, unknown>
  /**
   * [K-02] Zod schema 用于运行时验证 LLM 传入的 input
   *
   * 为什么需要运行时验证？
   * TypeScript 类型只在编译期存在，LLM 返回的 JSON 是 unknown 类型。
   * Zod 的 .safeParse() 在运行时桥接了两者：
   *   unknown → 验证失败返回错误  → 返回 {ok: false} 给 LLM
   *   unknown → 验证成功返回 data → 类型为 TInput，安全调用 run()
   */
  schema: z.ZodType<TInput>
  run(input: TInput, context: ToolContext): Promise<ToolResult>
}

/**
 * [K-03] ToolRegistry：工具注册表（Registry Pattern）
 *
 * 集中管理所有工具的注册、查找和执行。
 * Agent Loop 只通过 ToolRegistry 与工具交互，不直接引用任何具体工具。
 *
 * 优点（对应 SOLID 原则）：
 * - 单一职责（S）：工具的注册/执行逻辑集中于此
 * - 开放/封闭（O）：添加新工具只需调用 addTools()，无需修改 ToolRegistry
 * - 依赖倒置（D）：Agent Loop 依赖 ToolRegistry 抽象，不依赖具体工具
 */
export class ToolRegistry {
  // 用 unknown 而非具体泛型，允许存储任意 TInput 的工具
  private readonly toolsStore: ToolDefinition<unknown>[]
  private disposers: Array<() => Promise<void>> = []

  constructor(tools: ToolDefinition<unknown>[] = []) {
    this.toolsStore = [...tools]
  }

  /** 返回所有已注册工具（用于发送给 LLM） */
  list(): ToolDefinition<unknown>[] {
    return this.toolsStore
  }

  /** 按名称查找工具，不存在时返回 undefined */
  find(name: string): ToolDefinition<unknown> | undefined {
    return this.toolsStore.find(tool => tool.name === name)
  }

  /**
   * 批量添加工具，自动跳过同名重复项
   * [K-03] 幂等性：重复调用不会导致工具被注册多次
   */
  addTools(nextTools: ToolDefinition<unknown>[]): void {
    const existingNames = new Set(this.toolsStore.map(tool => tool.name))
    for (const tool of nextTools) {
      if (existingNames.has(tool.name)) continue
      this.toolsStore.push(tool)
      existingNames.add(tool.name)
    }
  }

  /** 注册清理函数（例如 MCP 连接关闭），dispose() 时批量调用 */
  addDisposer(fn: () => Promise<void>): void {
    this.disposers.push(fn)
  }

  /** 关闭所有已注册的清理资源 */
  async dispose(): Promise<void> {
    await Promise.all(this.disposers.map(fn => fn()))
  }

  /** Phase 5 MCP 占位：存储 server 摘要 */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setMcpServers(_servers: unknown[]): void {
    // Phase 5 实现
  }

  /**
   * [K-02] 执行工具：查找 → Zod 验证 → run()
   *
   * 验证失败时返回 {ok: false}，让 LLM 知道参数有误并重试。
   * 异常捕获将运行时错误转为结构化结果，Agent Loop 无需感知异常。
   */
  async execute(
    toolName: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.find(toolName)
    if (!tool) {
      return { ok: false, output: `未知工具: ${toolName}` }
    }

    // [K-02] .safeParse() 不抛异常，通过返回值区分成功/失败
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
}
