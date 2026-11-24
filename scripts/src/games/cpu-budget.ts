/**
 * The kit's CPU budget for `pnpm games:verify` (02 §6.6, 08 T25). The budget is measured on the
 * host running the kit, so a slower host may raise it: with `--cpu-budget-ms <n>`, or with the
 * `KIT_CPU_BUDGET_MS` environment variable, which CI sets once for every job and image build that
 * runs the kit (docs/deploy.md, "CI runners"). The flag wins; an empty variable counts as unset;
 * with neither, the kit's own default (5 ms) applies, as on developer machines.
 */

/** The environment variable CI sets to its calibrated budget. */
export const CPU_BUDGET_VARIABLE = "KIT_CPU_BUDGET_MS";

/** The budget to pass to the kit (undefined: the kit's default), or the reason it is invalid. */
export type CpuBudget =
  | { readonly ok: true; readonly ms: number | undefined }
  | { readonly ok: false; readonly problem: string };

/** Reads the budget from the flag, else the environment variable. */
export function cpuBudget(flag: string | undefined, variable: string | undefined): CpuBudget {
  if (flag === undefined && (variable === undefined || variable.trim() === "")) {
    return { ok: true, ms: undefined };
  }
  const [value, source] =
    flag !== undefined ? [flag, "--cpu-budget-ms"] : [variable ?? "", CPU_BUDGET_VARIABLE];
  // An empty flag is a mistake, not "unset": Number("") would be 0 anyway.
  const ms = value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(ms) && ms > 0
    ? { ok: true, ms }
    : { ok: false, problem: `${source} must be a positive number of milliseconds` };
}
