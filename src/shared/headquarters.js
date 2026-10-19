const names = Object.freeze({
  protocol: 'Геоузел Протокола',
  vanguard: 'Командный форт',
  bloom: 'Материнский мицелий',
  swarm: 'Главный улей',
  pack: 'Логово стаи',
});

export function headquartersFor(faction) {
  const id = Object.hasOwn(names, faction) ? faction : 'protocol';
  return { id, name: names[id], sprite: `/assets/headquarters/${id}.webp` };
}
