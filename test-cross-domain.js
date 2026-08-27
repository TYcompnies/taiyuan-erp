/**
 * test-cross-domain.js — 跨网域 / 跨网络同步验证（用户：「在不同網域是沒有連動的」）
 *
 * 覆盖场景：
 *   D1  手机 4G：textdb 主通道不可达 + 有 GitHub 令牌 → push 自动切换 GitHub 备用通道成功
 *   D2  手机 4G：textdb 不可达 + 无令牌 → push 失败并提示配置备用令牌
 *   D3  GitHub 主通道不可达 + 有 textdb 同步码 → push 自动切换 textdb 备用通道成功
 *   D4  pull 双源对账：textdb 旧 + GitHub 新（手机 fallback push 后）→ 读到 GitHub 较新版本；
 *       反向（textdb 新 + GitHub 旧）→ 仍取 textdb 较新
 *   D5  fetch 超时：textdb 挂起 → 超时快速失败并切换 GitHub 备用通道成功（不卡死）
 *   D6  配置自愈：残缺配置（textdb 空码）→ startAuto 自动恢复统一数据空间（默认配置）
 *   D7  manual 尊重：用户手动保存过配置 → 自愈不覆盖
 *   D8  同步空间标识：云端同步页显示「同步空间：textdb · 382d3aa9…」
 *   D9  端到端复现用户场景：手机（textdb 不通）删除客户 → fallback GitHub push；
 *       电脑（textdb 通但旧）双源对账 pull → 自动看到删除（跨网域闭环）
 */
const { chromium } = require('playwright');

const BASE = (process.env.BASE || 'http://127.0.0.1:8904') + '?sync=1';
let passed = 0, failed = 0;
const results = [];

function ok(name, cond, extra) {
    if (cond) { passed++; results.push('  PASS: ' + name); }
    else { failed++; results.push('  FAIL: ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : '')); }
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name + (extra !== undefined ? ' | ' + JSON.stringify(extra) : ''));
}

/* ---- 内存云端模拟（双源：textdb + GitHub） ---- */
let cloudFile = null;   // textdb 主源数据
let ghFile = null;      // GitHub 备份源数据
let textdbDown = false, textdbHang = false, ghDown = false;

function mockAll(page) {
    return page.route('**', async (route) => {
        const url = route.request().url();
        if (url.indexOf('api.textdb.online/update/') >= 0) {
            if (textdbDown) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
            if (textdbHang) return; // 挂起（不响应，测超时）
            const m = url.match(/[?&]value=([^&]*)/);
            cloudFile = m ? decodeURIComponent(m[1]) : '';
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 1 }) });
        }
        if (url.indexOf('textdb.online/') >= 0 && url.indexOf('api.textdb') < 0) {
            if (textdbDown) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
            if (textdbHang) return;
            if (!cloudFile) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'null' });
            return route.fulfill({ status: 200, contentType: 'text/plain', body: cloudFile });
        }
        if (url.indexOf('api.github.com/repos/') >= 0) {
            if (ghDown) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
            const method = route.request().method();
            if (method === 'PUT') {
                try {
                    const j = JSON.parse(route.request().postData() || '{}');
                    ghFile = Buffer.from(j.content || '', 'base64').toString();
                } catch (e) { }
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: { sha: 'mock' } }) });
            }
            if (!ghFile) return route.fulfill({ status: 404, contentType: 'text/plain', body: '404' });
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: Buffer.from(ghFile).toString('base64'), sha: 'mock-sha' }) });
        }
        if (url.indexOf('raw.githubusercontent.com/') >= 0 || url.indexOf('cdn.jsdelivr.net/gh/') >= 0) {
            if (!ghFile) return route.fulfill({ status: 404, contentType: 'text/plain', body: '404' });
            return route.fulfill({ status: 200, contentType: 'text/plain', body: ghFile });
        }
        return route.fallback();
    });
}

async function login(page) {
    await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
        const u = document.querySelector('#loginForm input[name="username"]');
        const p = document.querySelector('#loginForm input[name="password"]');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const f = document.querySelector('#loginForm');
        if (f) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(1200);
}

// 停掉自动轮询/首拉（测试时序受控），并保持关闭
const stopAuto = (p) => p.evaluate(() => {
    if (CloudSync._pullTimer) { clearInterval(CloudSync._pullTimer); CloudSync._pullTimer = null; }
    CloudSync._started = true;
});

