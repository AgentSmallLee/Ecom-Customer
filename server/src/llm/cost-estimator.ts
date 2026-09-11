// src/llm/cost-estimator.ts

// 各模型单价（元/千 Token），按实际 API 官网定价填写
// 本地模型（Ollama）无费用，填 0
const PRICE_TABLE: Record<string, { input: number; output: number }> = {
  'deepseek-chat':     { input: 0.001, output: 0.002 },
  'deepseek-r1':       { input: 0.004, output: 0.016 },
  'gpt-4o-mini':       { input: 0.011, output: 0.044 },
  'qwen3.5:0.8b':      { input: 0,     output: 0     },
  'mxbai-embed-large': { input: 0,     output: 0     },
}

export function estimateCost(
  model:        string,
  promptTokens: number,
  outputTokens: number,
): { inputCost: number; outputCost: number; totalCost: number; unit: string } {
  const price      = PRICE_TABLE[model] ?? { input: 0, output: 0 }
  const inputCost  = (promptTokens / 1000) * price.input
  const outputCost = (outputTokens / 1000) * price.output
  return {
    inputCost:  parseFloat(inputCost.toFixed(6)),
    outputCost: parseFloat(outputCost.toFixed(6)),
    totalCost:  parseFloat((inputCost + outputCost).toFixed(6)),
    unit:       '元',
  }
}