/**
 * The kit's CPU budget (docs/spec/02-game-framework.md §6.6, 08 T25), in one place for every kit
 * run: `runKit` itself, a game package's own kit test and `pnpm games:verify`.
 *
 * The budget is measured on the host running the kit, so a host slower than the reference
 * hardware may raise it. CI does that with one environment variable, `KIT_CPU_BUDGET_MS`, which
 * every kit run there reads (docs/deploy.md, "CI runners"); `games:verify --cpu-budget-ms <n>`
 * sets it for one run; an explicit `cpuBudgetMs` kit option wins over both. With none of them,
 * as on a developer machine, the reference budget of 5 ms applies.
 *
 * As text (the variable or the flag), a budget is a plain decimal integer of milliseconds from 1
 * to 50: nothing a typo or a stray setting could turn into a budget no module would fail.
 */

/** The environment variable CI sets to its calibrated budget. @public */
export const CPU_BUDGET_VARIABLE = "KIT_CPU_BUDGET_MS";

/** The reference budget, 08 T25. @public */
export const DEFAULT_CPU_BUDGET_MS = 5;

/** The largest budget accepted as text. @public */
export const MAX_CPU_BUDGET_MS = 50;

/**
 * A budget read from text: the milliseconds (undefined: none given, use the default), or why the
 * text isn't a budget.
 *
 * @public
 */
export type CpuBudget =
  | { readonly ok: true; readonly ms: number | undefined }
  | { readonly ok: false; readonly problem: string };

/**
 * Reads a budget from the `--cpu-budget-ms` flag, else from the variable's value. The flag must be
 * a budget; the variable may also be unset or empty, meaning none.
 *
 * @public
 */
export function readCpuBudget(flag: string | undefined, variable: string | undefined): CpuBudget {
  if (flag === undefined && (variable === undefined || variable === "")) {
    return { ok: true, ms: undefined };
  }
  const [text, source] =
    flag === undefined ? [variable ?? "", CPU_BUDGET_VARIABLE] : [flag, "--cpu-budget-ms"];
  const ms = /^[0-9]{1,3}$/u.test(text) ? Number(text) : Number.NaN;
  return ms >= 1 && ms <= MAX_CPU_BUDGET_MS
    ? { ok: true, ms }
    : {
        ok: false,
        problem: `${source} must be a whole number of milliseconds from 1 to ${String(MAX_CPU_BUDGET_MS)}`,
      };
}

/**
 * The value of `KIT_CPU_BUDGET_MS` in the host's environment, if the host has one (Node); the kit
 * itself loads no host types, so it looks the environment up defensively.
 */
export function environmentCpuBudget(): string | undefined {
  const host = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return host.process?.env?.[CPU_BUDGET_VARIABLE];
}
