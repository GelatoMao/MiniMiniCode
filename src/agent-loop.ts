/**
 * [K-10] ReAct Agent 主循环
 *
 * ReAct = Reason（推理）+ Act（工具执行）反复迭代，直到任务完成。
 *
 * 核心控制流：
 *   for step in maxSteps:
 *     next = model.next(messages)
 *     if next.type === 'assistant' → （可能重试或）退出循环
 *     if next.type === 'tool_calls' → 顺序执行工具，追加消息，继续
 */
import type { ChatMessage, ModelAdapter, ProviderThinkingBlock } from './types.js'
import type { ToolRegistry } from './tool.js'

// ── 内部辅助 ─────────────────────────────────────────────────────────────────

// 检测模型是否返回了空文本
function isEmptyAssistantResponse(content: string): boolean {
  return content.trim().length === 0
}

/**
 * [K-14] Thinking Block 跨轮次保留
 *
 * Extended Thinking 块必须保留在消息历史里，模型才能"接续思考"。
 * 如果清除了 thinking 块，下一轮 API 会报告"thinking block 丢失"错误。
 */
function appendThinkingBlocks(
  messages: ChatMessage[],
  blocks: ProviderThinkingBlock[] | undefined,
): ChatMessage[] {
  if (!blocks || blocks.length === 0) return messages
  return [...messages, { role: 'assistant_thinking', blocks }]
}

/**
 * [K-12] 判断是否为可恢复的 Thinking 阶段停止
 *
 * 触发条件：模型在 thinking 阶段触发 pause_turn 或 max_tokens，
 * 文本内容为空（因为只有 thinking 块，没有文本输出）。
 * 此时应注入 continuation prompt 让模型继续，而非视为错误。
 */
