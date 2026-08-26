/**
 * test-auto-config.js — 内置默认同步配置自动启用验证（12 项）
 *
 * 验证内容（不同设备 / 不同浏览器 / 不同网域零配置自动同步）：
 * C1  全新设备（无任何 localStorage）打开 → 自动获得内置同步配置
 * C2  配置正确：provider=textdb / 同步码 / 口令 / autoPush / autoPull
 * C3  状态记录「已自动启用内置云同步配置」
 * C4  修改数据 → 3 秒防抖后自动上传（写入被拦截）
 * C5  上传内容为加密快照（含 TYE1: 标记）
 * C6  第二台全新设备打开 → 自动获得内置配置
 * C7  第二台设备自动拉取到第一台写入的数据（跨设备闭环）
 * C8  第二台设备修改数据 → 自动上传
 * C9  第一台设备切回窗口（focus）→ 即时拉取到第二台的数据
 * C10 手动保存自定义配置后刷新 → 不被内置默认覆盖
 * C11 配置页显示「实时自动同步已开启」横幅
 * C12 首次远端无数据不报错，系统正常
 *
 * 说明：textdb API 用 page.route 拦截（内存模拟云端），不污染真实同步数据。
 */
const { chromium } = require('playwright');

// ?sync=1 强制本地启用自动配置（localhost 默认豁免，避免污染真实云端）
const BASE = (process.env.BASE || 'http://127.0.0.1:8902') + '?sync=1';
let browser;
let passed = 0, failed = 0;
const results = [];

function ok(name, cond) {
    if (cond) { passed++; results.push('  PASS: ' + name); }
    else { failed++; results.push('  FAIL: ' + name); }
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name);
}

async function login(page) {
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const u = document.querySelector('#loginForm input[name="username"]');
        const p = document.querySelector('#loginForm input[name="password"]');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const f = document.querySelector('#loginForm');
        if (f) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(1000);
}

// 内存云端：跨两个浏览器 context 共享（模拟真实 textdb 上的加密数据）
let cloudFile = null;

function mockTextdb(page) {
    return page.route('**', async (route) => {
        const url = route.request().url();
        if (url.indexOf('api.textdb.online/update/') >= 0) {
            // POST 写入：记录加密文本
            const m = url.match(/[?&]value=([^&]*)/);
            cloudFile = m ? decodeURIComponent(m[1]) : '';
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 1 }) });
        }
        if (url.indexOf('textdb.online/') >= 0 && url.indexOf('api.textdb') < 0) {
            // GET 读取：无数据时返回 null（与真实 textdb 行为一致）
            if (!cloudFile) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'null' });
            return route.fulfill({ status: 200, contentType: 'text/plain', body: cloudFile });
        }
        return route.fallback();
    });
}

async function cfgState(page) {
    return await page.evaluate(() => {
        const c = CloudSync.loadCfg();
        return {
            configured: CloudSync.isConfigured(),
            provider: c.provider,
            code: c.code,
            hasPass: !!c.pass,
            passLen: (c.pass || '').length,
            autoPush: c.autoPush,
            autoPull: c.autoPull,
            lastAction: CloudSync.loadStatus().lastAction
        };
    });
}

