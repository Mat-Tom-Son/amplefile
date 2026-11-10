export interface InputContract {
  variants: Array<{ when?: Record<string, string>; required?: string[] }>;
  examples: Array<Record<string, unknown>>;
}
export function withInputContract<T extends { name: string; description: string; parameters: unknown }>(tool: T, contract: InputContract): T;
