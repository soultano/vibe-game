export const LANGUAGES = [
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'uz', label: 'O‘zbekcha', flag: '🇺🇿' },
];

export const STRINGS = {
  ru: {
    brand_sub: 'ТАКТИЧЕСКАЯ СТРАТЕГИЯ',
    operation_label: 'ОПЕРАЦИЯ «ЗЕМЛЯ»',
    region_label: 'ОБЩИЙ МИР / ЦЕНТРАЛЬНАЯ АЗИЯ',
    briefing: 'БРИФИНГ',
    factions: 'Фракции',
    login: 'Войти',
    energy: 'Энергия',
    territory: 'Территория',
    cells: 'ячеек',
    crystals: 'Кристаллы',
    base: 'База',
    sector: 'Сектор',
    rewards: 'Награды',
    ranking: 'Рейтинг',
    shop: 'Магазин',
    achievements: 'Ачивки',
    friends: 'Друзья',
    tutorial: 'Обучение',
    theme: 'Тема',
    theme_light: 'Светлая',
    theme_dark: 'Тёмная',
    sound: 'Звуки',
    sound_on: 'Включены',
    sound_off: 'Выключены',
    logout: 'Выйти',
    how_to_play: 'Как играть',
    
    // Profile & Customization
    profile_title: 'Командный профиль',
    custom_color: 'Цвет империи на карте',
    custom_link_label: 'Ссылка на канал или сайт',
    custom_link_ph: 'https://t.me/channel или https://youtube.com/@...',
    custom_title_label: 'Название кнопки',
    custom_title_ph: 'Например: Мой Telegram канал',
    save_profile: 'Сохранить профиль',
    saved_ok: 'Настройки профиля сохранены!',
    
    // Referral
    ref_title: 'Пригласить друга',
    ref_desc: 'За каждого приглашённого друга накапливается +200 ⚡ запасной энергии. Используйте её в решающий момент!',
    ref_link: 'Ваша реферальная ссылка:',
    ref_copy: 'Скопировать ссылку',
    ref_share_tg: 'Поделиться в Telegram',
    ref_count: 'Приглашено друзей:',
    ref_reserve: 'Запасная батарея:',
    ref_claim_btn: '⚡ Использовать запасную энергию',
    ref_claimed_msg: 'Запасная энергия переведена в хранилище!',
    copied: 'Ссылка скопирована в буфер обмена!',
    
    // Achievements
    ach_title: 'Достижения',
    ach_points: 'Очков достижений:',
    ach_unlocked: 'ДОСТИЖЕНИЕ ПОЛУЧЕНО!',
    
    // Combat notice
    combat_trophy: '⚔️ Боевой трофей (+50% ресурсов)',
    free_land: 'Свободная суша (базовый доход)',
    occupied_cell: 'Занятая ячейка',
    water: 'Вода',
    
    // Tutorial
    tut_welcome_title: 'Добро пожаловать в Pixel Dominion!',
    tut_welcome_desc: 'Масштабная геостратегия на реальной карте мира. Захватывайте города, стройте базы и ведите войну за господство.',
    tut_resources_title: 'Ресурсы и Энергия',
    tut_resources_desc: 'Вверху отображается ваша Энергия, Территория и Кристаллы. Энергия добывается с ячеек и нужна для развития.',
    tut_base_title: 'Управление Базой',
    tut_base_desc: 'Во вкладке «База» вкладывайте энергию в повышение уровня. Каждый уровень увеличивает лимит ячеек и доход.',
    tut_sector_title: 'Сектор и Азимут',
    tut_sector_desc: 'Во вкладке «Сектор» регулируйте угол и направление экспансии. База автоматически прирастает по азимуту.',
    tut_combat_title: 'Фронтир и Сражения',
    tut_combat_desc: 'Захват боевой территории у соперников приносит на 50% больше ресурсов и трофейную энергию, чем пустая суша!',
    tut_social_title: 'Ваш Цвет и Соцсети',
    tut_social_desc: 'В профиле выберите уникальный цвет на карте, привяжите ссылку на ваш YouTube или Telegram, и зовите друзей!',
    tut_next: 'Далее →',
    tut_prev: '← Назад',
    tut_skip: 'Пропустить',
    tut_finish: 'В бой! 🚀',
  },
  en: {
    brand_sub: 'TACTICAL STRATEGY',
    operation_label: 'OPERATION "EARTH"',
    region_label: 'SHARED WORLD / CENTRAL ASIA',
    briefing: 'BRIEFING',
    factions: 'Factions',
    login: 'Sign in',
    energy: 'Energy',
    territory: 'Territory',
    cells: 'cells',
    crystals: 'Crystals',
    base: 'Base',
    sector: 'Sector',
    rewards: 'Rewards',
    ranking: 'Leaderboard',
    shop: 'Shop',
    achievements: 'Achievements',
    friends: 'Friends',
    tutorial: 'Tutorial',
    theme: 'Theme',
    theme_light: 'Light',
    theme_dark: 'Dark',
    sound: 'Audio',
    sound_on: 'Enabled',
    sound_off: 'Disabled',
    logout: 'Log out',
    how_to_play: 'How to Play',
    
    // Profile & Customization
    profile_title: 'Commander Profile',
    custom_color: 'Empire Map Color',
    custom_link_label: 'Channel or Website Link',
    custom_link_ph: 'https://t.me/channel or https://youtube.com/@...',
    custom_title_label: 'Button Title',
    custom_title_ph: 'e.g. My Telegram Channel',
    save_profile: 'Save Profile',
    saved_ok: 'Profile settings updated!',
    
    // Referral
    ref_title: 'Invite Friends',
    ref_desc: 'Earn +200 ⚡ reserve energy for every invited friend. Deploy it during tactical emergencies!',
    ref_link: 'Your referral link:',
    ref_copy: 'Copy link',
    ref_share_tg: 'Share via Telegram',
    ref_count: 'Invited friends:',
    ref_reserve: 'Reserve Battery:',
    ref_claim_btn: '⚡ Deploy Reserve Energy',
    ref_claimed_msg: 'Reserve energy transferred to storage!',
    copied: 'Link copied to clipboard!',
    
    // Achievements
    ach_title: 'Achievements',
    ach_points: 'Achievement Points:',
    ach_unlocked: 'ACHIEVEMENT UNLOCKED!',
    
    // Combat notice
    combat_trophy: '⚔️ Combat Trophy (+50% resources)',
    free_land: 'Free Land (base income)',
    occupied_cell: 'Claimed Cell',
    water: 'Water',
    
    // Tutorial
    tut_welcome_title: 'Welcome to Pixel Dominion!',
    tut_welcome_desc: 'A massive geo-strategy on a real world map. Expand your empire, capture territories, and dominate the globe.',
    tut_resources_title: 'Resources & Energy',
    tut_resources_desc: 'Your Energy, Territory cells, and Crystals are displayed at the top. Energy fuels all expansion and upgrades.',
    tut_base_title: 'Base Management',
    tut_base_desc: 'In the Base tab, invest energy to upgrade your headquarters. Each level expands your territory cap and income.',
    tut_sector_title: 'Sector & Azimuth',
    tut_sector_desc: 'In the Sector tab, aim your expansion angle. Your base automatically claims neighbouring cells in that direction.',
    tut_combat_title: 'Frontiers & Battles',
    tut_combat_desc: 'Conquering hostile player territory awards +50% extra resource yield and instant plunder energy!',
    tut_social_title: 'Empire Color & Socials',
    tut_social_desc: 'Customize your empire color on the map, link your YouTube or Telegram channel, and invite friends for reserve energy!',
    tut_next: 'Next →',
    tut_prev: '← Back',
    tut_skip: 'Skip',
    tut_finish: 'To Battle! 🚀',
  },
  uz: {
    brand_sub: 'TAKTIK STRATEGIYA',
    operation_label: '«YER» OPERATSIYASI',
    region_label: 'UMUMIY DUNYO / MARKAZIY OSIYO',
    briefing: 'BRIFING',
    factions: 'Fraksiyalar',
    login: 'Kirish',
    energy: 'Energiya',
    territory: 'Hudud',
    cells: 'kataklar',
    crystals: 'Kristallar',
    base: 'Baza',
    sector: 'Sektor',
    rewards: 'Mukofotlar',
    ranking: 'Reyting',
    shop: 'Do‘kon',
    achievements: 'Yutuqlar',
    friends: 'Do‘stlar',
    tutorial: 'Qo‘llanma',
    theme: 'Mavzu',
    theme_light: 'Yorug‘',
    theme_dark: 'Qorong‘i',
    sound: 'Ovoz',
    sound_on: 'Yoniq',
    sound_off: 'O‘chiq',
    logout: 'Chiqish',
    how_to_play: 'Qanday o‘ynash',
    
    // Profile & Customization
    profile_title: 'Qo‘mondon profili',
    custom_color: 'Xaritadagi imperiya rangi',
    custom_link_label: 'Kanal yoki sayt havolasi',
    custom_link_ph: 'https://t.me/kanal yoki https://youtube.com/@...',
    custom_title_label: 'Tugma nomi',
    custom_title_ph: 'Masalan: Mening Telegram kanalim',
    save_profile: 'Saqlash',
    saved_ok: 'Profil sozlamalari saqlandi!',
    
    // Referral
    ref_title: 'Do‘stlarni taklif qilish',
    ref_desc: 'Har bir taklif qilingan do‘st uchun +200 ⚡ zaxira energiya to‘planadi. Hal qiluvchi janglarda foydalaning!',
    ref_link: 'Sizning taklif havolangiz:',
    ref_copy: 'Nusxa olish',
    ref_share_tg: 'Telegramda ulashish',
    ref_count: 'Taklif etilgan do‘stlar:',
    ref_reserve: 'Zaxira batareya:',
    ref_claim_btn: '⚡ Zaxira energiyani ishlatish',
    ref_claimed_msg: 'Zaxira energiya omborga o‘tkazildi!',
    copied: 'Havola nusxalandi!',
    
    // Achievements
    ach_title: 'Yutuqlar',
    ach_points: 'Yutuq ballari:',
    ach_unlocked: 'YUTUQ QO‘LGA KIRITILDI!',
    
    // Combat notice
    combat_trophy: '⚔️ Jangovar o‘lja (+50% resurs)',
    free_land: 'Bo‘sh quruqlik (asosiy daromad)',
    occupied_cell: 'Band qilingan katak',
    water: 'Suv',
    
    // Tutorial
    tut_welcome_title: 'Pixel Dominion olamiga xush kelibsiz!',
    tut_welcome_desc: 'Haqiqiy yer xaritasidagi keng ko‘lamli geostrategiya. Hududlarni egallang, bazangizni quring va hukmronlik qiling.',
    tut_resources_title: 'Resurslar va Energiya',
    tut_resources_desc: 'Yuqorida Energiya, Hudud va Kristallaringiz ko‘rinadi. Energiya rivojlanishning asosiy manbaidir.',
    tut_base_title: 'Bazani boshqarish',
    tut_base_desc: '«Baza» bo‘limida bosh qarorgohni rivojlantiring. Har bir bosqich hudud chegarasi va daromadni oshiradi.',
    tut_sector_title: 'Sektor va Azimut',
    tut_sector_desc: '«Sektor» bo‘limida kengayish yo‘nalishini belgilang. Baza avtomatik ravishda tanlangan yo‘nalishda kengayadi.',
    tut_combat_title: 'Frontir va Janglar',
    tut_combat_desc: 'Dushman hududini egallash bo‘sh yerdan 50% ko‘proq resurs va qo‘shimcha jangovar o‘lja keltiradi!',
    tut_social_title: 'Imperiya rangi va Tarmoqlar',
    tut_social_desc: 'Xaritada o‘z rangingizni tanlang, YouTube yoki Telegram kanalingizni ulang va zaxira energiya uchun do‘stlarni chorlang!',
    tut_next: 'Keyingisi →',
    tut_prev: '← Orqaga',
    tut_skip: 'O‘tkazib yuborish',
    tut_finish: 'Jangga! 🚀',
  },
};

let currentLang = 'ru';

export function getLang() {
  try {
    const saved = localStorage.getItem('pixel-lang');
    if (saved && STRINGS[saved]) return saved;
  } catch {}
  return 'ru';
}

export function setLang(code) {
  if (!STRINGS[code]) return;
  currentLang = code;
  try { localStorage.setItem('pixel-lang', code); } catch {}
  document.documentElement.lang = code;
}

export function t(key) {
  const dict = STRINGS[currentLang] || STRINGS.ru;
  return dict[key] || STRINGS.ru[key] || key;
}

currentLang = getLang();
