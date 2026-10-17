/* 本地持久化：环境变量 / 请求集合 / 历史记录 */
(function (global) {
  'use strict';

  const PREFIX = 'netcheck.';
  const LIMITS = { history: 40, collection: 200, env: 60 };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v === null || v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (e) {
      // 配额超限（历史里存了大响应体时可能触发）
      global.U && global.U.toast('本地存储写入失败：' + e.message, 'err');
      return false;
    }
  }

  // ───────────── 环境变量 ─────────────
  const Store = {
    getEnv() {
      const list = read('env', null);
      if (Array.isArray(list) && list.length) return list;
      return [{ key: 'baseUrl', value: 'https://httpbin.org' }];
    },
    saveEnv(list) {
      const trimmed = (list || []).filter((x) => x && String(x.key).trim());
      write('env', trimmed.slice(0, LIMITS.env));
      return trimmed.slice(0, LIMITS.env);
    },

    /** 合并环境变量为 {name: value}，供 {{name}} 插值。 */
    envMap() {
      const map = {};
      for (const item of this.getEnv()) {
        const k = String(item.key || '').trim();
        if (k) map[k] = String(item.value == null ? '' : item.value);
      }
      return map;
    },

    // ───────────── 请求集合 ─────────────
    getCollection() {
      const list = read('collection', []);
      return Array.isArray(list) ? list : [];
    },
    saveRequest(req) {
      const list = this.getCollection();
      const name = String(req.name || '').trim() || `${req.method} ${req.url}`.slice(0, 60);
      const idx = list.findIndex((x) => x.name === name);
      const record = Object.assign({}, req, { name, id: idx >= 0 ? list[idx].id : global.U.uid('req'), savedAt: Date.now() });
      if (idx >= 0) list[idx] = record;
      else list.push(record);
      if (list.length > LIMITS.collection) list.splice(0, list.length - LIMITS.collection);
      write('collection', list);
      return record;
    },
    deleteRequest(id) {
      write('collection', this.getCollection().filter((x) => x.id !== id));
    },
    clearCollection() {
      write('collection', []);
    },

    // ───────────── 历史 ─────────────
    /** 只存请求配置 + 结果摘要，不存完整响应体——否则 localStorage 会被撑爆。 */
    addHistory(entry) {
      const list = this.getHistory();
      const summary = Object.assign({}, entry, {
        id: global.U.uid('h'),
        at: Date.now(),
      });
      delete summary.response;
      delete summary.assertions;
      list.unshift(summary);
      if (list.length > LIMITS.history) list.splice(LIMITS.history);
      write('history', list);
      return summary;
    },
    getHistory() {
      const list = read('history', []);
      return Array.isArray(list) ? list : [];
    },
    clearHistory() {
      write('history', []);
    },

    // ───────────── 表单草稿 ─────────────
    saveDraft(draft) { write('draft', draft); },
    getDraft() { return read('draft', null); },
  };

  global.Store = Store;
})(window);