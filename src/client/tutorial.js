import { t } from './i18n.js';

export const TUTORIAL_STEPS = [
  {
    target: '#mapViewport',
    titleKey: 'tut_welcome_title',
    descKey: 'tut_welcome_desc',
    icon: '🌍',
  },
  {
    target: '#resourceBar',
    titleKey: 'tut_resources_title',
    descKey: 'tut_resources_desc',
    icon: '⚡',
  },
  {
    target: 'button[data-open="base"]',
    titleKey: 'tut_base_title',
    descKey: 'tut_base_desc',
    icon: '🏛️',
  },
  {
    target: 'button[data-open="sector"]',
    titleKey: 'tut_sector_title',
    descKey: 'tut_sector_desc',
    icon: '🧭',
  },
  {
    target: '#abilityBar',
    titleKey: 'tut_combat_title',
    descKey: 'tut_combat_desc',
    icon: '⚔️',
  },
  {
    target: '#profileButton',
    titleKey: 'tut_social_title',
    descKey: 'tut_social_desc',
    icon: '🎨',
  },
];

let currentStep = 0;
let isActive = false;

export function isTutorialDone() {
  try {
    return localStorage.getItem('pixel_tutorial_done') === '1';
  } catch {
    return false;
  }
}

export function setTutorialDone() {
  try {
    localStorage.setItem('pixel_tutorial_done', '1');
  } catch {}
}

export function initTutorial({ onStepChange, onComplete }) {
  function showStep(index) {
    if (index < 0 || index >= TUTORIAL_STEPS.length) {
      endTutorial();
      return;
    }
    currentStep = index;
    isActive = true;
    const step = TUTORIAL_STEPS[index];
    const isFirst = index === 0;
    const isLast = index === TUTORIAL_STEPS.length - 1;

    onStepChange?.({
      index,
      total: TUTORIAL_STEPS.length,
      step,
      title: t(step.titleKey),
      desc: t(step.descKey),
      isFirst,
      isLast,
    });
  }

  function next() {
    if (currentStep < TUTORIAL_STEPS.length - 1) {
      showStep(currentStep + 1);
    } else {
      endTutorial();
    }
  }

  function prev() {
    if (currentStep > 0) {
      showStep(currentStep - 1);
    }
  }

  function endTutorial() {
    isActive = false;
    setTutorialDone();
    onComplete?.();
  }

  return {
    start: () => showStep(0),
    next,
    prev,
    skip: endTutorial,
    isActive: () => isActive,
  };
}
