// One bounded, atomic group command. Air can escort a capture but never claim.
export const UNIT_GROUP_LIMIT = 36;
export const UNIT_CONTROL_SLOTS = 5;
export const UNIT_ORDER_LIMIT = 12;
export const TARGET_ORDER_MODES = ['move','attack','capture'];
export const remainingOrders = unit => [
  ...(unit.order&&TARGET_ORDER_MODES.includes(unit.order.mode)&&unit.order.status!=='complete'?[{mode:unit.order.mode,cell:unit.order.cell}]:[]),
  ...(unit.orderQueue||[]),
];
export const controlGroups = player => Array.from({length: UNIT_CONTROL_SLOTS}, (_, i) => player?.unitGroups?.[i] || []);
export const groupOrderMode = (mode, unit) => mode === 'capture' && unit.type === 'air' ? 'attack' : mode;
