// Canonical server-validated catalog. No client-supplied amounts are accepted.
export const CATALOG = Object.freeze([
  { id: 'crystals_80', crystals: 80, priceCents: 199, currency: 'usd' },
  { id: 'crystals_500', crystals: 500, priceCents: 499, currency: 'usd' },
  { id: 'crystals_1200', crystals: 1200, priceCents: 999, currency: 'usd' },
  { id: 'crystals_2600', crystals: 2600, priceCents: 1999, currency: 'usd' },
  { id: 'crystals_7000', crystals: 7000, priceCents: 4999, currency: 'usd' },
  { id: 'crystals_15000', crystals: 15000, priceCents: 9999, currency: 'usd' },
  { id: 'vip_month', vipDays: 30, priceCents: 499, currency: 'usd' },
  { id: 'season_pass', seasonPass: true, priceCents: 999, currency: 'usd', available: false, availabilityNote: 'Награды сезона готовятся' },
].map(Object.freeze));
