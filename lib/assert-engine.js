'use strict';
/**
 * 断言/测试脚本引擎
 *
 * 定位：Postman 的 pm.test + JS 沙箱太重（要引入完整运行时，且用户脚本能读到
 * 任意东西）。这里改为**声明式断言**——前端勾选规则，服务端对完整响应求值。
 * 好处：断言结果可信（服务端算的，不受前端展示截断影响）、无需沙箱、结果可复现。
 */

const assert = require('node:assert');

/** 常见状态码语义，便于前端给建议模板。 */
const STATUS_GROUPS = {
  '2xx': [200, 201, 202, 203, 204, 205, 206, 207, 208, 226],
  '3xx': [300, 301, 302, 303, 304, 305, 307, 308],
  '4xx': [400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413, 414, 415, 416, 417, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451],
  '5xx': [500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511],
};

/** 从响应体里按 JSON 路径取值：支持 $.a.b[0].c、a.b[0]、$.items[*].id */
function jsonPath(root, path) {
  if (root === undefined || root === null) return undefined;
  let p = String(path || '').trim();
  if (!p) return root;
  p = p.replace(/^\$/, '').replace(/^\./, '');

  // 简化 JSONPath：不支持过滤表达式，遇到直接整体返回 undefined
  let cur = root;
  for (const rawSeg of p.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    const seg = rawSeg.trim();
    if (!seg) continue;
    const m = seg.match(/^([^[\]]*)((?:\[[^\]]*\])*)$/);
    if (!m) return undefined;
    let key = m[1].trim();
    const brackets = m[2] || '';

    if (key) {
      if (cur === null || typeof cur !== 'object') return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
      cur = cur[key];
    }
    if (brackets) {
      const idxs = [...brackets.matchAll(/\[([^\]]*)\]/g)].map((x) => x[1].trim());
      for (const idx of idxs) {
        if (cur === null || cur === undefined) return undefined;
        if (idx === '*') {
          // 通配：只要其中任一元素满足断言即可，取数组本身交给后续算子
          if (Array.isArray(cur)) {
            cur = cur;
          }
          continue;
        }
        const n = Number(idx);
        if (Number.isNaN(n)) {
          if (cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
            if (!Object.prototype.hasOwnProperty.call(cur, idx)) return undefined;
            cur = cur[idx];
          } else return undefined;
        } else {
          if (!Array.isArray(cur) && typeof cur !== 'string') return undefined;
          if (n < 0 || n >= cur.length) return undefined;
          cur = cur[n];
        }
      }
    }
  }
  return cur;
}

/** 判断 JSON 里某个路径是否存在（区分「值为 undefined」和「键不存在」）。 */
function containsKey(root, path) {
  const p = String(path || '').trim().replace(/^\$/, '').replace(/^\./, '');
  let cur = root;
  for (const seg of p.split('.')) {
    if (!seg) continue;
    const key = seg.replace(/\[(\d+)\]$/, '');
    if (cur === null || typeof cur !== 'object') return false;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) {
      const n = Number(seg);
      if (n >= cur.length) return false;
      cur = cur[n];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return false;
    cur = cur[key];
  }
  return true;
}

/** 宽松相等：数字字符串与数字视为相等（HTTP 场景下这是最常见的诉求）。 */
function looseEquals(actual, expected) {
  if (actual === expected) return true;
  if (actual === null || actual === undefined || expected === null || expected === undefined) return false;
  if (typeof actual === 'object' || typeof expected === 'object') {
    try { return JSON.stringify(actual) === JSON.stringify(expected); } catch { return false; }
  }
  const na = Number(actual);
  const ne = Number(expected);
  if (!Number.isNaN(na) && !Number.isNaN(ne) && String(actual).trim() !== '' && String(expected).trim() !== '') {
    return na === ne;
  }
  return String(actual) === String(expected);
}

