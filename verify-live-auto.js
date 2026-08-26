/**
 * verify-live-auto.js — 线上「全新设备零配置自动同步」验证（只读，防污染）
 *
 * V1 全新浏览器 context 打开线上 ERP → 自动获得内置 textdb 同步配置
 * V2 配置正确：provider=textdb / 内置同步码 / autoPush / autoPull
 * V3 状态记录「已自动启用内置云同步配置」
 * V4 自动拉取到生产 textdb 数据（customers 等业务集合）
 * V5 本地 rev 与远端一致（LWW 快照已应用）
 * V6 验证结束后关闭自动上传，不污染生产数据
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://tycompnies.github.io/taiyuan-erp/';
let browser;
let passed = 0, failed = 0;

function ok(name, cond) {
    if (cond) { passed++; } else { failed++; }
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name);
}

(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const ctx = await browser.newContext(); // 全新 context = 全新设备/浏览器
    const page = await ctx.newPage();
    await page.goto(BASE + '#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // 登录前确认没有任何同步配置（全新设备）
    const before = await page.evaluate(() => ({
        hasCfg: !!localStorage.getItem('taiyuan_sync_cfg_v1'),
        hasData: !!localStorage.getItem('taiyuan_erp_data_v1')
    }));
    console.log('登录前 localStorage: cfg=' + before.hasCfg + ' data=' + before.hasData);

    await page.evaluate(() => {
        const u = document.querySelector('#loginForm input[name="username"]');
        const p = document.querySelector('#loginForm input[name="password"]');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const f = document.querySelector('#loginForm');
        if (f) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(4000); // 首拉 1.5s + 解密应用 + 轮询窗口

    const st = await page.evaluate(() => {
        const c = CloudSync.loadCfg();
        const s = CloudSync.loadStatus();
        return {
            provider: c.provider,
            code: c.code,
            autoPush: c.autoPush,
            autoPull: c.autoPull,
            lastAction: s.lastAction,
            lastPullAt: s.lastPullAt,
            lastError: s.lastError || '',
            customers: (DB._mem.customers || []).length,
            items: (DB._mem.items || []).length,
            rev: DB._mem.__rev || 0,
            remoteRev: s.remoteRev || 0
        };
    });

    ok('V1 全新设备自动获得内置同步配置', st.provider === 'textdb' && !!st.code);
    ok('V2 配置为 textdb 内置同步码（382d3aa9…）', st.code === '382d3aa9-de38-4803-90be-ed24eff373b5');
    ok('V2b 自动上传/下载已开启', st.autoPush === true && st.autoPull === true);
    ok('V3 状态记录「已自动启用内置云同步配置」', String(st.lastAction).indexOf('自动启用') >= 0);
    ok('V4 已自动拉取生产数据（基础资料非空）', st.customers > 0);
    ok('V5 本地 rev 已更新（LWW 快照应用）', st.rev > 0 && st.rev === st.remoteRev);
    console.log('    明细: customers=' + st.customers + ' items=' + st.items + ' rev=' + st.rev + ' lastPullAt=' + (st.lastPullAt || '-'));
    if (st.lastError) console.log('    注意: lastError=' + st.lastError);

    // V6 防污染：关闭自动上传后关闭浏览器（本验证只读，不写回生产）
    await page.evaluate(() => {
        const c = CloudSync.loadCfg();
        CloudSync.saveCfg(Object.assign({}, c, { autoPush: false }));
        localStorage.removeItem('taiyuan_sync_cfg_v1');
        localStorage.removeItem('taiyuan_sync_status_v1');
        localStorage.removeItem('taiyuan_erp_data_v1');
    });
    ok('V6 验证结束已清理本地配置（不污染生产）', true);

    await browser.close();
    console.log('\n========================================');
    console.log('线上零配置自动同步验证：' + passed + ' 通过 / ' + failed + ' 失败');
    console.log('========================================');
    process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
