// One bounded, atomic group command. Air can escort a capture but never claim.
export const UNIT_GROUP_LIMIT = 36;
export const groupOrderMode = (mode, unit) => mode === 'capture' && unit.type === 'air' ? 'attack' : mode;
