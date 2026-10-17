/* API 调试台面板 */
(function (global) {
  'use strict';
  const { $, $$, el, escapeHtml, api, toast, copy, fmtBytes, fmtMs, statusClass, uid, debounce } = global.U;

  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

  // 请求的运行时模型（不落 localStorage 里的文件字段）
  const model = {
    params: [], headers: [], form: [], multipart: [], assertions: [],
    auth: { type: 'none' },
    bodyType: 'none',
    rawBody: '',
    contentType: 'application/json',
    timeout: 30000,
    followRedirects: true,
    insecureTLS: false,
    env: {},
    lastResult: null,
  };

  let currentId = null; // 正在编辑的集合项 id

  // 各键值表的列说明，动态生成的行也要挂上提示
  const KV_TIPS = {
    params: {
      key: { 'data-tip-title': '参数名', 'data-tip': '会拼到 URL 的查询字符串里，重复的参数名可以加多行。', 'data-tip-ex': 'page      → ?page=1\nkeyword   → ?keyword=abc\n同名重复 → ?tag=a&tag=b' },
      val: { 'data-tip-title': '参数值', 'data-tip': '可留空（生成 ?key=）。支持 {{环境变量}}。', 'data-tip-ex': '{{pageSize}}   引用环境变量\nabc/def    URL 里的斜杠可直接写，不必编码' },
    },
    headers: {
      key: { 'data-tip-title': 'Header 名', 'data-tip': '标准 HTTP 头名，不区分大小写。留空表示不发送这一行。', 'data-tip-ex': 'Content-Type\nAuthorization\nX-Request-Id     常见的自定义追踪头' },
      val: { 'data-tip-title': 'Header 值', 'data-tip': '同样支持 {{环境变量}}。', 'data-tip-ex': 'application/json\nBearer {{token}}' },
    },
    form: {
      key: { 'data-tip-title': '表单字段名', 'data-tip': '提交为 application/x-www-form-urlencoded。', 'data-tip-ex': 'username\npassword' },
      val: { 'data-tip-title': '字段值', 'data-tip': '特殊字符会自动 URL 编码。', 'data-tip-ex': 'admin\np@ss word   ← 空格会被编码成 +' },
    },
    multipart: {
      key: { 'data-tip-title': '字段名', 'data-tip': '提交为 multipart/form-data。类型选「文件」后可直接选本地文件。', 'data-tip-ex': '普通字段  type=文本\n文件字段  type=文件 → 选择本地文件（≤8MB）' },
      val: { 'data-tip-title': '字段值 / 文件', 'data-tip': '文本类型填值；文件类型点击输入框选择本地文件。', 'data-tip-ex': '文本：abc123\n文件：点击后选文件，boundary 自动生成' },
    },
  };

  // ═══════════════════════════ 通用：键值表 ═══════════════════════════
  function renderKv(containerId, list, opts) {
    const box = $(containerId);
    box.innerHTML = '';
    const o = opts || {};
    const kind = o.kind || containerId.replace('#', '').replace('Table', '');
    const tips = KV_TIPS[kind] || KV_TIPS.params;

    if (!list.length) {
      box.appendChild(el('p', { class: 'empty-note', text: '暂无条目' }));
      return;
    }

    for (const item of list) {
      const row = el('div', { class: 'kv-tr' });

      if (o.checkbox !== false) {
        const cb = el('input', { type: 'checkbox', class: 'chk' });
        cb.checked = item.enabled !== false;
        cb.title = '取消勾选则本次发送时不带这一行';
        cb.addEventListener('change', () => { item.enabled = cb.checked; });
        row.appendChild(cb);
      }

      const k = el('input', { type: 'text', class: 'k', placeholder: o.keyPlaceholder || '参数名', spellcheck: 'false' });
      k.value = item.key || '';
      for (const [attr, val] of Object.entries(tips.key)) k.setAttribute(attr, val);
      k.addEventListener('input', () => { item.key = k.value; });

      let v;
      if (o.fileAware) {
        // multipart：类型可选 文本/文件
        const typeSel = el('select', { class: 'ftype' }, [
          el('option', { value: 'text', text: '文本' }),
          el('option', { value: 'file', text: '文件' }),
        ]);
        typeSel.value = item.type || 'text';
        for (const [attr, val] of Object.entries({
          'data-tip-title': '字段类型',
          'data-tip': '文本 = 普通键值对；文件 = 上传本地文件（自动填 filename 与 MIME）。',
          'data-tip-ex': '文本 → name="field"\n文件 → name="up"; filename="a.txt"',
        })) typeSel.setAttribute(attr, val);
        v = el('input', { type: 'text', class: 'v', placeholder: o.valPlaceholder || '值', spellcheck: 'false' });
        for (const [attr, val] of Object.entries(tips.val)) v.setAttribute(attr, val);

        const syncType = () => {
          item.type = typeSel.value;
          if (typeSel.value === 'file') {
            v.readOnly = true;
            v.placeholder = item.file ? `${item.file.name}（${fmtBytes(item.file.size || 0)}）` : '点击选择文件';
            v.onclick = pickFile;
          } else {
            v.readOnly = false;
            v.placeholder = o.valPlaceholder || '值';
            v.onclick = null;
            styleType();
          }
        };
        const styleType = () => { typeSel.style.display = 'inline-block'; };
        typeSel.addEventListener('change', syncType);

        async function pickFile() {
          const input = el('input', { type: 'file' });
          input.addEventListener('change', async () => {
            const f = input.files && input.files[0];
            if (!f) return;
            if (f.size > 8 * 1024 * 1024) { toast('文件超过 8MB，请改用其他方式上传', 'err'); return; }
            toast('正在读取文件…');
            try {
              const b64 = await global.U.readFileAsBase64(f);
              item.file = { name: f.name, type: f.type || 'application/octet-stream', size: f.size, base64: b64 };
              v.placeholder = `${f.name}（${fmtBytes(f.size)}）`;
              toast(`已附加文件 ${f.name}`, 'ok');
            } catch (e) { toast('读取文件失败：' + e.message, 'err'); }
          });
          input.click();
        }

        row.appendChild(k); row.appendChild(typeSel); row.appendChild(v);
        syncType();
      } else {
        v = el('input', { type: 'text', class: 'v', placeholder: o.valPlaceholder || '值', spellcheck: 'false' });
        v.value = item.value == null ? '' : item.value;
        v.addEventListener('input', () => { item.value = v.value; });
        for (const [attr, val] of Object.entries(tips.val)) v.setAttribute(attr, val);
        row.appendChild(k); row.appendChild(v);
      }

      const del = el('button', { class: 'x-btn', title: '删除', text: '×' });
      del.addEventListener('click', () => {
        const i = list.indexOf(item);
        if (i >= 0) list.splice(i, 1);
        renderKv(containerId, list, o);
        updateCounts();
      });
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  function updateCounts() {
    const n = (l) => l.filter((x) => x.enabled !== false && String(x.key || '').trim()).length;
    $('#cParams').textContent = n(model.params);
    $('#cHeaders').textContent = n(model.headers);
    $('#cBody').textContent = model.bodyType === 'none' ? 0 : n(model.form) + n(model.multipart);
    $('#cTests').textContent = model.assertions.length;
  }

  // ═══════════════════════════ 环境变量 ═══════════════════════════
  function renderEnv() {
    const list = global.Store.getEnv();
    const box = $('#envList');
    box.innerHTML = '';
    if (!list.length) {
      box.appendChild(el('p', { class: 'empty-note', text: '暂无变量' }));
      return;
    }
    for (const item of list) {
      const k = el('input', { type: 'text', class: 'k', placeholder: '变量名', spellcheck: 'false' });
      k.value = item.key || '';
      const v = el('input', { type: 'text', class: 'v', placeholder: '值', spellcheck: 'false' });
      v.value = item.value == null ? '' : item.value;

      // 直接改 model 里的对象，再整体持久化（保持引用一致，避免 DOM 反查错位）
      const persist = () => global.Store.saveEnv(list);
      k.addEventListener('input', () => { item.key = k.value; persist(); });
      v.addEventListener('input', () => { item.value = v.value; persist(); });

      const del = el('button', { class: 'x-btn', title: '删除', text: '×' });
      del.addEventListener('click', () => {
        global.Store.saveEnv(list.filter((x) => x !== item));
        renderEnv();
      });

      box.appendChild(el('div', { class: 'kv-row' }, [k, v, del]));
    }
  }

  // ═══════════════════════════ 断言 ═══════════════════════════
  const SOURCES = [
    ['status', '状态码'], ['statusGroup', '状态码分组'], ['time', '响应时间'],
    ['header', '响应头'], ['cookie', 'Cookie'], ['size', '响应大小'],
    ['headerCount', '响应头数量'], ['cookieCount', 'Cookie 数量'],
    ['bodyJson', 'JSON 字段'], ['bodyText', '响应文本'], ['jsonKeys', 'JSON 键'],
  ];

  const OPERATORS = [
    ['equals', '等于'], ['notEquals', '不等于'], ['contains', '包含'],
    ['notContains', '不包含'], ['matches', '匹配正则'], ['notMatches', '不匹配正则'],
    ['gt', '大于'], ['gte', '大于等于'], ['lt', '小于'], ['lte', '小于等于'],
    ['lengthEquals', '长度等于'], ['greaterThanLength', '长度大于'],
    ['isEmpty', '为空'], ['isNotEmpty', '不为空'], ['isNull', '为 null'],
    ['isNotNull', '不为 null'], ['isNumber', '是数字'], ['isString', '是字符串'],
    ['isBoolean', '是布尔'], ['isArray', '是数组'], ['isObject', '是对象'],
    ['isTrue', '为 true'], ['isFalse', '为 false'], ['hasKey', '路径存在'],
  ];

  const TIME_FIELDS = ['total', 'dns', 'tcp', 'tls', 'ttfb', 'download'];

  function renderAssertions() {
    const box = $('#assertList');
    box.innerHTML = '';
    if (!model.assertions.length) {
      box.appendChild(el('p', { class: 'empty-note', text: '暂无断言。加几条断言，请求发送后会自动判定成败。' }));
      return;
    }

    for (const a of model.assertions) {
      const row = el('div', { class: 'assert-row' + (a._passed !== undefined ? (a._passed ? ' passed' : ' failed') : '') });

      const nameIn = el('input', { type: 'text', placeholder: '断言名称', value: a.name || '' });
      nameIn.setAttribute('data-tip-title', '断言名称');
      nameIn.setAttribute('data-tip', '给这条断言起个名字，结果里靠它定位。留空则自动按「来源.路径 算子」生成。');
      nameIn.setAttribute('data-tip-ex', '登录后返回令牌\n订单创建成功');
      nameIn.addEventListener('input', () => { a.name = nameIn.value; });

      const srcSel = el('select', {}, SOURCES.map(([v, t]) => el('option', { value: v, text: t })));
      srcSel.value = a.source || 'status';
      srcSel.setAttribute('data-tip-title', '断言来源');
      srcSel.setAttribute('data-tip', '从响应的哪个部分取值来判定。');
      srcSel.setAttribute('data-tip-ex', '状态码        → 200 / 404\nJSON 字段      → $.data.id\n响应头        → content-type\n响应时间      → total 毫秒');
      srcSel.addEventListener('change', () => { a.source = srcSel.value; renderAssertions(); });

      const opSel = el('select', {}, OPERATORS.map(([v, t]) => el('option', { value: v, text: t })));
      opSel.value = a.operator || 'equals';
      opSel.setAttribute('data-tip-title', '断言算子');
      opSel.setAttribute('data-tip', '怎么比较实际值与期望值。共 24 种算子。');
      opSel.setAttribute('data-tip-ex', '等于/不等于    精确匹配\n包含/不包含    字符串或数组包含\n匹配正则        ^\\d{3}$\n大于/小于/…    数值或时间比较\n为空/不为空     存在性判断');
      opSel.addEventListener('change', () => { a.operator = opSel.value; });

      // 第三个输入框按 source 语义切换含义
      let third;
      const isGroup = a.source === 'statusGroup';
      const isTime = a.source === 'time';
      if (isGroup) {
        third = el('select', {}, [
          el('option', { value: '2xx', text: '2xx' }), el('option', { value: '3xx', text: '3xx' }),
          el('option', { value: '4xx', text: '4xx' }), el('option', { value: '5xx', text: '5xx' }),
        ]);
        third.value = a.path || '2xx';
        third.addEventListener('change', () => { a.path = third.value; });
        third.className = '';
      } else if (isTime) {
        third = el('select', {}, TIME_FIELDS.map((f) => el('option', { value: f, text: f })));
        third.value = a.path || 'total';
        third.addEventListener('change', () => { a.path = third.value; });
        third.className = '';
      } else {
        third = el('input', {
          type: 'text',
          placeholder: a.source === 'status' ? '如 200'
            : isTime ? '' : a.source === 'bodyJson' ? 'JSON 路径，如 $.data.id'
              : a.source === 'header' ? '响应头名' : a.source === 'cookie' ? 'Cookie 名'
                : a.source === 'jsonKeys' ? '对象路径' : '期望值',
          value: a.value == null ? '' : a.value,
          spellcheck: 'false',
        });
        // path 型的 source，把「路径」和「期望值」分开存
        if (['header', 'cookie', 'jsonKeys', 'bodyJson'].includes(a.source)) {
          third.addEventListener('input', () => { a.path = third.value; });
          third.value = a.path || '';
          third.placeholder = a.source === 'bodyJson' ? 'JSON 路径，如 $.data.id'
            : a.source === 'header' ? '响应头名，如 content-type'
              : a.source === 'cookie' ? 'Cookie 名' : '对象路径，如 $.data';
        } else {
          third.addEventListener('input', () => { a.value = third.value; });
        }
      }

      const del = el('button', { class: 'x-btn', title: '删除', text: '×' });
      del.addEventListener('click', () => {
        const i = model.assertions.indexOf(a);
        if (i >= 0) model.assertions.splice(i, 1);
        renderAssertions();
        updateCounts();
      });

      const mark = el('span', { class: 'pass-mark' });
      if (a._passed !== undefined) {
        mark.textContent = a._passed ? '✓' : '✗';
        mark.style.color = a._passed ? 'var(--ok)' : 'var(--err)';
      }

      row.appendChild(nameIn);
      row.appendChild(srcSel);
      row.appendChild(opSel);
      row.appendChild(third);
      row.appendChild(del);

      if (a._detail) row.appendChild(el('div', { class: 'assert-detail', text: a._detail }));
      box.appendChild(row);
    }
  }

  function addAssertion(rule) {
    const a = Object.assign({
      id: uid('as'), name: '', source: 'status', path: '', operator: 'equals', value: '',
    }, rule || {});
    model.assertions.push(a);
    renderAssertions();
    updateCounts();
  }

  const PRESETS = {
    status200: { name: '状态码 = 200', source: 'status', operator: 'equals', value: '200' },
    status2xx: { name: '状态码为 2xx', source: 'statusGroup', path: '2xx', operator: 'isTrue' },
    statusrange: { name: '响应时间 < 500ms', source: 'time', path: 'total', operator: 'lt', value: '500' },
    ctype: { name: 'Content-Type 含 json', source: 'header', path: 'content-type', operator: 'contains', value: 'application/json' },
    code: { name: 'JSON code = 0', source: 'bodyJson', path: '$.code', operator: 'equals', value: '0' },
    msg: { name: 'JSON msg 非空', source: 'bodyJson', path: '$.msg', operator: 'isNotEmpty' },
    datakeys: { name: 'data 含 id 字段', source: 'bodyJson', path: '$.data', operator: 'hasKey' },
    hasToken: { name: 'JSON 含 token', source: 'bodyJson', path: '$.token', operator: 'isNotNull' },
    len: { name: 'JSON 数组长度 > 0', source: 'bodyJson', path: '$', operator: 'lengthEquals', value: '3' },
  };

  // ═══════════════════════════ 鉴权面板 ═══════════════════════════
  function renderAuth() {
    const box = $('#authFields');
    box.innerHTML = '';
    const type = model.auth.type;

    const addField = (label, key, placeholder, type2, tip) => {
      const inp = el('input', { type: type2 || 'text', placeholder: placeholder || '', spellcheck: 'false' });
      inp.value = model.auth[key] || '';
      if (tip) for (const [attr, val] of Object.entries(tip)) inp.setAttribute(attr, val);
      inp.addEventListener('input', () => { model.auth[key] = inp.value; });
      box.appendChild(el('div', { class: 'field' }, [el('label', { text: label }), inp]));
    };

    if (type === 'basic') {
      addField('用户名', 'username', 'username', 'text', {
        'data-tip-title': 'Basic Auth 用户名',
        'data-tip': '会与密码拼成 user:pass 再做 Base64 编码。',
        'data-tip-ex': 'admin',
      });
      addField('密码', 'password', 'password', 'password', {
        'data-tip-title': 'Basic Auth 密码',
        'data-tip': '明文输入即可，编码由工具自动完成。',
        'data-tip-ex': 'admin123',
      });
    } else if (type === 'bearer') {
      addField('Token', 'token', 'eyJhbGciOi...', 'text', {
        'data-tip-title': 'Bearer Token',
        'data-tip': '自动加 Authorization: Bearer <token> 请求头。常见于 JWT。',
        'data-tip-ex': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...\n从登录接口的响应里复制 token 字段',
      });
    } else if (type === 'apikey') {
      const sel = el('select', {}, [
        el('option', { value: 'header', text: 'Header' }),
        el('option', { value: 'query', text: 'Query 参数' }),
      ]);
      sel.value = model.auth.in || 'header';
      sel.setAttribute('data-tip-title', '放置位置');
      sel.setAttribute('data-tip', 'API Key 放在请求头还是查询参数里，取决于服务端约定。');
      sel.setAttribute('data-tip-ex', 'Header → X-Api-Key: abc\nQuery  → ?api_key=abc');
      sel.addEventListener('change', () => { model.auth.in = sel.value; });
      box.appendChild(el('div', { class: 'field' }, [el('label', { text: '放置位置' }), sel]));
      addField('Key 名', 'key', 'X-Api-Key', 'text', {
        'data-tip-title': 'Key 的名称',
        'data-tip': '服务端约定的键名，必须与服务端一致。',
        'data-tip-ex': 'X-Api-Key    api_key    Authorization',
      });
      addField('Key 值', 'value', '••••••', 'text', {
        'data-tip-title': 'Key 的值',
        'data-tip': '建议用 {{环境变量}} 保存敏感值，避免明文留在请求集合里。',
        'data-tip-ex': '{{apiKey}}    引用环境变量更安全',
      });
    }
  }

  // ═══════════════════════════ 请求体面板 ═══════════════════════════
  function renderBody() {
    const t = model.bodyType;
    $('#bodyRawWrap').classList.toggle('hidden', t !== 'raw');
    $('#bodyFormWrap').classList.toggle('hidden', t !== 'form');
    $('#bodyMultiWrap').classList.toggle('hidden', t !== 'multipart');
    if (t === 'form') renderKv('#formTable', model.form, { keyPlaceholder: '字段名' });
    if (t === 'multipart') renderKv('#multipartTable', model.multipart, { keyPlaceholder: '字段名', fileAware: true });
  }

  // ═══════════════════════════ 集合 & 历史 ═══════════════════════════
  function renderCollection() {
    const box = $('#collList');
    box.innerHTML = '';
    const list = global.Store.getCollection();
    if (!list.length) {
      box.appendChild(el('p', { class: 'empty-note', text: '尚未保存请求' }));
      return;
    }
    for (const item of list) {
      const nameEl = el('span', { class: 'coll-name', text: item.name });
      const del = el('button', { class: 'x-btn', title: '删除', text: '×' });
      del.addEventListener('click', (e) => { e.stopPropagation(); global.Store.deleteRequest(item.id); renderCollection(); });
      const node = el('div', { class: 'coll-item' }, [
        el('span', { class: 'hist-meta', text: (item.method || 'GET').slice(0, 3) }),
        nameEl, del,
      ]);
      node.addEventListener('click', () => loadRequest(item));
      box.appendChild(node);
    }
  }

  function renderHistory() {
    const box = $('#historyList');
    box.innerHTML = '';
    const list = global.Store.getHistory();
    if (!list.length) {
      box.appendChild(el('p', { class: 'empty-note', text: '暂无历史' }));
      return;
    }
    for (const item of list) {
      const d = new Date(item.at);
      const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      const node = el('div', { class: 'hist-item' }, [
        el('span', { class: 'hist-meta', text: hh }),
        el('span', { class: 'coll-name', text: `${item.method} ${String(item.url).slice(0, 40)}` }),
        item.status ? el('span', {
          class: 'pill ' + (item.status < 400 ? 'pill-open' : 'pill-closed'),
          text: String(item.status),
        }) : null,
      ]);
      node.addEventListener('click', () => loadRequest(item));
      box.appendChild(node);
    }
  }

  // ═══════════════════════════ 载入 / 保存请求 ═══════════════════════════
  function toConfig() {
    return {
      method: $('#reqMethod').value,
      url: $('#reqUrl').value.trim(),
      params: model.params,
      headers: model.headers,
      auth: model.auth,
      bodyType: model.bodyType,
      rawBody: model.rawBody,
      contentType: model.contentType,
      form: model.form,
      multipart: model.multipart,
      timeout: model.timeout,
      followRedirects: model.followRedirects,
      insecureTLS: model.insecureTLS,
      env: global.Store.envMap(),
      assertions: model.assertions,
    };
  }

  function loadRequest(item) {
    currentId = item.id || null;
    $('#reqMethod').value = METHODS.includes(item.method) ? item.method : 'GET';
    $('#reqUrl').value = item.url || '';

    model.params = (item.params || []).map((x) => Object.assign({}, x));
    model.headers = (item.headers || []).map((x) => Object.assign({}, x));
    model.form = (item.form || []).map((x) => Object.assign({}, x));
    model.multipart = (item.multipart || []).map((x) => ({ type: 'text', ...x }));
    model.auth = Object.assign({ type: 'none' }, item.auth || {});
    model.bodyType = item.bodyType || 'none';
    model.rawBody = item.rawBody || '';
    model.contentType = item.contentType || 'application/json';
    model.timeout = item.timeout || 30000;
    model.followRedirects = item.followRedirects !== false;
    model.insecureTLS = !!item.insecureTLS;

    if (item.assertions && item.assertions.length) {
      model.assertions = item.assertions.map((a) => Object.assign({ id: uid('as') }, a));
    }

    // 同步 UI
    $('#authType').value = model.auth.type;
    $('#bodyType').value = model.bodyType;
    $('#rawBody').value = model.rawBody;
    $('#rawContentType').value = model.contentType;
    $('#setTimeout').value = model.timeout;
    $('#setRedirect').checked = model.followRedirects;
    $('#setInsecure').checked = model.insecureTLS;

    renderAuth();
    renderBody();
    renderKv('#paramsTable', model.params, { keyPlaceholder: '参数名' });
    renderKv('#headersTable', model.headers, { keyPlaceholder: 'Header 名' });
    renderAssertions();
    updateCounts();
    toast(`已载入「${item.name || item.url}」`);
  }

  // ═══════════════════════════ 发送 ═══════════════════════════
  let sending = false;

  async function send() {
    if (sending) { toast('上一个请求还在发送中', 'err'); return; }

    const config = toConfig();
    if (!config.url) { toast('请输入 URL', 'err'); $('#reqUrl').focus(); return; }

    sending = true;
    $('#reqSend').disabled = true;
    $('#reqSend').textContent = '发送中…';

    const badge = $('#respStatus');
    badge.className = 'resp-status idle';
    badge.textContent = '请求中';

    const t0 = performance.now();
    try {
      const data = await api('/api/http/send', { config });
      const wall = performance.now() - t0;
      renderResult(data, wall);
      global.Store.addHistory({
        method: config.method, url: config.url,
        status: data.response ? data.response.status : 0,
        ms: data.response ? data.response.time.total : 0,
        params: config.params, headers: config.headers, auth: config.auth,
        bodyType: config.bodyType, rawBody: config.rawBody, contentType: config.contentType,
        form: config.form, timeout: config.timeout,
        followRedirects: config.followRedirects, insecureTLS: config.insecureTLS,
      });
      renderHistory();
      saveDraft();
    } catch (e) {
      badge.className = 'resp-status err';
      badge.textContent = '失败';
      $('#respMeta').textContent = e.message;
      $('#respBody').innerHTML = `<span class="placeholder">${escapeHtml(e.message)}</span>`;
      toast('请求失败：' + e.message, 'err');
    } finally {
      sending = false;
      $('#reqSend').disabled = false;
      $('#reqSend').innerHTML = '发送 <kbd>Ctrl</kbd>+<kbd>↵</kbd>';
    }
  }

  // ═══════════════════════════ 响应渲染 ═══════════════════════════
  function renderResult(data, wall) {
    model.lastResult = data;
    const badge = $('#respStatus');

    // 请求级错误（DNS 失败 / 连接拒绝等）
    if (!data.ok || (data.error && !data.response)) {
      badge.className = 'resp-status err';
      badge.textContent = '请求失败';
      const msg = (data.error && data.error.message) || '未知错误';
      $('#respMeta').textContent = msg;
      $('#respBody').innerHTML = `<span class="placeholder">${escapeHtml(msg)}</span>`;
      $('#respHeaders').innerHTML = '<p class="placeholder">—</p>';
      $('#respCookies').innerHTML = '<p class="placeholder">—</p>';
      $('#respTiming').innerHTML = '<p class="placeholder">—</p>';
      $('#respTests').classList.add('hidden');
      toast('请求失败：' + msg, 'err');
      return;
    }

    const r = data.response;
    badge.className = 'resp-status ' + statusClass(r.status);
    badge.textContent = `${r.status} ${r.statusMessage || ''}`.trim();
    $('#respMeta').textContent =
      `${fmtMs(r.time.total)} · ${fmtBytes(r.size)} · HTTP/${r.httpVersion}` +
      (r.remoteAddress ? ` · ${r.remoteAddress}` : '');

    // 响应体
    const bodyBox = $('#respBody');
    if (r.body.type === 'binary') {
      bodyBox.textContent = `[二进制响应] ${r.body.contentType} · ${fmtBytes(r.body.size)}\n不显示文本内容。可用「保存响应」下载。`;
    } else {
      const respCt = ((r.headers.find((h) => /content-type/i.test(h.key)) || {}).value || '');
      let html;
      if (r.body.json) html = global.U.highlightJson(r.body.json);
      else if (/xml/i.test(respCt)) html = global.U.highlightXml(r.body.text);
      else html = escapeHtml(r.body.text) || '<span class="placeholder">(空响应体)</span>';
      if (r.body.truncated) html += '\n\n<span class="tok-null">… 内容过长已截断显示</span>';
      bodyBox.innerHTML = html;
    }
    bodyBox.classList.toggle('nowrap', !$('#bodyWrap').checked);

    // 响应头
    $('#cRespHeaders').textContent = r.headers.length;
    $('#respHeaders').innerHTML = r.headers.length
      ? r.headers.map((h) => el('div', { class: 'kv-view-row' }, [
          el('span', { class: 'kk', text: h.key }),
          el('span', { class: 'vv', text: h.value }),
        ])).join('')
      : '<p class="placeholder">无</p>';

    // Cookie
    $('#cCookies').textContent = r.cookies.length;
    $('#respCookies').innerHTML = r.cookies.length
      ? r.cookies.map((c) => el('div', { class: 'kv-view-row' }, [
          el('span', { class: 'kk', text: c.name }),
          el('span', { class: 'vv', text: `${c.value}  ${c.attrs.join('; ')}` }),
        ])).join('')
      : '<p class="placeholder">响应未设置 Cookie</p>';

    // 耗时分析
    renderTiming(r.time, data.dnsMs);
    renderRedirects(data.redirects || [], r);

    // 实际请求
    const req = data.request || {};
    $('#respRequest').textContent =
      `${req.method} ${req.url}\n\n` +
      Object.entries(req.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n') +
      (req.bodySize ? `\n\n[请求体 ${fmtBytes(req.bodySize)}]\n${req.bodyPreview || ''}` : '');

    // 预览
    const prev = $('#respPreview');
    const ct = (r.headers.find((h) => /content-type/i.test(h.key)) || {}).value || '';
    prev.innerHTML = '';
    if (r.body.type === 'binary') {
      prev.appendChild(el('p', { class: 'placeholder', text: '二进制响应，无法预览' }));
    } else if (/html/i.test(ct)) {
      const frame = el('iframe', {
        style: 'width:100%;height:460px;border:1px solid var(--border);border-radius:4px;background:#fff',
        sandbox: 'allow-same-origin',
      });
      frame.srcdoc = r.body.text;
      prev.appendChild(frame);
    } else if (r.body.json) {
      prev.appendChild(el('p', { class: 'placeholder', text: 'JSON 响应已在「响应体」中格式化显示' }));
    } else {
      prev.appendChild(el('pre', { class: 'code-view', text: r.body.text || '(空)' }));
    }

    // 断言结果
    renderAssertions_result(data.assertions);
    void wall;
  }

  const TIMING_COLORS = {
    dns: '#0891b2', tcp: '#7c3aed', tls: '#d97706',
    server: '#2563eb', download: '#16a34a',
  };

  function renderTiming(time, dnsMs) {
    const box = $('#respTiming');
    box.innerHTML = '';
    if (!time) { box.innerHTML = '<p class="placeholder">—</p>'; return; }

    // 构造分段：DNS→TCP→TLS→服务端处理(TTFB - 前三段)→下载
    const dns = time.dns || dnsMs || 0;
    const tcp = time.tcp || 0;
    const tls = time.tls || 0;
    const ttfb = time.ttfb || 0;
    const server = Math.max(0, ttfb - dns - tcp - tls);
    const download = time.download || 0;
    const segs = [
      { key: 'DNS 解析', ms: dns, color: TIMING_COLORS.dns },
      { key: 'TCP 握手', ms: tcp, color: TIMING_COLORS.tcp },
      { key: 'TLS 握手', ms: tls, color: TIMING_COLORS.tls },
      { key: '服务端处理', ms: server, color: TIMING_COLORS.server },
      { key: '下载响应', ms: download, color: TIMING_COLORS.download },
    ].filter((s) => s.ms > 0);

    const total = segs.reduce((n, s) => n + s.ms, 0) || time.total || 1;

    const bar = el('div', { class: 'timing-bar' });
    for (const s of segs) {
      const pct = Math.max(2, (s.ms / total) * 100);
      bar.appendChild(el('div', {
        class: 'timing-seg',
        style: `width:${pct}%;background:${s.color}`,
        title: `${s.key}: ${fmtMs(s.ms)}`,
        text: pct > 9 ? `${Math.round(pct)}%` : '',
      }));
    }
    box.appendChild(bar);

    const legend = el('div', { class: 'timing-legend' });
    for (const s of segs) {
      legend.appendChild(el('span', { class: 'legend-item' }, [
        el('span', { class: 'legend-dot', style: `background:${s.color}` }),
        `${s.key} ${fmtMs(s.ms)}`,
      ]));
    }
    legend.appendChild(el('span', { class: 'legend-item' }, [
      el('span', { class: 'legend-dot', style: 'background:var(--text)' }),
      `总耗时 ${fmtMs(time.total)}`,
    ]));
    box.appendChild(legend);

    if (time.total > 2000) {
      box.appendChild(el('p', { class: 'hint', text: '⚠ 总耗时超过 2s，建议下调超时时间或检查服务端性能。' }));
    }
  }

  function renderRedirects(list, finalResp) {
    $('#cRedirects').textContent = list.length;
    const box = $('#respRedirects');
    box.innerHTML = '';
    if (!list.length) {
      box.appendChild(el('p', { class: 'placeholder', text: '本次请求没有发生重定向跳转' }));
      return;
    }
    list.forEach((hop, i) => {
      box.appendChild(el('div', { class: 'kv-view-row', style: 'flex-direction:column;align-items:flex-start;margin-bottom:5px' }, [
        el('span', {}, [
          el('b', { text: `${i + 1}. ${hop.status}` }),
          document.createTextNode(`  ${escapeHtml(hop.location)}`),
        ]),
        el('span', { class: 'vv', text: '来自: ' + hop.from }),
      ]));
    });
    box.appendChild(el('p', { class: 'hint', text: `最终响应：${finalResp.status} ${finalResp.statusMessage || ''}` }));
  }

  function renderAssertions_result(res) {
    const box = $('#respTests');
    if (!res || !res.total) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '';

    const allPass = res.failed === 0;
    box.appendChild(el('div', { class: 'test-summary ' + (allPass ? 'pass' : 'fail') }, [
      el('b', { text: allPass ? '✓ 全部断言通过' : `✗ ${res.failed} 条断言失败` }),
      el('span', { text: `通过 ${res.passed} / ${res.total}` }),
    ]));

    for (const r of res.results) {
      box.appendChild(el('div', { class: 'test-line ' + (r.passed ? 'pass' : 'fail') }, [
        el('b', { text: (r.passed ? '✓ ' : '✗ ') + r.name }),
        document.createTextNode('  ' + r.detail),
      ]));
      // 同步到断言列表，方便定位
      const local = model.assertions.find((a) => a.id === r.id);
      if (local) { local._passed = r.passed; local._detail = r.detail; }
    }
    renderAssertions();
    toast(allPass ? `断言全部通过（${res.total} 条）` : `断言失败 ${res.failed} 条`, allPass ? 'ok' : 'err');
  }

  // ═══════════════════════════ cURL 生成 ═══════════════════════════
  function buildCurl() {
    const cfg = toConfig();
    const q = global.U.shellQuote;
    const parts = ['curl'];

    // 变量替换：把 {{x}} 换成实际值，生成可直接执行的命令
    const resolve = (s) => String(s == null ? '' : s).replace(/\{\{\s*([\w.-]+)\s*\}\}/g,
      (m, k) => (cfg.env[k] !== undefined ? cfg.env[k] : m));

    let url = cfg.url.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = 'http://' + url;
    const u = new URL(url);
    for (const p of cfg.params) {
      if (!p.key || p.enabled === false) continue;
      u.searchParams.append(resolve(p.key), resolve(p.value));
    }

    if (cfg.auth.type === 'basic') {
      parts.push('-u', q(`${resolve(cfg.auth.username)}:${resolve(cfg.auth.password)}`));
    } else if (cfg.auth.type === 'bearer' && cfg.auth.token) {
      parts.push('-H', q('Authorization: Bearer ' + resolve(cfg.auth.token)));
    }
    if (cfg.auth.type === 'apikey' && cfg.auth.key) {
      if (cfg.auth.in === 'query') u.searchParams.set(cfg.auth.key, resolve(cfg.auth.value));
      else parts.push('-H', q(`${cfg.auth.key}: ${resolve(cfg.auth.value)}`));
    }

    parts.push('-X', cfg.method);

    for (const h of cfg.headers) {
      if (!h.key || h.enabled === false) continue;
      parts.push('-H', q(`${resolve(h.key)}: ${resolve(h.value)}`));
    }
    if (cfg.insecureTLS) parts.push('-k');
    if (cfg.followRedirects === false) parts.push('--max-redirs', '0');
    else parts.push('-L');

    if (cfg.bodyType === 'raw' && cfg.rawBody) {
      parts.push('-H', q('Content-Type: ' + cfg.contentType));
      parts.push('-d', q(resolve(cfg.rawBody)));
    } else if (cfg.bodyType === 'form') {
      for (const f of cfg.form) {
        if (!f.key || f.enabled === false || f.type === 'file') continue;
        parts.push('--data-urlencode', q(`${resolve(f.key)}=${resolve(f.value)}`));
      }
    } else if (cfg.bodyType === 'multipart') {
      for (const f of cfg.multipart) {
        if (!f.key || f.enabled === false) continue;
        if (f.type === 'file') parts.push('-F', q(`${resolve(f.key)}=@${f.file ? f.file.name : 'file.bin'}`));
        else parts.push('-F', q(`${resolve(f.key)}=${resolve(f.value)}`));
      }
    }

    parts.push(q(u.toString()));
    return parts.join(' ');
  }

  // ═══════════════════════════ 草稿保存 ═══════════════════════════
  function saveDraft() {
    global.Store.saveDraft(toConfig());
  }

  // ═══════════════════════════ 初始化 ═══════════════════════════
  function init() {
    renderEnv();
    renderCollection();
    renderHistory();
    renderAuth();
    renderBody();
    renderAssertions();
    renderKv('#paramsTable', model.params, { keyPlaceholder: '参数名' });
    renderKv('#headersTable', model.headers, { keyPlaceholder: 'Header 名' });
    updateCounts();

    // Tab 切换
    $$('#reqTabs .req-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#reqTabs .req-tab').forEach((b) => b.classList.remove('active'));
        $$('.req-pane').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const pane = $(`.req-pane[data-pane="${btn.dataset.pane}"]`);
        if (pane) pane.classList.add('active');
      });
    });
    $$('#respTabs .resp-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#respTabs .req-tab').forEach((b) => b.classList.remove('active'));
        $$('.resp-pane').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        const pane = $(`.resp-pane[data-rpane="${btn.dataset.rpane}"]`);
        if (pane) pane.classList.add('active');
      });
    });

    // 添加键值行
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-add]');
      if (!btn) return;
      const kind = btn.dataset.add;
      const map = { params: ['#paramsTable', model.params], headers: ['#headersTable', model.headers], form: ['#formTable', model.form], multipart: ['#multipartTable', model.multipart] };
      const conf = map[kind];
      if (!conf) return;
      conf[1].push(kind === 'multipart' ? { key: '', value: '', type: 'text', enabled: true } : { key: '', value: '', enabled: true });
      renderKv(conf[0], conf[1], kind === 'multipart'
        ? { keyPlaceholder: '字段名', fileAware: true }
        : { keyPlaceholder: kind === 'headers' ? 'Header 名' : '参数名' });
      updateCounts();
    });

    // 发送
    $('#reqSend').addEventListener('click', send);
    $('#reqUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && document.activeElement === $('#reqUrl')) {
        e.preventDefault();
        send();
      }
    });

    // 环境变量
    $('#envAdd').addEventListener('click', () => {
      const list = global.Store.getEnv();
      list.push({ key: '', value: '' });
      global.Store.saveEnv(list);
      renderEnv();
    });

    // 鉴权
    $('#authType').addEventListener('change', (e) => {
      model.auth = { type: e.target.value };
      renderAuth();
    });

    // 请求体
    $('#bodyType').addEventListener('change', (e) => {
      model.bodyType = e.target.value;
      renderBody();
      updateCounts();
    });
    $('#rawContentType').addEventListener('change', (e) => { model.contentType = e.target.value; });
    $('#rawBody').addEventListener('input', debounce((e) => { model.rawBody = e.target.value; saveDraft(); }, 350));
    $('#reqUrl').addEventListener('input', debounce(saveDraft, 500));
    $('#reqMethod').addEventListener('change', saveDraft);

    $('#formatJson').addEventListener('click', () => {
      try {
        const v = JSON.parse($('#rawBody').value);
        $('#rawBody').value = JSON.stringify(v, null, 2);
        model.rawBody = $('#rawBody').value;
        $('#rawContentType').value = 'application/json';
        model.contentType = 'application/json';
        toast('JSON 格式化成功', 'ok');
      } catch (e) { toast('JSON 解析失败：' + e.message, 'err'); }
    });

    $('#beautifyXml').addEventListener('click', () => {
      const src = $('#rawBody').value;
      const doc = new DOMParser().parseFromString(src, 'text/xml');
      const err = doc.querySelector('parsererror');
      if (err) { toast('XML 解析失败：' + err.textContent.slice(0, 80), 'err'); return; }
      const formatted = new XMLSerializer().serializeToString(doc);
      const pretty = formatted.replace(/>\s*</g, '>\n<').replace(/></g, '>\n<');
      $('#rawBody').value = pretty;
      model.rawBody = pretty;
      $('#rawContentType').value = 'application/xml';
      model.contentType = 'application/xml';
      toast('XML 美化成功', 'ok');
    });

    // 断言
    $('#addAssert').addEventListener('click', () => addAssertion());
    $('#assertPreset').addEventListener('change', (e) => {
      const p = PRESETS[e.target.value];
      if (p) addAssertion(p);
      e.target.value = '';
    });

    // 设置
    $('#setTimeout').addEventListener('change', (e) => { model.timeout = Number(e.target.value) || 30000; });
    $('#setRedirect').addEventListener('change', (e) => { model.followRedirects = e.target.checked; });
    $('#setInsecure').addEventListener('change', (e) => { model.insecureTLS = e.target.checked; });

    // 响应工具
    $('#bodySearch').addEventListener('input', debounce((e) => {
      const raw = model.lastResult;
      if (!raw || raw.response.body.type !== 'text') return;
      let html;
      if (raw.response.body.json) html = global.U.highlightJson(raw.response.body.json);
      else html = escapeHtml(raw.response.body.text);
      global.U.markMatches($('#respBody'), html, e.target.value.trim());
    }, 220));
    $('#bodyWrap').addEventListener('change', (e) => {
      $('#respBody').classList.toggle('nowrap', !e.target.checked);
    });
    $('#copyBody').addEventListener('click', () => {
      const r = model.lastResult;
      if (!r || !r.response) { toast('还没有响应内容', 'err'); return; }
      copy(r.response.body.type === 'text' ? r.response.body.text : '[二进制响应]', '响应体');
    });
    $('#copyUrl').addEventListener('click', () => copy($('#reqUrl').value, 'URL'));
    $('#copyCurl').addEventListener('click', () => copy(buildCurl(), 'cURL 命令'));
    $('#saveBody').addEventListener('click', () => {
      const r = model.lastResult;
      if (!r || !r.response) { toast('还没有响应内容', 'err'); return; }
      const b = r.response.body;
      if (b.type === 'binary') {
        const bin = atob(b.base64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        global.U.download('response.bin', new Blob([arr], { type: b.contentType }));
      } else {
        global.U.download('response.json', b.json ? JSON.stringify(b.json, null, 2) : b.text);
      }
      toast('响应已保存', 'ok');
    });

    // 集合
    $('#saveReq').addEventListener('click', () => {
      const cfg = toConfig();
      if (!cfg.url) { toast('URL 为空，无法保存', 'err'); return; }
      const name = window.prompt('保存为（请求名称）', `${cfg.method} ${cfg.url}`.slice(0, 60));
      if (!name) return;
      const rec = global.Store.saveRequest(Object.assign({}, cfg, { name }));
      currentId = rec.id;
      renderCollection();
      toast(`已保存「${name}」`, 'ok');
    });
    $('#exportColl').addEventListener('click', () => {
      const list = global.Store.getCollection();
      if (!list.length) { toast('集合为空', 'err'); return; }
      global.U.download('netcheck-collection.json', JSON.stringify(list, null, 2), 'application/json');
      toast('已导出', 'ok');
    });
    $('#importColl').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await global.U.readFileAsText(f));
        const list = Array.isArray(data) ? data : (data.collection || []);
        if (!list.length) { toast('文件中没有可导入的请求', 'err'); return; }
        const existing = global.Store.getCollection();
        for (const item of list) {
          existing.push(Object.assign({ id: uid('req') }, item));
        }
        // 集合整体回写（Store 只暴露单条增删，这里直接落盘）
        localStorage.setItem('netcheck.collection', JSON.stringify(existing));
        renderCollection();
        toast(`已导入 ${list.length} 个请求`, 'ok');
      } catch (err) { toast('导入失败：' + err.message, 'err'); }
      e.target.value = '';
    });
    $('#clearHistory').addEventListener('click', () => {
      global.Store.clearHistory();
      renderHistory();
      toast('历史已清空');
    });

    // 恢复草稿
    const draft = global.Store.getDraft();
    if (draft && draft.url) {
      loadRequest(Object.assign({}, draft, { id: null }));
      toast('已恢复上次的请求（可点「清空」重来）');
    } else {
      $('#reqUrl').value = 'https://httpbin.org/get';
      renderKv('#headersTable', model.headers, { keyPlaceholder: 'Header 名' });
    }
  }

  // 记录最后一次结果，供搜索/复制使用
  global.ApiPanel = {
    init,
    buildCurl,
    get lastResult() { return model.lastResult; },
  };
})(window);