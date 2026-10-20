// One bounded, atomic group command. Air can escort a capture but never claim.
export const UNIT_GROUP_LIMIT = 36;
export const UNIT_CONTROL_SLOTS = 5;
export const controlGroups = player => Array.from({length: UNIT_CONTROL_SLOTS}, (_, i) => player?.unitGroups?.[i] || []);
export const groupOrderMode = (mode, unit) => mode === 'capture' && unit.type === 'air' ? 'attack' : mode;
