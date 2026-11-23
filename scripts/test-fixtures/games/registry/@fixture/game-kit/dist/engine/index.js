// A tiny game with real (duck-typed) schemas, so the test kit can play it: seats take turns
// adding 1 or 2 to a shared counter; whoever reaches TARGET wins. No hidden information.
const TARGET = 7;
const any = { safeParse: (value) => ({ success: value !== undefined }) };
const ok = { ok: true };

const definition = {
  type: "counter",
  version: 1,
  configSchema: any,
  optionsSchema: any,
  actionSchema: { safeParse: (a) => ({ success: a !== null && typeof a === "object" && (a.add === 1 || a.add === 2) }) },
  viewSchema: any,
  recordSchema: any,
  catalogSchema: any,
  errorCodes: ["OVER"],
  resolveOptions: () => ({}),
  catalog: () => ({}),
  players: () => ({ min: 2, max: 3 }),
  validateStart: () => ok,
  defaultTurnTimeoutDays: () => 3,
  resources: () => [],
  checkConfig: () => ok,
  setup: ({ seats }) => ({ seats, count: 0, turn: 0, out: Array.from({ length: seats }, () => false), winner: null }),
  toAct: (s) => (s.count === TARGET || playing(s).length < 2 ? [] : [s.turn]),
  seatStatus: (s) => s.out.map((o) => (o ? "out" : "playing")),
  validate: (s, seat, a) => (s.count + a.add > TARGET ? { code: "OVER" } : ok),
  apply: (s, seat, a) => {
    const count = s.count + a.add;
    return {
      state: { ...s, count, turn: next(s, seat), winner: count === TARGET ? seat : null },
      record: { seat, add: a.add },
    };
  },
  onResign: (s, seat) => leave(s, seat),
  onTimeout: (s, seat) => leave(s, seat),
  result: (s) => {
    if (!(s.count === TARGET || playing(s).length < 2)) return null;
    const winner = s.winner ?? s.out.findIndex((o) => !o);
    return {
      endReason: "done",
      ranking: s.out.map((_, seat) => ({ seat, rank: seat === winner ? 1 : 2 })),
    };
  },
  view: (s) => ({ count: s.count, turn: s.turn }),
  describe: (r) => [{ seat: r.seat }, r.add === undefined ? " left" : ` added ${String(r.add)}`],
  summary: (s) => ({ headline: [String(s.count)] }),
  test: {
    randomAction: (s, seat, rng) => ({ add: s.count + 2 > TARGET ? 1 : 1 + rng.nextInt(2) }),
    randomAnyAction: (s, seat, rng) => ({ add: 1 + rng.nextInt(2) }),
    perturbHidden: (s) => s,
    hiddenInformation: false,
    maxActions: () => TARGET + 3,
    worstCase: (options, seats) => [{ state: definition.setup({ options, seats }), seat: 0, action: { add: 1 } }],
  },
};

function playing(s) {
  return s.out.flatMap((o, seat) => (o ? [] : [seat]));
}

function next(s, seat) {
  const live = playing(s);
  return live.find((other) => other > seat) ?? live[0] ?? seat;
}

function leave(s, seat) {
  const out = s.out.map((o, i) => o || i === seat);
  const left = { ...s, out };
  return { state: { ...left, turn: s.turn === seat ? next(left, seat) : s.turn }, record: { seat } };
}

export const engines = { 1: definition };
