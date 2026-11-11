// What the customer reads, sentence by sentence. A brand owner can reword any of them (or
// rename the stamp card, the review, ...) from their page; an empty field means the default.
// {n}, {every}, {reward}, {low}, {high} are filled in where the sentence is used.
// Shared by the customer page and the server (which checks what the owner saves).

export const TEXT_GROUPS = [
  {
    title: 'رقم الطلب',
    items: [
      ['card_app', 'الكلمة الصغيرة فوق الكارت', 'ORDER TRACKER'],
      ['order_label', 'عنوان الرقم', 'رقم الطلب'],
      ['scan_prompt', 'لو حد فتح اللينك من غير ما يمسح الكود', 'امسح الكود اللي عند الكاشير عشان تاخد رقم طلبك'],
      ['msg_picked', 'بعد ما يستلم', 'بالهنا والشفا'],
      ['other_orders', 'لو عنده طلب تاني', 'طلبك التاني:'],
    ],
  },
  {
    title: 'الطابور',
    items: [
      ['ahead_next', 'لو هو اللي عليه الدور', 'طلبك الجاي'],
      ['ahead_one', 'قدامه طلب واحد', 'قدامك طلب واحد'],
      ['ahead_two', 'قدامه طلبين', 'قدامك طلبين'],
      ['ahead_many', 'قدامه أكتر ({n} = العدد)', 'قدامك {n} طلبات'],
      ['eta_soon', 'الوقت قرّب يخلص', 'خلاص قرّب'],
      ['eta_range', 'الوقت المتوقع ({low} و{high} = الدقايق)', 'حوالي {low}–{high} دقايق'],
      ['eta_one', 'الوقت المتوقع برقم واحد ({high})', 'حوالي {high} دقايق'],
    ],
  },
  {
    title: 'التنبيه',
    items: [
      ['enable', 'زرار التنبيه', 'فعّل التنبيه'],
      ['enable_working', 'وهو بيتفعّل', 'بنفعّل التنبيه…'],
      ['enable_on', 'بعد ما يتفعّل', 'التنبيه شغّال، هنرن عليك أول ما يجهز'],
      ['enable_page', 'لو التنبيه شغّال والصفحة مفتوحة بس', 'التنبيه شغّال طول ما الصفحة مفتوحة'],
      ['ios_hint', 'نصيحة الآيفون', 'على الآيفون سيب الصفحة دي مفتوحة والشاشة منوّرة لحد ما طلبك يجهز.'],
      ['ready_title', 'لما الطلب يجهز', 'طلبك جاهز'],
      ['ready_hint', 'تحت «جاهز»', 'المس الشاشة عشان توقّف التنبيه'],
    ],
  },
  {
    title: 'بطاقة الختم',
    items: [
      ['loyalty_title', 'اسم البطاقة', 'بطاقة الختم'],
      ['loyalty_rule', 'القاعدة ({every} = كل كام طلب، {reward} = الهدية)', 'كل {every} طلبات: {reward}'],
      ['loyalty_has', 'معاه هدية على الطلب ده ({reward})', 'عندك مكافأة: {reward}، قولها للكاشير'],
      ['loyalty_used', 'بعد ما ياخد الهدية', 'استلمت مكافأتك، بالهنا'],
      ['loyalty_won', 'لما يكسب هدية ({reward})', 'كسبت {reward}، هتلاقيها في طلبك الجاي'],
    ],
  },
  {
    title: 'التقييم',
    items: [
      ['review_title', 'فوق زرار جوجل', 'عجبتك التجربة؟'],
      ['review_google', 'زرار جوجل', 'قيّمنا على جوجل'],
    ],
  },
  {
    title: 'رسالة للإدارة',
    items: [
      ['note_title', 'العنوان', 'رسالة للإدارة'],
      ['note_hint', 'تحت العنوان', 'عندك شكوى أو اقتراح؟ اكتبه هنا وهيوصل للإدارة على طول.'],
      ['note_placeholder', 'جوه الخانة', 'اكتب رسالتك…'],
      ['note_send', 'زرار الإرسال', 'ابعت للإدارة'],
      ['note_thanks', 'بعد الإرسال', 'شكراً، رسالتك وصلت للإدارة'],
    ],
  },
  {
    title: 'طلب تاني من نفس الموبايل',
    items: [
      ['again_title', 'السؤال', 'ده طلب جديد؟'],
      ['again_new', 'زرار الطلب الجديد', 'أيوه، خد رقم للطلب الجديد'],
      ['again_back', 'زرار الرجوع', 'لأ، ارجع لطلبي'],
      ['pick_title', 'لما يختار رقم فاتورته', 'إيه رقم طلبك؟'],
      ['pick_hint', 'تحت السؤال', 'هتلاقيه مكتوب على الفاتورة بتاعتك.'],
      ['pick_missing', 'لو رقمه مش موجود', 'رقمي مش موجود هنا'],
      ['wait_title', 'وهو مستني الفاتورة', 'ثواني…'],
      ['wait_hint', 'تحت «ثواني»', 'بنستنى طلبك يوصل من الكاشير عشان رقمك يبقى نفس رقم الفاتورة.'],
    ],
  },
];

export const TEXT_DEFAULTS = Object.fromEntries(TEXT_GROUPS.flatMap((g) => g.items.map(([key, , def]) => [key, def])));
export const TEXT_MAX = 160;

let overrides = {};

/** The brand's wording for this page (only the sentences it changed). */
export function setTexts(texts) {
  overrides = texts && typeof texts === 'object' ? texts : {};
}

const fill = (text, vars, wrap) => text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? wrap(String(vars[name])) : m));

/** Plain text (for textContent). */
export function t(key, vars = {}) {
  return fill(overrides[key] || TEXT_DEFAULTS[key] || '', vars, (v) => v);
}

/** HTML: the sentence escaped, the values in `strong` (for innerHTML). */
export function tHtml(key, vars = {}, esc = (s) => s) {
  const text = esc(overrides[key] || TEXT_DEFAULTS[key] || '');
  return fill(text, vars, (v) => `<strong>${esc(v)}</strong>`);
}

/** Every element with data-t="key" gets its sentence. */
export function applyTexts(root) {
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
}

/**
 * What an owner saved, cleaned: known keys only, trimmed, at most TEXT_MAX characters, and
 * nothing that is empty or the same as the default. Returns { texts } or { error, field }.
 */
export function cleanTexts(input) {
  const texts = {};
  if (!input || typeof input !== 'object') return { texts };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in TEXT_DEFAULTS) || typeof value !== 'string') continue;
    const text = value.trim();
    if (!text || text === TEXT_DEFAULTS[key]) continue;
    if (text.length > TEXT_MAX) return { error: `الجملة دي لحد ${TEXT_MAX} حرف`, field: key };
    texts[key] = text;
  }
  return { texts };
}
