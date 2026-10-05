import { getLang, initLangSwitch } from './i18n.js';
const show = () => {
  const l = getLang();
  document.documentElement.lang = l;
  for (const s of document.querySelectorAll('section[data-for]')) s.hidden = s.dataset.for !== l;
};
initLangSwitch(show);
show();