/** 把断言里填的值尝试转成 JSON 字面量（支持 "200" → 数字、"[1,2]" → 数组）。 */
function coerceExpected(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  if (/^[[{]/.test(t)) {
    try { return JSON.parse(t); } catch { return value; }
  }
  return value;
}

/** 从原始响应结果中取出断言目标值。 */
function extractValue(rule, ctx) {
  const src = rule.source || 'body';
  const path = rule.path || '';

  if (src === 'status') return ctx.status;

  if (src === 'statusGroup') {
    const codes = STATUS_GROUPS[String(rule.path || '2xx').trim()] || [];
    return codes.includes(Number(ctx.status));
  }

  if (src === 'time') {
    const field = String(path || 'total').trim();
    const v = ctx.time && ctx.time[field];
    return typeof v === 'number' ? v : null;
  }

  if (src === 'header') {
    const name = String(path || '').trim().toLowerCase();
    if (!name) return undefined;
    const hit = ctx.headers.find((h) => h.key.toLowerCase() === name);
    return hit ? hit.value : undefined;
  }

  if (src === 'cookie') {
    const name = String(path || '').trim();
    const hit = (ctx.cookies || []).find((c) => c.name === name);
    return hit ? hit.value : undefined;
  }

  if (src === 'size') return ctx.size;

  if (src === 'bodyText') {
    return ctx.bodyType === 'binary' ? '' : String(ctx.bodyText || '');
  }

  if (src === 'bodyJson') {
    if (!ctx.parsedJson) return undefined;
    return jsonPath(ctx.parsedJson, path);
  }

  if (src === 'headerCount') return ctx.headers.length;
  if (src === 'cookieCount') return (ctx.cookies || []).length;
  if (src === 'jsonKeys') {
    if (!ctx.parsedJson || typeof ctx.parsedJson !== 'object') return undefined;
    const target = jsonPath(ctx.parsedJson, path);
    return target && typeof target === 'object' ? Object.keys(target) : undefined;
  }

  return undefined;
}

/** 执行单条断言。 */
function evaluateRule(rule, ctx) {
  const actual = extractValue(rule, ctx);
  const op = rule.operator || 'equals';
  const expectedRaw = rule.value;
  const expected = coerceExpected(expectedRaw);
  let passed = false;
  let detail = '';

  const asText = (v) => {
    if (v === null) return 'null';
    if (v === undefined) return '(undefined)';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
    return String(v);
  };

  try {
    switch (op) {
      case 'equals':
        passed = looseEquals(actual, expected);
        detail = `期望 ${asText(expected)}，实际 ${asText(actual)}`;
        break;
      case 'notEquals':
        passed = !looseEquals(actual, expected);
        detail = `期望不等于 ${asText(expected)}，实际 ${asText(actual)}`;
        break;
      case 'contains':
        if (Array.isArray(actual)) {
          passed = actual.some((x) => looseEquals(x, expected));
          detail = `期望数组包含 ${asText(expected)}，实际 ${asText(actual)}`;
        } else {
          passed = String(actual ?? '').includes(String(expected ?? ''));
          detail = `期望包含 "${expected}"，实际 "${asText(actual).slice(0, 120)}"`;
        }
        break;
      case 'notContains':
        passed = !String(actual ?? '').includes(String(expected ?? ''));
        detail = `期望不包含 "${expected}"`;
        break;
      case 'hasKey':
        passed = containsKey(ctx.parsedJson, rule.path || '');
        detail = `期望 JSON 存在路径 ${rule.path}`;
        break;
      case 'matches':
        passed = new RegExp(String(expected ?? ''), rule.caseSensitive ? '' : 'i').test(String(actual ?? ''));
        detail = `期望匹配正则 /${expected}/，实际 "${asText(actual).slice(0, 120)}"`;
        break;
      case 'notMatches':
        passed = !new RegExp(String(expected ?? ''), rule.caseSensitive ? '' : 'i').test(String(actual ?? ''));
        detail = `期望不匹配正则 /${expected}/`;
        break;
      case 'gt':
        passed = Number(actual) > Number(expected);
        detail = `期望 > ${expected}，实际 ${asText(actual)}`;
        break;
      case 'gte':
        passed = Number(actual) >= Number(expected);
        detail = `期望 >= ${expected}，实际 ${asText(actual)}`;
        break;
      case 'lt':
        passed = Number(actual) < Number(expected);
        detail = `期望 < ${expected}，实际 ${asText(actual)}`;
        break;
      case 'lte':
        passed = Number(actual) <= Number(expected);
        detail = `期望 <= ${expected}，实际 ${asText(actual)}`;
        break;
      case 'isEmpty':
        passed = actual === undefined || actual === null || actual === ''
          || (Array.isArray(actual) && actual.length === 0)
          || (typeof actual === 'object' && !Array.isArray(actual) && Object.keys(actual).length === 0);
        detail = `期望为空，实际 ${asText(actual).slice(0, 80)}`;
        break;
      case 'isNotEmpty':
        passed = !(actual === undefined || actual === null || actual === ''
          || (Array.isArray(actual) && actual.length === 0));
        detail = `期望非空，实际 ${asText(actual).slice(0, 80)}`;
        break;
      case 'isNull':
        passed = actual === null || actual === undefined;
        detail = `期望 null，实际 ${asText(actual)}`;
        break;
      case 'isNotNull':
        passed = actual !== null && actual !== undefined;
        detail = `期望非 null，实际 ${asText(actual)}`;
        break;
      case 'isNumber':
        passed = typeof actual === 'number' && !Number.isNaN(actual);
        detail = `期望数字，实际 ${asText(actual)}`;
        break;
      case 'isString':
        passed = typeof actual === 'string';
        detail = `期望字符串，实际 ${asText(actual)}`;
        break;
      case 'isArray':
        passed = Array.isArray(actual);
        detail = `期望数组，实际 ${asText(actual).slice(0, 80)}`;
        break;
      case 'isObject':
        passed = !!actual && typeof actual === 'object' && !Array.isArray(actual);
        detail = `期望对象，实际 ${asText(actual).slice(0, 80)}`;
        break;
      case 'isBoolean':
        passed = typeof actual === 'boolean';
        detail = `期望布尔值，实际 ${asText(actual)}`;
        break;
      case 'isTrue':
        passed = looseEquals(actual, true);
        detail = `期望 true，实际 ${asText(actual)}`;
        break;
      case 'isFalse':
        passed = looseEquals(actual, false);
        detail = `期望 false，实际 ${asText(actual)}`;
        break;
      case 'isBase64':
        passed = /^[A-Za-z0-9+/]+={0,2}$/.test(String(actual ?? '')) && String(actual).length % 4 === 0;
        detail = '期望 base64 字符串';
        break;
      case 'lengthEquals': {
        const len = actual === undefined || actual === null ? -1
          : (Array.isArray(actual) || typeof actual === 'string' ? actual.length
            : (typeof actual === 'object' ? Object.keys(actual).length : NaN));
        passed = len === Number(expected);
        detail = `期望长度 ${expected}，实际 ${len}`;
        break;
      }
      case 'greaterThanLength': {
        const len = Array.isArray(actual) || typeof actual === 'string' ? actual.length : -1;
        passed = len > Number(expected);
        detail = `期望长度 > ${expected}，实际 ${len}`;
        break;
      }
      default:
        passed = false;
        detail = `未知断言算子: ${op}`;
    }
  } catch (e) {
    passed = false;
    detail = `断言执行异常: ${e.message}`;
  }

  return {
    id: rule.id,
    name: rule.name || `${rule.source || 'body'}${rule.path ? `.${rule.path}` : ''} ${op}`,
    source: rule.source,
    path: rule.path || '',
    operator: op,
    expected: expectedRaw === undefined ? '' : String(expectedRaw),
    actual: actual === undefined ? '(undefined)' : (typeof actual === 'object' ? JSON.stringify(actual) : String(actual)),
    passed,
    detail,
  };
}

/**
 * 批量执行断言。
 * @param {Array} rules 前端传来的断言规则
 * @param {object} ctx { status, headers, cookies, time, size, bodyText, parsedJson, bodyType }
 */
function runAssertions(rules, ctx) {
  if (!Array.isArray(rules) || !rules.length) {
    return { total: 0, passed: 0, failed: 0, results: [], error: null };
  }
  const results = rules.map((r) => evaluateRule(r, ctx));
  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
    error: null,
  };
}

module.exports = { runAssertions, jsonPath, looseEquals, STATUS_GROUPS, evaluateRule };