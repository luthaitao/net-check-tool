/* 悬浮说明气泡：给任意元素加 data-tip="内容" 即可 */
(function (global) {
  'use strict';
  const { el, escapeHtml } = global.U;

  let bubble = null;
  let arrow = null;
  let currentTarget = null;
  let hideTimer = null;

  const GAP = 8;   // 与目标元素的间距
  const MARGIN = 12; // 距视口边缘的最小留白

  function ensureBubble() {
    if (bubble) return;
    bubble = el('div', { class: 'tip' });
    arrow = el('div', { class: 'tip-arrow' });
    bubble.appendChild(arrow);
    document.body.appendChild(bubble);
  }

  /**
   * 解析 data-tip 内容。支持：
   *   data-tip="纯文本"
   *   data-tip-title="标题" data-tip="正文"
   *   data-tip="正文" data-tip-ex="示例"（示例用等宽字体显示）
   *   data-tip-warn="注意事项"（橙色警示）
   */
  function buildContent(target) {
    ensureBubble();
    // 复用同一个气泡节点，只替换内容
    while (bubble.childNodes.length > 1) bubble.removeChild(bubble.lastChild);

    const title = target.getAttribute('data-tip-title');
    const body = target.getAttribute('data-tip') || '';
    const ex = target.getAttribute('data-tip-ex');
    const warn = target.getAttribute('data-tip-warn');

    if (title) bubble.appendChild(el('span', { class: 'tip-title', text: title }));
    if (body) bubble.appendChild(el('span', { class: 'tip-body', html: body }));
    if (ex) {
      // 多行示例按换行渲染成代码块
      if (ex.indexOf('\n') >= 0) {
        bubble.appendChild(el('span', { class: 'tip-ex-block', text: ex }));
      } else {
        const wrap = el('span', { class: 'tip-body' });
        for (const seg of ex.split(/\s{2,}/).filter(Boolean)) {
          wrap.appendChild(el('code', { text: seg }));
        }
        bubble.appendChild(wrap);
      }
    }
    if (warn) bubble.appendChild(el('span', { class: 'tip-warn', text: '⚠ ' + warn }));
  }

  /** 定位：优先显示在下方，靠近底部则翻到上方；靠右则向左对齐。 */
  function position(target) {
    const rect = target.getBoundingClientRect();
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = rect.bottom + GAP;
    let below = true;
    if (top + bh + MARGIN > vh) {
      // 下方放不下 → 翻到上方
      top = rect.top - bh - GAP;
      below = false;
    }
    if (top < MARGIN) top = MARGIN;

    let left = rect.left;
    // 右侧超出视口则左移
    if (left + bw + MARGIN > vw) left = Math.max(MARGIN, vw - bw - MARGIN);

    bubble.style.top = `${top}px`;
    bubble.style.left = `${left}px`;

    // 箭头跟随目标中心
    const targetCenter = rect.left + rect.width / 2;
    const arrowLeft = Math.max(8, Math.min(bw - 16, targetCenter - left - 4));
    arrow.style.left = `${arrowLeft}px`;
    if (below) {
      arrow.style.top = '-4px';
      arrow.style.bottom = 'auto';
    } else {
      arrow.style.top = `${bh - 4}px`;
      arrow.style.bottom = 'auto';
    }
  }

  function show(target) {
    clearTimeout(hideTimer);
    currentTarget = target;
    buildContent(target);
    position(target);
    // 先置为可见再测尺寸，offsetWidth 才准确
    bubble.classList.add('show');
    position(target);
  }

  function hide() {
    if (!bubble) return;
    // 延迟一点消失，方便鼠标移进气泡本身（虽然已设 pointer-events:none）
    hideTimer = setTimeout(() => {
      bubble.classList.remove('show');
      currentTarget = null;
    }, 60);
  }

  function init() {
    // 用事件委托：动态插入的元素（参数行、断言行）也能生效
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) return;
      if (t === currentTarget) return;
      show(t);
    });

    document.addEventListener('mouseout', (e) => {
      const t = e.target.closest('[data-tip]');
      if (!t) return;
      // 移动到子元素不算离开
      if (e.relatedTarget && t.contains(e.relatedTarget)) return;
      hide();
    });

    document.addEventListener('mousedown', hide);
    window.addEventListener('scroll', () => { if (currentTarget) hide(); }, true);
    window.addEventListener('resize', hide);
    // 键盘可达性：聚焦到带 data-tip 的控件时也显示
    document.addEventListener('focusin', (e) => {
      const t = e.target.closest('[data-tip]');
      if (t) show(t); else hide();
    });
    document.addEventListener('focusout', hide);
  }

  global.Tip = { init, hide };
})(window);