function isRecoverableThinkingStop(args: {
  isEmpty: boolean
  stopReason?: string
  blockTypes?: string[]
  ignoredBlockTypes?: string[]
}): boolean {
  if (!args.isEmpty) return false
  if (args.stopReason !== 'pause_turn' && args.stopReason !== 'max_tokens') return false
  return (
    (args.blockTypes ?? []).includes('thinking') ||
    (args.ignoredBlockTypes ?? []).includes('thinking')
  )
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * [K-10] ReAct Agent 主循环入口
 *
 * 每次用户输入触发一个"回合（turn）"，本函数驱动该回合内的完整 Reason-Act 迭代：
 *   1. 调用模型，获取下一步响应（assistant 文本 或 tool_calls）
 *   2. 若是 tool_calls，顺序执行工具，将结果追加到消息历史，回到第 1 步
 *   3. 若是 assistant 文本，处理各种边缘情况后退出，返回完整消息历史
 *
 * 返回值：本回合结束时的完整消息历史（含所有中间工具消息），
 * 调用方可直接将其作为下一回合的初始 messages 传入。
 */
export async function runAgentTurn(args: {
  model: ModelAdapter
  tools: ToolRegistry
  messages: ChatMessage[]
  cwd: string
  /** 最大工具调用步数，防止无限循环（默认 100）*/
  maxSteps?: number
  /** 工具开始执行时的回调，用于 UI 展示"正在调用 xxx..." */
  onToolStart?: (toolName: string, input: unknown) => void
  /** 工具执行完毕时的回调，携带输出内容和是否出错标志 */
  onToolResult?: (toolName: string, output: string, isError: boolean) => void
  /** 模型产出最终文本时的回调，用于 UI 展示助手消息 */
  onAssistantMessage?: (content: string) => void
  /** 模型产出中间进度文本时的回调（对应 <progress> 标签），不触发退出循环 */
  onProgressMessage?: (content: string) => void
}): Promise<ChatMessage[]> {
  const maxSteps = args.maxSteps ?? 100

  // messages 在循环中不断追加，使用 let 允许每步重新赋值（immutable 追加风格）
  let messages = args.messages

  // 空响应重试计数：模型偶发返回空文本时，最多重试 2 次再降级
  let emptyResponseRetryCount = 0
  // Thinking 阶段可恢复停止的重试计数，最多 3 次（见 isRecoverableThinkingStop）
  let recoverableThinkingRetryCount = 0
  // 本回合内工具报错总次数，降级消息中用于提示用户
  let toolErrorCount = 0
  // 标记本回合是否至少执行过一次工具，用于区分"纯空响应"和"工具后空响应"
  let sawToolResultThisTurn = false

  // [K-13] 向消息历史追加一条 user 续写提示，驱动模型继续未完成的任务。
  // 以闭包形式捕获 messages，每次调用后更新外层 messages 引用。
  const pushContinuationPrompt = (content: string) => {
    messages = [...messages, { role: 'user', content }]
  }

  // ── 主迭代循环 ──────────────────────────────────────────────────────────────
  for (let step = 0; step < maxSteps; step++) {
    // 向模型发送当前完整消息历史，获取下一步决策
    const next = await args.model.next(messages)

    // ── 分支一：模型返回 assistant 文本（可能是最终回答，也可能是进度或空响应）──
    if (next.type === 'assistant') {
      const isEmpty = isEmptyAssistantResponse(next.content)

      // [K-14] thinking blocks 必须在消息历史中紧跟在触发它们的那轮响应之后。
      // 无论本次响应是否为空，都要先把 thinking blocks 保存进去，
      // 否则下一轮 API 调用会因找不到对应 thinking block 而报错。
      messages = appendThinkingBlocks(messages, next.thinkingBlocks)

      // [K-12] 情形 A：Thinking 阶段中途被打断（pause_turn 或 max_tokens），
      // 此时文本为空是正常的——模型只输出了 thinking 块，还没来得及输出文本。
      // 解决方案：注入续写提示，让模型"接着想"，最多重试 3 次。
      if (
        isRecoverableThinkingStop({
          isEmpty,
          stopReason: next.diagnostics?.stopReason,
          blockTypes: next.diagnostics?.blockTypes,
          ignoredBlockTypes: next.diagnostics?.ignoredBlockTypes,
        }) &&
        recoverableThinkingRetryCount < 3
      ) {
        recoverableThinkingRetryCount++
        const progressContent =
          next.diagnostics?.stopReason === 'max_tokens'
            ? '模型在 thinking 阶段触发 max_tokens，正在继续请求后续步骤...'
            : '模型返回 pause_turn，正在继续请求后续步骤...'
        // 通知 UI 显示进度提示，并记录到消息历史（assistant_progress 不触发退出）
        args.onProgressMessage?.(progressContent)
        messages = [...messages, { role: 'assistant_progress', content: progressContent }]
        pushContinuationPrompt(
          next.diagnostics?.stopReason === 'max_tokens'
            ? '你的上一条响应在思考阶段触发了 max_tokens。请立即继续执行下一个具体工具调用、代码修改，或仅在任务完成时给出明确的 <final> 答案。'
            : '从上一个 pause_turn 处恢复，立即继续执行任务。',
        )
        continue
      }

      // [K-12] 情形 B：普通空响应（非 thinking 中断）。
      // 模型偶发性地返回空文本，注入续写提示重驱动，最多重试 2 次。
      // 根据本回合是否已有工具结果，生成语义更准确的提示内容。
      if (isEmpty && emptyResponseRetryCount < 2) {
        emptyResponseRetryCount++
        pushContinuationPrompt(
          sawToolResultThisTurn
            ? '工具执行后你的上一条响应为空。请立即继续尝试下一个具体步骤、处理工具错误，或仅在任务完成时给出明确的 <final> 答案。'
            : '你的上一条响应为空。请立即继续执行具体工具调用、代码修改，或仅在任务完成时给出明确的 <final> 答案。',
        )
        continue
      }

      // [K-12] 情形 C：重试次数耗尽，仍为空响应 → 优雅降级。
      // 生成人类可读的诊断消息（含工具报错数量），以 assistant 身份追加后退出。
      if (isEmpty) {
        const fallbackContent =
          sawToolResultThisTurn
            ? toolErrorCount > 0
              ? `工具执行后模型返回空响应，已停止当前回合。最近有 ${toolErrorCount} 个工具报错；请重试、调整命令，或要求模型改用其他方案。`
              : '工具执行后模型返回空响应，已停止当前回合。请重试，或要求模型继续完成剩余步骤。'
            : '模型返回空响应，已停止当前回合。请重试，或要求模型继续。'
        args.onAssistantMessage?.(fallbackContent)
        return [...messages, { role: 'assistant', content: fallbackContent }]
      }

      // [K-13] 情形 D：progress 响应（文本以 <progress> 开头）。
      // 模型表示"还没完成，仍在进行中"，不应退出循环。
      // 将进度文本记录为 assistant_progress（区别于最终 assistant），
      // 然后注入续写提示，推动模型继续执行下一步。
      if (next.kind === 'progress') {
        args.onProgressMessage?.(next.content)
        messages = [...messages, { role: 'assistant_progress', content: next.content }]
        pushContinuationPrompt(
          '从你的 <progress> 更新处立即继续，执行具体工具调用、代码修改，或仅在任务完成时给出明确的 <final> 答案。',
        )
        continue
      }

      // 情形 E：正常的最终 assistant 响应（文本以 <final> 开头，或无特殊标签）。
      // 本回合完成，通知 UI，返回完整消息历史给调用方。
      args.onAssistantMessage?.(next.content)
      return [...messages, { role: 'assistant', content: next.content }]
    }

    // ── 分支二：模型返回 tool_calls（模型决定调用一个或多个工具）────────────────

    // [K-14] tool_calls 响应同样可能携带 thinking blocks，原因与 assistant 分支相同，
    // 必须在执行工具前先将其保存进消息历史。
    messages = appendThinkingBlocks(messages, next.thinkingBlocks)

    // [K-13] 模型在发起工具调用之前有时会先输出一段前置说明文字（next.content）。
    // 根据 contentKind 决定记录为进度消息还是普通助手消息。
    if (next.content) {
      if (next.contentKind === 'progress') {
        args.onProgressMessage?.(next.content)
        messages = [...messages, { role: 'assistant_progress', content: next.content }]
      } else {
        args.onAssistantMessage?.(next.content)
        messages = [...messages, { role: 'assistant', content: next.content }]
      }
    }

    // [K-11] 顺序执行本步骤中所有工具调用。
    //
    // 为什么分两个数组收集消息而不是边执行边追加？
    // → API 协议要求：所有 assistant_tool_call 必须先于对应的 tool_result 出现，
    //   若交错追加（call₁ → result₁ → call₂ → result₂），结构会不合规。
    //   正确格式：[call₁, call₂, ..., result₁, result₂, ...]
    //
    // 失败不中断原则：工具出错时不抛出异常也不退出循环，
    // 而是将错误信息以 isError=true 的 tool_result 反馈给模型，
    // 让模型自主决定是重试、换方案还是报告给用户。
    const toolCallMessages: ChatMessage[] = []
    const toolResultMessages: ChatMessage[] = []
    // awaitUser 信号的临时存储：若某工具要求暂停等待用户输入，记录在此
    let awaitUserResult: { output: string } | undefined

    for (const call of next.calls) {
      // 通知 UI "工具 xxx 开始执行"
      args.onToolStart?.(call.toolName, call.input)
      const result = await args.tools.execute(call.toolName, call.input, { cwd: args.cwd })

      // 更新本回合状态统计
      sawToolResultThisTurn = true
      if (!result.ok) toolErrorCount++

      // 通知 UI 工具执行结果（成功 / 失败）
      args.onToolResult?.(call.toolName, result.output, !result.ok)

      // 记录本次工具调用（assistant 角色发起的）
      toolCallMessages.push({
        role: 'assistant_tool_call',
        toolUseId: call.id,
        toolName: call.toolName,
        input: call.input,
      })

      // 记录本次工具结果（user 侧反馈给模型的）
      toolResultMessages.push({
        role: 'tool_result',
        toolUseId: call.id,
        toolName: call.toolName,
        content: result.output,
        isError: !result.ok,
      })

      // [K-26] awaitUser 信号：工具（如 ask_user）通过此字段告知 Agent Loop
      // "需要真实用户介入"，此时应立即停止执行剩余工具并退出循环，
      // 等待外部（CLI/UI）将用户回复注入 messages 后再发起新一轮 runAgentTurn。
      if (result.awaitUser) {
        awaitUserResult = { output: result.output }
        break
      }
    }

    // 将本步骤所有工具消息一次性追加到历史（保证 call/result 顺序符合协议）
    messages = [...messages, ...toolCallMessages, ...toolResultMessages]

    // 若收到 awaitUser 信号，将工具输出的问题文本以 assistant 身份展示，然后退出
    if (awaitUserResult) {
      const question = awaitUserResult.output.trim()
      if (question.length > 0) {
        args.onAssistantMessage?.(question)
        messages = [...messages, { role: 'assistant', content: question }]
      }
      return messages
    }

    // 本步骤无 awaitUser → 继续下一轮迭代，模型将基于工具结果决定下一步
  }

  // ── 超出最大步数：安全保底 ───────────────────────────────────────────────────
  // [K-12] 正常任务不应走到这里；若触发，说明模型陷入了工具调用的死循环。
  // 生成提示消息优雅退出，避免进程挂死。
  const maxStepContent = '达到最大工具步数限制，已停止当前回合。'
  args.onAssistantMessage?.(maxStepContent)
  return [...messages, { role: 'assistant', content: maxStepContent }]
}