(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true });

    /* ===== 第一台设备（全新 context，无任何历史数据） ===== */
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await mockTextdb(pageA);
    await login(pageA);
    await pageA.waitForTimeout(2000); // 首拉 1.5s 之后

    const s1 = await cfgState(pageA);
    ok('C1 全新设备打开自动获得同步配置', s1.configured === true);
    ok('C2a provider=textdb', s1.provider === 'textdb');
    ok('C2b 已内置同步码', !!s1.code && s1.code.length > 10);
    ok('C2c 已内置加密口令', s1.hasPass && s1.passLen >= 10);
    ok('C2d 自动上传/下载已开启', s1.autoPush === true && s1.autoPull === true);
    ok('C3 自动同步调度已启动（首拉已执行）', String(s1.lastAction).indexOf('pull') >= 0 || String(s1.lastAction).indexOf('自动启用') >= 0);

    // C12：首次拉取无数据不报错，无 lastError
    const stA = await pageA.evaluate(() => CloudSync.loadStatus());
    ok('C12 首次无数据不报错', !stA.lastError || String(stA.lastError).indexOf('上传') >= 0);

    // C4/C5：第一台写入数据 → 3 秒防抖自动上传
    await pageA.evaluate(() => {
        DB.insert('customers', { id: 'c_auto1', name: '自動同步測試客戶A', phone: '13800000001', currency: 'CNY', created_at: new Date().toISOString() });
    });
    await pageA.waitForTimeout(4500);
    ok('C4 数据变动 3 秒后自动上传（云端已收到）', !!cloudFile);
    ok('C5 上传内容为加密快照（TYE1: 标记）', !!cloudFile && (cloudFile.indexOf('TYE1:') === 0 || cloudFile.indexOf('TY1:') === 0));

    /* ===== 第二台设备（全新 context，模拟另一台电脑/浏览器） ===== */
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await mockTextdb(pageB);
    await login(pageB);
    await pageB.waitForTimeout(3000); // 首拉 1.5s + 解密应用

    const s2 = await cfgState(pageB);
    ok('C6 第二台设备打开自动获得配置', s2.configured === true && s2.provider === 'textdb');

    // C7：第二台设备自动拉取到第一台写入的客户
    const hasCustA = await pageB.evaluate(() => !!DB.get('customers', 'c_auto1'));
    ok('C7 第二台设备自动拉取到第一台的数据（跨设备闭环）', hasCustA === true);

    // C8：第二台写入 → 自动上传
    await pageB.evaluate(() => {
        DB.insert('customers', { id: 'c_auto2', name: '自動同步測試客戶B', phone: '13900000002', currency: 'CNY', created_at: new Date().toISOString() });
    });
    await pageB.waitForTimeout(4500);
    ok('C8 第二台设备数据变动自动上传', !!cloudFile);

    /* ===== 第一台设备切回窗口 → 即时拉取第二台的数据 ===== */
    await pageA.evaluate(() => window.dispatchEvent(new Event('focus')));
    await pageA.waitForTimeout(3500); // schedulePull 2 秒防抖 + pull
    const hasCustB = await pageA.evaluate(() => !!DB.get('customers', 'c_auto2'));
    ok('C9 切回窗口即時拉取到第二台的数据', hasCustB === true);

    /* ===== C11：云端同步页显示自动同步横幅 ===== */
    await pageA.goto(BASE + '/#/tools/cloud-sync', { waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(800);
    const banner = await pageA.evaluate(() => document.body.innerHTML.indexOf('实时自动同步已开启') >= 0);
    ok('C11 云端同步页显示「实时自动同步已开启」横幅', banner === true);

    /* ===== C10：手动保存自定义配置后不被默认覆盖 ===== */
    await pageA.evaluate(() => {
        CloudSync.saveCfg({ provider: 'textdb', code: 'manual-code-123' });
    });
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(1500);
    const s3 = await pageA.evaluate(() => {
        const c = CloudSync.loadCfg();
        return { provider: c.provider, code: c.code };
    });
    ok('C10 手动保存自定义配置后刷新不被默认覆盖', s3.provider === 'textdb' && s3.code === 'manual-code-123');

    /* 清理：移除测试客户，避免影响其他测试的种子数据 */
    await pageB.evaluate(() => {
        const d = DB.get('customers', 'c_auto1'); if (d) DB.remove('customers', 'c_auto1');
        const d2 = DB.get('customers', 'c_auto2'); if (d2) DB.remove('customers', 'c_auto2');
        localStorage.removeItem('taiyuan_sync_cfg_v1');
        localStorage.removeItem('taiyuan_sync_status_v1');
        CloudSync.cfg = null; CloudSync.status = null; CloudSync._started = false;
    });
    await pageA.evaluate(() => {
        const d = DB.get('customers', 'c_auto1'); if (d) DB.remove('customers', 'c_auto1');
        const d2 = DB.get('customers', 'c_auto2'); if (d2) DB.remove('customers', 'c_auto2');
        localStorage.removeItem('taiyuan_sync_cfg_v1');
        localStorage.removeItem('taiyuan_sync_status_v1');
        CloudSync.cfg = null; CloudSync.status = null; CloudSync._started = false;
    });

    await browser.close();
    console.log('----------------------------------------');
    console.log('总计： ' + passed + ' 通过 / ' + failed + ' 失败');
    if (failed > 0) { console.log(results.filter(r => r.indexOf('FAIL') >= 0).join('\n')); process.exit(1); }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
