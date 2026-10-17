/* 入口：标签页切换 + 后端连通性检测 */
(function (global) {
  'use strict';
  const { $, $$, api, el } = global.U;

  function initTabs() {
    $$('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tab').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
        $$('.panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        const panel = $(`#panel-${btn.dataset.tab}`);
        if (panel) panel.classList.add('active');
        if (btn.dataset.tab === 'sysinfo') loadSysInfo();
      });
    });
  }

  /** 探测本地后端是否在线——直接双击 index.html 打开时能用上。 */
  async function checkBackend() {
    const badge = $('#connBadge');
    try {
      const data = await Promise.race([
        api('/api/system', undefined, 3000),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
      ]);
      badge.className = 'badge badge-online';
      badge.textContent = '● 后端已连接';
      return data;
    } catch (e) {
      badge.className = 'badge badge-offline';
      badge.textContent = '● 后端未连接';
      badge.title = e.message + '（若以 file:// 直接打开，请改用 http://127.0.0.1:7801/ 访问）';
      return null;
    }
  }

  async function loadSysInfo() {
    const box = $('#sysBody');
    const data = await checkBackend();
    if (!data) {
      box.innerHTML =
        '<p class="placeholder">无法连接本地后端。<br>' +
        '请在项目目录下执行 <code>node server.js</code> 后，通过 http://127.0.0.1:7801/ 访问本页面。</p>';
      return;
    }

    box.innerHTML = '';
    box.appendChild(el('table', { class: 'sys-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: '项目' }), el('th', { text: '值' }),
      ])),
      el('tbody', {}, [
        el('tr', {}, [el('td', { text: '主机名' }), el('td', { text: data.hostname })]),
        el('tr', {}, [el('td', { text: '操作系统' }), el('td', { text: data.platform })]),
        el('tr', {}, [el('td', { text: 'Node 版本' }), el('td', { text: data.nodeVersion })]),
        el('tr', {}, [el('td', { text: '网卡数量' }), el('td', { text: String(data.interfaces.length) })]),
      ]),
    ]));

    box.appendChild(el('h3', { text: '网卡地址', style: 'font-size:14px;margin:16px 0 8px' }));
    box.appendChild(el('table', { class: 'sys-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: '网卡名' }), el('th', { text: 'IP 地址' }),
        el('th', { text: '协议' }), el('th', { text: 'MAC 地址' }),
      ])),
      el('tbody', {}, data.interfaces.map((i) => el('tr', {}, [
        el('td', { text: i.name }),
        el('td', { text: i.address }),
        el('td', { text: i.family }),
        el('td', { text: i.mac }),
      ]))),
    ]));

    box.appendChild(el('p', {
      class: 'hint',
      text: '提示：检测内网主机时，请确认「网卡地址」中有与目标主机同网段的 IP。若同时存在 VPN 网段（常见 10.x / 192.168.x），请留意路由选择是否正确。',
    }));
  }

  function init() {
    initTabs();
    global.Tip.init();
    global.PortPanel.init();
    global.ApiPanel.init();
    checkBackend();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);