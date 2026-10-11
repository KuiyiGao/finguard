import type { ToolAdapter, ToolSpec } from "../types.ts";

export class ToolRegistry {
  private adapters = new Map<string, ToolAdapter>();

  register(...adapters: ToolAdapter[]): this {
    for (const adapter of adapters) this.adapters.set(adapter.spec.name, adapter);
    return this;
  }

  get(name: string): ToolAdapter | undefined {
    return this.adapters.get(name);
  }

  spec(name: string): ToolSpec | undefined {
    return this.adapters.get(name)?.spec;
  }

  specs(): ToolSpec[] {
    return [...this.adapters.values()].map((a) => a.spec);
  }
}
