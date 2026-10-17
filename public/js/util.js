/* 通用工具函数 */
(function (global) {
  'use strict';

  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 带超时的 fetch，统一抛错信息。 */
  async function api(path, payload, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 600000);
    try {
      const res = await fetch(path, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`服务端返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`); }
      if (!res.ok && !data.ok) {
        const msg = (data.error && data.error.message) || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('请求超时（本地后端无响应）');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  /** 复制到剪贴板，降级到 execCommand（file:// 或非安全上下文下 navigator.clipboard 不可用）。 */
  async function copy(text, label) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0' });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand 失败');
      }
      toast((label || '内容') + '已复制到剪贴板', 'ok');
      return true;
    } catch (e) {
      toast('复制失败：' + e.message, 'err');
      return false;
    }
  }

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
    return (v / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtMs(n) {
    if (n === null || n === undefined) return '—';
    const v = Number(n);
    if (!isFinite(v)) return '—';
    if (v >= 1000) return (v / 1000).toFixed(2) + ' s';
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ms';
  }

  function statusClass(code) {
    if (!code) return 'err';
    if (code < 200) return 'err';
    if (code < 300) return 's2';
    if (code < 400) return 's3';
    if (code < 500) return 's4';
    return 's5';
  }

  /** 安全的 JSON 高亮（先 escape 再着色，避免 XSS）。 */
  function highlightJson(value) {
    let json;
    try {
      json = JSON.stringify(value, null, 2);
      if (json === undefined) return escapeHtml(String(value));
    } catch (e) {
      return escapeHtml(String(value));
    }
    return escapeHtml(json).replace(
      /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = 'tok-num';
        if (/^"/.test(match)) cls = /:$/.test(match) ? 'tok-key' : 'tok-str';
        else if (/true|false/.test(match)) cls = 'tok-bool';
        else if (/null/.test(match)) cls = 'tok-null';
        return '<span class="' + cls + '">' + match + '</span>';
      }
    );
  }

  function highlightXml(text) {
    return escapeHtml(text).replace(
      /(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?[\w:-]+)([\s\S]*?)(\/?&gt;)/g,
      (m, comment, tag, attrs, close) => {
        if (comment) return '<span class="tok-null">' + comment + '</span>';
        const a = attrs.replace(/([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*')/g,
          '<span class="tok-attr">$1</span>$2<span class="tok-str">$3</span>');
        return '<span class="tok-tag">' + tag + '</span>' + a + '<span class="tok-tag">' + close + '</span>';
      }
    );
  }

  /** 下载文本为文件。 */
  function download(filename, content, mime) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /** 在纯文本中查找并高亮（响应体搜索）。 */
  function markMatches(container, text, needle) {
    container.innerHTML = '';
    if (!needle) {
      container.textContent = text;
      return;
    }
    const lower = text.toLowerCase();
    const target = needle.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0;
    let found = 0;
    for (;;) {
      const idx = lower.indexOf(target, i);
      if (idx < 0) { frag.appendChild(document.createTextNode(text.slice(i))); break; }
      frag.appendChild(document.createTextNode(text.slice(i, idx)));
      frag.appendChild(el('mark', { text: text.slice(idx, idx + target.length) }));
      found++;
      i = idx + target.length;
      if (found > 2000) { frag.appendChild(document.createTextNode('…（结果过多，已截断）')); break; }
    }
    container.appendChild(frag);
    if (!found) toast('未找到匹配内容');
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsText(file, 'utf-8');
    });
  }

  /** 文件 → base64（去掉 dataURL 前缀），用于 multipart 上传。 */
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const s = String(fr.result);
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /** 构造 shell 引号，用于 cURL 生成。注意浏览器里没有 process，探测靠 UA。 */
  function shellQuote(s) {
    const v = String(s == null ? '' : s);
    const isWindows = /Win/i.test(navigator.userAgent || '');
    if (isWindows) return '"' + v.replace(/"/g, '\\"') + '"';
    return "'" + v.replace(/'/g, `'\\''`) + "'";
  }

  global.U = {
    $, $$, el, escapeHtml, api, toast, copy, fmtBytes, fmtMs, statusClass,
    highlightJson, highlightXml, download, markMatches,
    readFileAsText, readFileAsBase64, debounce, uid, shellQuote,
  };
})(window);