// 构造合法加密快照字符串（pass 为空 → TY1: 压缩）
async function makeSnap(page, rev, customers) {
    return page.evaluate(([r, custs]) => {
        const payload = {
            __rev: r, __device: 'D' + r, __hash: '',
            customers: custs, suppliers: [], items: [], warehouses: [], units: [],
            currencies: [], categories: [], shipping_methods: [], payment_terms: [],
            roles: [], users: [], sales_orders: [], purchase_orders: [], shipments: [],
            inventory_adjusts: [], sales_returns: [], purchase_returns: [], expenses: [],
            vouchers: [], chart_accounts: []
        };
        const snap = { v: 1, rev: r, device: 'D' + r, updated_at: new Date().toISOString(), payload };
        return CloudSync._encrypt(CloudSync._compress(JSON.stringify(snap)));
    }, [rev, customers]);
}

(async () => {
    const browser = await chromium.launch({ channel: 'msedge', headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();   // 手机
    const pageB = await ctx.newPage();  // 电脑
    await mockAll(page);
    await mockAll(pageB);
    await login(page); await login(pageB);
    await page.waitForTimeout(1500); await pageB.waitForTimeout(1500); // 首拉跑完
    await stopAuto(page); await stopAuto(pageB);

    const cfg = (p, c) => p.evaluate(cc => CloudSync.saveCfg(cc), c);
    const push = (p) => p.evaluate(() => CloudSync.push(false));
    const snapRev = (p, enc) => p.evaluate(e => CloudSync.parseSnapshot(e).then(s => s.rev), enc);

    /* ===== D1：手机 4G（textdb 不可达）+ GitHub 令牌 → 备用通道上传成功 ===== */
    console.log('\n[D1] textdb 主通道不可达 + 有 GitHub 令牌 → push 自动切备用通道');
    await cfg(page, { provider: 'textdb', code: 'TD-D1', ghToken: 'ghp_D1', ghRepo: 'TY/r', ghPath: 'erp-sync.json', pass: '', autoPush: false, autoPull: false });
    textdbDown = true;
    const r1 = await push(page);
    ok('D1a 备用通道上传成功', r1 === true, { r1 });
    ok('D1b GitHub 备用源已写入数据', !!ghFile);
    ok('D1c textdb 主源未写入（不可达）', cloudFile === null);

    /* ===== D2：textdb 不可达 + 无令牌 → 失败并提示 ===== */
    console.log('\n[D2] textdb 不可达 + 无令牌 → push 失败且有明确提示');
    await cfg(page, { provider: 'textdb', code: 'TD-D2', ghToken: '', ghRepo: 'TY/r', ghPath: 'erp-sync.json', pass: '', autoPush: false, autoPull: false });
    const r2 = await push(page);
    const err2 = await page.evaluate(() => CloudSync.loadStatus().lastError || "");
    ok('D2a push 失败', r2 === false, { r2 });
    ok('D2b 错误提示建议配置备用令牌', err2.indexOf('备用令牌') >= 0, { err2 });

    /* ===== D3：GitHub 主通道不可达 + 有 textdb 码 → 切 textdb 备用通道成功 ===== */
    console.log('\n[D3] GitHub 主通道不可达 + 有 textdb 码 → push 自动切 textdb 备用通道');
    await cfg(page, { provider: 'github', ghToken: 'ghp_D3', ghRepo: 'TY/r', ghPath: 'erp-sync.json', code: 'TD-D3', pass: '', autoPush: false, autoPull: false });
    cloudFile = null; ghFile = null; ghDown = true; textdbDown = false;
    const r3 = await push(page);
    ok('D3a 备用通道上传成功', r3 === true, { r3 });
    ok('D3b textdb 备用源已写入数据', !!cloudFile);
    ok('D3c GitHub 主源未写入（不可达）', ghFile === null);
    ghDown = false;

    /* ===== D4：pull 双源对账（textdb 旧 + GitHub 新 → 取较新） ===== */
    console.log('\n[D4] pull 双源对账：取 rev 较新者');
    const cust6 = Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, code: 'C' + i, name: '客戶' + i, currency: 'CNY' }));
    const cust5 = cust6.slice(0, 5);
    await cfg(pageB, { provider: 'textdb', code: 'TD-D4', ghToken: '', ghRepo: 'TY/r', ghPath: 'erp-sync.json', pass: '', autoPush: false, autoPull: false });
    const snapOld = await makeSnap(pageB, 1000, cust6);   // textdb 旧：6 客户
    const snapNew = await makeSnap(pageB, 2000, cust5);   // GitHub 新：5 客户（手机 fallback push 写入）
    cloudFile = snapOld; ghFile = snapNew;
    const encA = await pageB.evaluate(() => CloudSync.pullRemote());
    const revA = encA ? await snapRev(pageB, encA) : null;
    ok('D4a textdb 旧 + GitHub 新 → 取 GitHub 较新（rev=2000）', revA === 2000, { revA });
    cloudFile = snapNew; ghFile = snapOld;
    const encB = await pageB.evaluate(() => CloudSync.pullRemote());
    const revB = encB ? await snapRev(pageB, encB) : null;
    const preB = String(encB).slice(0, 24), preCf = String(cloudFile).slice(0, 24), preGh = String(ghFile).slice(0, 24);
    ok('D4b textdb 新 + GitHub 旧 → 取 textdb 较新（rev=2000）', revB === 2000, { revB, preB, preCf, preGh });

    /* ===== D5：fetch 超时（textdb 挂起）→ 快速失败并切备用通道 ===== */
    console.log('\n[D5] textdb 挂起 → 超时后自动切 GitHub 备用通道（不卡死）');
    await cfg(page, { provider: 'textdb', code: 'TD-D5', ghToken: 'ghp_D5', ghRepo: 'TY/r', ghPath: 'erp-sync.json', pass: '', autoPush: false, autoPull: false });
    await page.evaluate(() => { CloudSync.FETCH_TIMEOUT = 800; });
    cloudFile = null; ghFile = null; textdbHang = true;
    const t0 = Date.now();
    const r5 = await push(page);
    const dur5 = Date.now() - t0;
    textdbHang = false;
    ok('D5a 超时后备用通道上传成功', r5 === true, { r5 });
    ok('D5b GitHub 备用源已写入', !!ghFile);
    ok('D5c 未卡死（耗时 < 5 秒）', dur5 < 5000, { dur5 });

    /* ===== D6：配置自愈（残缺配置 → 自动恢复统一数据空间） ===== */
    console.log('\n[D6] 配置自愈：残缺配置自动恢复默认数据空间');
    await page.evaluate(() => {
        localStorage.setItem('taiyuan_sync_cfg_v1', JSON.stringify({ provider: 'textdb', code: '', ghToken: '', ghRepo: 'TY/r', ghPath: 'erp-sync.json', pass: '', autoPush: true, autoPull: true }));
        localStorage.removeItem('taiyuan_sync_manual_v1');
        localStorage.removeItem('taiyuan_sync_gh_choice');
        CloudSync.cfg = null; CloudSync.status = null; CloudSync._started = false;
        CloudSync.startAuto();
    });
    const d6 = await page.evaluate(() => { const c = CloudSync.loadCfg(); return { code: c.code, def: CloudSync.DEFAULT_SYNC_CFG.code }; });
    ok('D6a 空同步码配置被自动修复为默认统一空间', !!d6.code && d6.code === d6.def, { d6 });

    /* ===== D7：manual 尊重（手动保存过 → 不覆盖） ===== */
    console.log('\n[D7] 用户手动保存过配置 → 自愈不覆盖');
    await page.evaluate(() => {
        localStorage.setItem('taiyuan_sync_manual_v1', '1');
        localStorage.setItem('taiyuan_sync_cfg_v1', JSON.stringify({ provider: 'textdb', code: '', ghToken: '', ghRepo: 'TY/r', ghPath: 'erp-sync.json', pass: '', autoPush: true, autoPull: true }));
        CloudSync.cfg = null; CloudSync.status = null; CloudSync._started = false;
        CloudSync.startAuto();
    });
    const d7 = await page.evaluate(() => CloudSync.loadCfg().code);
    ok('D7a 手动标志存在 → 残缺配置不被自动覆盖', d7 === '', { d7 });
    await page.evaluate(() => { CloudSync.saveCfg({ provider: 'textdb', code: 'my-custom-123', pass: '' }); CloudSync.cfg = null; CloudSync._started = false; CloudSync.startAuto(); });
    const d7b = await page.evaluate(() => CloudSync.loadCfg().code);
    ok('D7b 手动保存的自定义同步码不被默认覆盖', d7b === 'my-custom-123', { d7b });

    /* ===== D8：同步空间标识（云端同步页） ===== */
    console.log('\n[D8] 云端同步页显示同步空间标识');
    await page.evaluate(() => { CloudSync.saveCfg(Object.assign({}, CloudSync.DEFAULT_SYNC_CFG)); }); // 恢复默认配置
    await page.goto(BASE + '/#/tools/cloud-sync', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const html = await page.evaluate(() => document.body.innerHTML);
    ok('D8a 页面显示「同步空间」', html.indexOf('同步空间') >= 0);
    ok('D8b 显示 textdb 空间短标识（382d3aa9…73b5）', html.indexOf('textdb · 382d3aa9') >= 0, { has: html.indexOf('textdb · 382d3aa9') >= 0 });

    /* ===== D9：端到端复现用户场景（手机删除 → 电脑跨网域自动看到） ===== */
    console.log('\n[D9] 端到端：手机（textdb 不通）删除客户 → 电脑（textdb 通但旧）双源对账自动看到删除');
    // 手机：textdb 可达时 push「7 客户」到主源
    await cfg(page, { provider: 'textdb', code: 'TD-D9', ghToken: 'ghp_D9', ghRepo: 'TY/r', ghPath: 'erp-sync.json', pass: '', autoPush: false, autoPull: false });
    textdbDown = false; cloudFile = null; ghFile = null;
    await page.evaluate(() => { DB.insert('customers', { id: 'c_x1', code: 'X1', name: '跨網域測試客戶', currency: 'CNY' }); });
    await push(page);
    const s9a = await page.evaluate(async () => { const s = await CloudSync.peek(); return { rev: s.rev, n: s.payload.customers.length, hasX: s.payload.customers.some(c => c.id === 'c_x1') }; });
    ok('D9a 手机新增后云端（textdb）7 客户含测试客户', s9a.n === 7 && s9a.hasX === true, { s9a });
    // 电脑：先同步到 7 客户（复现「电脑已是最新」状态）
    const pullB = (p) => p.evaluate(() => CloudSync.pull(false));
    const r9b = await pullB(pageB);
    const n9b = await pageB.evaluate(() => DB.list('customers').length);
    ok('D9b 电脑 pull 后本地 7 客户', r9b === true && n9b === 7, { r9b, n9b });
    // 手机：textdb 突然不可达（4G 网络切换）→ 删除客户 → push 自动切 GitHub 备用通道
    textdbDown = true;
    await page.evaluate(() => { DB.remove('customers', 'c_x1'); });
    const r9c = await push(page);
    ok('D9c 手机删除后（textdb 不通）备用通道上传成功', r9c === true, { r9c });
    const ghState = await page.evaluate(async (enc) => { const s = await CloudSync.parseSnapshot(enc); return { rev: s.rev, n: s.payload.customers.length, hasX: s.payload.customers.some(c => c.id === 'c_x1') }; }, ghFile);
    const tdState = await page.evaluate(async (enc) => { const s = await CloudSync.parseSnapshot(enc); return { rev: s.rev, n: s.payload.customers.length }; }, cloudFile);
    ok('D9d GitHub 备用源已是 6 客户（删除生效）且 rev 较新', ghState.n === 6 && ghState.hasX === false && ghState.rev > tdState.rev, { ghState, tdState });
    // 电脑：textdb 可达但旧 → 双源对账自动取 GitHub 较新 → 自动看到删除
    const r9e = await pullB(pageB);
    const n9e = await pageB.evaluate(() => { const hasX = !!DB.get('customers', 'c_x1'); return { n: DB.list('customers').length, hasX }; });
    ok('D9e 电脑自动看到删除（跨网域闭环：textdb 旧、GitHub 新，双源对账取新）', r9e === true && n9e.n === 6 && n9e.hasX === false, { r9e, n9e });

    await browser.close();
    console.log('----------------------------------------');
    console.log('总计： ' + passed + ' 通过 / ' + failed + ' 失败');
    if (failed > 0) { console.log(results.filter(r => r.indexOf('FAIL') >= 0).join('\n')); process.exit(1); }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
