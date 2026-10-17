/* 端口连通性检测面板 */
(function (global) {
  'use strict';
  const { $, el, api, toast, fmtMs, download } = global.U;

  const state = { rows: [], aborted: false, running: false, startedAt: 0, meta: {} };

  // ───────────── DNS 结果展示 ─────────────
  function renderDns(host, dns) {
    const box = $('#pcDns');
    box.classList.remove('hidden');
    box.classList.remove('err');

    if (!dns) {
      box.classList.add('err');
      box.innerHTML = '<div class="dns-title">DNS 解析</div><div class="dns-line">未获取</div>';
      return;
    }
    if (!dns.ok) {
      box.classList.add('err');
      box.innerHTML =
        '<div class="dns-title">✕ DNS 解析失败</div>' +
        `<div class="dns-line">${global.U.escapeHtml(host)} → ${global.U.escapeHtml(dns.error)}</div>` +
        '<div class="dns-line">该主机名无法解析，请检查拼写、DNS 设置或是否需要 VPN</div>';
      return;
    }
    const addrs = dns.addresses.map((a) => `${a.address} <span style="opacity:.65">(${a.family})</span>`);
    box.innerHTML =
      '<div class="dns-title">✓ DNS 解析成功 · ' + global.U.escapeHtml(host) + '</div>' +
      `<div class="dns-line">${addrs.join('<br>')}</div>` +
      `<div class="dns-line" style="margin-top:3px;opacity:.75">耗时 ${global.U.fmtMs(dns.resolveMs)}</div>`;
  }

  // ───────────── 表格渲染 ─────────────
  function statusPill(r) {
    if (r.open) return el('span', { class: 'pill pill-open', text: '开放' });
    if (r.errorCode === 'ETIMEDOUT' || /超时/.test(r.reason || '')) {
      return el('span', { class: 'pill pill-timeout', text: '超时' });
    }
    return el('span', { class: 'pill pill-closed', text: '关闭' });
  }

  function renderTable() {
    const tbody = $('#pcTableBody');
    tbody.innerHTML = '';

    const keyword = $('#pcFilter').value.trim().toLowerCase();
    const onlyOpen = $('#pcOnlyOpen').checked;

    let rows = state.rows;
    if (onlyOpen) rows = rows.filter((r) => r.open);
    if (keyword) {
      rows = rows.filter((r) =>
        String(r.port).includes(keyword) ||
        String(r.service || '').toLowerCase().includes(keyword) ||
        String(r.reason || '').toLowerCase().includes(keyword) ||
        String(r.banner || '').toLowerCase().includes(keyword)
      );
    }

    if (!rows.length) {
      tbody.appendChild(el('tr', { class: 'empty-row' },
        el('td', { colspan: '4', text: state.rows.length ? '没有符合条件的记录' : '输入目标后点击「开始检测」' })));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const serviceCell = el('td');
      if (r.service) serviceCell.appendChild(el('div', { class: 'svc', text: r.service }));
      serviceCell.appendChild(el('div', { class: 'svc-detail', text: r.open ? (r.reason || '连接成功') : (r.reason || '—') }));
      if (r.banner) serviceCell.appendChild(el('pre', { class: 'banner', text: r.banner }));

      frag.appendChild(el('tr', { class: r.open ? 'row-open' : '' }, [
        el('td', { class: 'port-num', text: String(r.port) }),
        el('td', {}, statusPill(r)),
        serviceCell,
        el('td', { class: 'latency', text: r.open ? fmtMs(r.latencyMs) : '—' }),
      ]));
    }
    tbody.appendChild(frag);
  }

  function renderStats() {
    const total = state.rows.length;
    const open = state.rows.filter((r) => r.open).length;
    $('#statTotal').textContent = total;
    $('#statOpen').textContent = open;
    $('#statClosed').textContent = total - open;
    $('#statTime').textContent = state.meta.elapsedMs ? fmtMs(state.meta.elapsedMs) : '—';
  }

  // ───────────── 执行 ─────────────
  async function run() {
    const host = $('#pcHost').value.trim();
    const ports = $('#pcPorts').value.trim();

    if (!host) { toast('请输入 IP 地址或机器名', 'err'); $('#pcHost').focus(); return; }
    if (!ports) { toast('请输入端口', 'err'); $('#pcPorts').focus(); return; }

    state.aborted = false;
    state.running = true;
    state.rows = [];
    state.meta = {};
    $('#pcRun').disabled = true;
    $('#pcStop').disabled = false;
    $('#pcTableBody').innerHTML = '';
    renderStats();

    const payload = {
      host,
      ports,
      timeout: Number($('#pcTimeout').value) || 1500,
      concurrency: Number($('#pcConc').value) || 50,
      grabBanner: $('#pcBanner').checked,
    };

    const t0 = performance.now();
    $('#pcProgressWrap').classList.remove('hidden');

    try {
      const data = await api('/api/port/scan', payload);
      if (state.aborted) return;

      state.rows = data.results || [];
      state.meta = { elapsedMs: data.summary ? null : null };
      // 后端不返回耗时，前端自己量（含网络传输）
      state.meta.elapsedMs = performance.now() - t0;

      renderDns(data.host, data.dns);
      if (data.warnings && data.warnings.length) {
        toast('部分端口无法解析：' + data.warnings.join('; '), 'err');
      }
      renderStats();
      renderTable();
      $('#pcProgressBar').style.width = '100%';
      $('#pcProgressText').textContent = `${state.rows.length} / ${state.rows.length}`;

      const open = state.rows.filter((r) => r.open).length;
      toast(`检测完成：${state.rows.length} 个端口，${open} 个开放`, open ? 'ok' : '');
    } catch (e) {
      toast('检测失败：' + e.message, 'err');
      renderDns(host, { ok: false, error: e.message });
    } finally {
      state.running = false;
      $('#pcRun').disabled = false;
      $('#pcStop').disabled = true;
      setTimeout(() => $('#pcProgressWrap').classList.add('hidden'), 1200);
    }
  }

  // ───────────── CSV 导出 ─────────────
  function exportCsv() {
    if (!state.rows.length) { toast('没有可导出的结果', 'err'); return; }
    // CSV 字段转义：含逗号/引号/换行的值必须整体加引号
    const q = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [['端口', '状态', '服务', '响应时间(ms)', '错误码', '说明', 'Banner'].map(q).join(',')];
    for (const r of state.rows) {
      lines.push([
        r.port,
        r.open ? '开放' : '关闭',
        r.service || '',
        r.open && r.latencyMs != null ? r.latencyMs : '',
        r.errorCode || '',
        r.reason || '',
        (r.banner || '').replace(/\r?\n/g, ' '),
      ].map(q).join(','));
    }
    const host = $('#pcHost').value.trim() || 'target';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    // 文件名去掉 Windows 非法字符
    const safe = host.replace(/[^\w.-]/g, '_');
    download(`端口检测_${safe}_${stamp}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    toast('CSV 已导出', 'ok');
  }

  // ───────────── 初始化 ─────────────
  function init() {
    // 默认填一个本机常见端口，用户可直接点开始
    $('#pcHost').value = '127.0.0.1';
    $('#pcPorts').value = '22,80,443,3306,5432,6379,8080';

    $('#pcRun').addEventListener('click', run);
    $('#pcStop').addEventListener('click', () => {
      state.aborted = true;
      toast('已停止（服务端连接会在超时后自动收敛）');
    });
    $('#pcClear').addEventListener('click', () => {
      state.rows = [];
      $('#pcDns').classList.add('hidden');
      $('#pcFilter').value = '';
      $('#pcOnlyOpen').checked = false;
      renderStats();
      renderTable();
      toast('已清空');
    });
    $('#pcFilter').addEventListener('input', global.U.debounce(renderTable, 180));
    $('#pcOnlyOpen').addEventListener('change', renderTable);
    $('#pcExport').addEventListener('click', exportCsv);

    // Enter 触发检测
    $('#pcHost').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    $('#pcPorts').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

    // 常用预设
    document.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        $('#pcHost').value = chip.dataset.hosts || chip.dataset.host || '';
        if (chip.dataset.ports) $('#pcPorts').value = chip.dataset.ports;
        run();
      });
    });

    renderStats();
    renderTable();
  }

  global.PortPanel = { init };
})(window);