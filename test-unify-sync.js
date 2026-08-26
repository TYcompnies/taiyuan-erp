/**
 * test-unify-sync.js — 跨网络 IP 同步稳定性验证（旧配置统一 / LWW 保护 / 双源兜底 / 双写备份）
 *
 * U1  旧版 GitHub 配置设备打开 → 自动迁移为 textdb（统一数据源，防分裂）
 * U2  迁移保留已填的 GitHub 令牌（用于双写备份）
 * U3  迁移后自动启动 textdb 同步（首拉）
 * U4  迁移后 push 到 textdb，第二台全新设备自动拉取（跨设备闭环）
 * U5  LWW 保护：本地旧 rev push → 不覆盖云端新数据，自动改拉取云端
 * U6  textdb 不可达 → 自动从 GitHub 备用源读取（兜底）
 * U7  双写备份：push textdb 成功后同时写入 GitHub（配置有 ghToken 时）
 * U8  用户手动保存 GitHub 配置（有选择标记）→ 不被自动迁移干预
 *
 * 说明：所有外部 API 用 page.route 拦截（内存模拟），不污染真实同步数据。
 */
const { chromium } = require('playwright');

// ?sync=1 强制本地启用自动配置（localhost 默认豁免）
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

// ---- 内存云端模拟（跨 context 共享） ----
let cloudFile = null;     // textdb 云端加密数据
let ghFile = null;        // GitHub 仓库同步文件内容（raw 读取 / API 双写）
let githubPuts = 0;       // GitHub API 写入次数
let textdbDown = false;   // 模拟 textdb 不可达
let ghSha = 'abc123';

function mockAll(page) {
    return page.route('**', async (route) => {
        const url = route.request().url();
        // textdb 写入
        if (url.indexOf('api.textdb.online/update/') >= 0) {
            if (textdbDown) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
            const m = url.match(/[?&]value=([^&]*)/);
            cloudFile = m ? decodeURIComponent(m[1]) : '';
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 1 }) });
        }
        // textdb 读取
        if (url.indexOf('textdb.online/') >= 0 && url.indexOf('api.textdb') < 0) {
            if (textdbDown) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'down' });
            if (!cloudFile) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'null' });
            return route.fulfill({ status: 200, contentType: 'text/plain', body: cloudFile });
        }
        // GitHub API（双写/读取）
        if (url.indexOf('api.github.com/repos/') >= 0) {
            const method = route.request().method();
            if (method === 'GET') {
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: ghSha, content: ghFile ? Buffer.from(ghFile).toString('base64') : '' }) });
            }
            if (method === 'PUT') {
                try {
                    const body = JSON.parse(route.request().postData() || '{}');
                    ghFile = Buffer.from(body.content || '', 'base64').toString('utf8');
                    githubPuts++;
                    ghSha = 'sha' + githubPuts;
                } catch (e) { }
                return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: { sha: ghSha } }) });
            }
        }
        // GitHub raw 读取（兜底）
        if (url.indexOf('raw.githubusercontent.com/') >= 0) {
            if (!ghFile) return route.fulfill({ status: 404, contentType: 'text/plain', body: '404' });
            return route.fulfill({ status: 200, contentType: 'text/plain', body: ghFile });
        }
        if (url.indexOf('cdn.jsdelivr.net/gh/') >= 0) {
            if (!ghFile) return route.fulfill({ status: 404, contentType: 'text/plain', body: '404' });
            return route.fulfill({ status: 200, contentType: 'text/plain', body: ghFile });
        }
        return route.fallback();
    });
}

// 直接写一段加密快照到云端（含指定 rev 与客户），供测试场景预设
async function seedCloud(page, rev, custId, custName) {
    return page.evaluate(async ({ rev, custId, custName }) => {
        const payload = JSON.parse(JSON.stringify(DB._mem));
        payload.__rev = rev;
        payload.__device = 'Dtest';
        payload.customers = payload.customers || [];
        payload.customers.push({ id: custId, name: custName, phone: '10086', currency: 'CNY', created_at: new Date().toISOString() });
        const snap = { v: 1, rev, device: 'Dtest', updated_at: new Date().toISOString(), payload };
        const marked = await CloudSync._compress(JSON.stringify(snap));
        return await CloudSync._encrypt(marked);
    }, { rev, custId, custName });
}

async function cfgState(page) {
    return await page.evaluate(() => {
        const c = CloudSync.loadCfg();
        return {
            configured: CloudSync.isConfigured(),
            provider: c.provider,
            code: c.code,
            hasPass: !!c.pass,
            hasToken: !!c.ghToken,
            autoPush: c.autoPush,
            autoPull: c.autoPull,
            lastAction: CloudSync.loadStatus().lastAction
        };
    });
}

(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true });

    /* ===== U1/U2/U3：旧版 GitHub 配置设备自动迁移 ===== */
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await mockAll(pageA);
    await login(pageA);
    // 模拟旧设备：手动写入旧版 GitHub 配置（8/26 上午的自动同步方式）
    await pageA.evaluate(() => {
        CloudSync.saveCfg({
            provider: 'github',
            ghToken: 'gho_testlegacy123',
            ghRepo: 'TYcompnies/taiyuan-erp',
            ghPath: 'erp-sync.json',
            pass: 'legacy-pass',
            autoPush: true,
            autoPull: true
        });
        CloudSync._started = false;
        localStorage.removeItem('taiyuan_sync_gh_choice');
    });
    // 重新触发 startAuto（刷新页面模拟重新打开）
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    await pageA.waitForTimeout(2500);

    const s1 = await cfgState(pageA);
    ok('U1 旧版 GitHub 配置自动迁移为 textdb（统一数据源）', s1.provider === 'textdb' && !!s1.code && s1.code.length > 10);
    ok('U2 迁移保留已填 GitHub 令牌（用于双写备份）', s1.hasToken === true);
    ok('U3 迁移后自动开启同步（autoPush/autoPull）', s1.autoPush === true && s1.autoPull === true);
    console.log('  DEBUG lastAction:', JSON.stringify(s1.lastAction));
    ok('U3b 迁移状态已记录', String(s1.lastAction).indexOf('统一数据源') >= 0 || String(s1.lastAction).indexOf('切换') >= 0);

    /* ===== U4：迁移后 push 到 textdb，第二台全新设备自动拉取 ===== */
    await pageA.evaluate(() => {
        DB.insert('customers', { id: 'c_unify1', name: '統一數據源測試客戶', phone: '13700000001', currency: 'CNY', created_at: new Date().toISOString() });
    });
    await pageA.waitForTimeout(4500);
    ok('U4a 迁移后数据变动自动上传 textdb', !!cloudFile && cloudFile.indexOf('TYE1:') === 0);

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await mockAll(pageB);
    await login(pageB);
    await pageB.waitForTimeout(3000); // 首拉 1.5s + 解密
    const hasUnify = await pageB.evaluate(() => !!DB.get('customers', 'c_unify1'));
    ok('U4b 第二台全新设备自动拉取到统一数据源的数据（跨设备闭环）', hasUnify === true);

    /* ===== U5：LWW 保护——本地旧 rev 不覆盖云端新数据 ===== */
    // 设备 B 已有云端数据（rev=R1），模拟其本地 rev 落后（如断网期间）后触发推送
    const revInfo = await pageB.evaluate(() => {
        return { localRev: Utils.num(DB._mem.__rev) || 0 };
    });
    // 构造：云端已有更新数据（rev 比 B 大 1000，含客户 c_lww_new）
    const seeded = await seedCloud(pageB, revInfo.localRev + 1000, 'c_lww_new', '云端新客戶LWW');
    cloudFile = seeded;
    // B 本地也加一条旧客户（模拟 B 在离线状态录入了数据，rev 落后）
    await pageB.evaluate((r) => {
        DB._mem.__rev = r; // 确保本地 rev 落后
        DB.insert('customers', { id: 'c_lww_old', name: '本機舊客戶LWW', phone: '13700000002', currency: 'CNY', created_at: new Date().toISOString() });
    }, revInfo.localRev);
    await pageB.waitForTimeout(100); // flush 触发前
    // 直接触发推送（模拟 B 保存数据后 3 秒防抖到期）
    await pageB.evaluate(() => CloudSync.push(false));
    await pageB.waitForTimeout(1500);
    // 云端不应被 B 的旧数据覆盖：解密云端应包含 c_lww_new（云端新客户）且 B 已自动拉取
    const cloudState = await pageB.evaluate(() => CloudSync.peek().then(s => {
        return { hasNew: !!(s.payload.customers || []).find(c => c.id === 'c_lww_new'), hasOld: !!(s.payload.customers || []).find(c => c.id === 'c_lww_old') };
    }).catch(e => ({ err: e.message })));
    ok('U5a 云端新数据未被本地旧数据覆盖', cloudState.hasNew === true && cloudState.hasOld !== true);
    const bState = await pageB.evaluate(() => {
        return { hasNewLocal: !!DB.get('customers', 'c_lww_new'), hasOldLocal: !!DB.get('customers', 'c_lww_old') };
    });
    ok('U5b 本地自动拉取云端较新数据（未上传的旧改动已备份）', bState.hasNewLocal === true);

    /* ===== U6：textdb 不可达 → 自动从 GitHub 备用源读取 ===== */
    const bCurRev = await pageB.evaluate(() => Utils.num(DB._mem.__rev) || 0);
    ghFile = await seedCloud(pageB, bCurRev + 1000, 'c_gh_backup', 'GitHub備用源客戶');
    textdbDown = true;
    const pullRes = await pageB.evaluate(() => CloudSync.pull(false));
    await pageB.waitForTimeout(1000);
    const ghState = await pageB.evaluate(() => {
        const c = CloudSync.loadStatus();
        return { lastAction: c.lastAction, hasBackup: !!DB.get('customers', 'c_gh_backup') };
    });
    ok('U6 主源 textdb 不可达时自动从 GitHub 备用源读取', pullRes === true && ghState.hasBackup === true);
    ok('U6b 状态提示备用源读取', String(ghState.lastAction).indexOf('备用源') >= 0);
    textdbDown = false;

    /* ===== U7：双写备份——push textdb 成功后同步写 GitHub ===== */
    // 用全新 context（textdb 配置 + ghToken 双写令牌），干净验证双写逻辑
    const ctxD = await browser.newContext();
    const pageD = await ctxD.newPage();
    await mockAll(pageD);
    await login(pageD);
    await pageD.waitForTimeout(2500); // 自动配置 + 首拉（拉取云端现有数据，rev 对齐）
    await pageD.evaluate(() => {
        CloudSync.saveCfg({ ghToken: 'gho_doublewrite' }); // 模拟本机持久化配置档含双写令牌
        CloudSync._started = false;
        CloudSync.startAuto();
    });
    await pageD.waitForTimeout(1200);
    const putsBefore = githubPuts;
    const dbgPre = await pageD.evaluate(() => {
        const c = CloudSync.loadCfg();
        return { hasToken: !!c.ghToken, provider: c.provider, localRev: Utils.num(DB._mem.__rev) || 0 };
    });
    await pageD.evaluate(() => {
        DB.insert('customers', { id: 'c_doublewrite', name: '雙寫測試客戶', phone: '13700000003', currency: 'CNY', created_at: new Date().toISOString() });
    });
    await pageD.waitForTimeout(4500); // 3 秒防抖自动上传
    const dbgPost = await pageD.evaluate(() => {
        const st = CloudSync.loadStatus();
        return { lastError: st.lastError, lastAction: st.lastAction };
    });
    console.log('  DEBUG U7:', JSON.stringify({ dbgPre, dbgPost, githubPuts, putsBefore }));
    ok('U7 textdb push 后 GitHub 备用源同步更新（双写）', githubPuts > putsBefore && !!ghFile && ghFile.indexOf('TYE1:') === 0);

    /* ===== U8：用户手动保存 GitHub 配置 → 不被自动迁移干预 ===== */
    const ctxC = await browser.newContext();
    const pageC = await ctxC.newPage();
    await mockAll(pageC);
    await login(pageC);
    await pageC.evaluate(() => {
        CloudSync.saveCfg({ provider: 'github', ghToken: 'gho_manual123', ghRepo: 'TYcompnies/taiyuan-erp', ghPath: 'erp-sync.json', pass: 'x', autoPush: true, autoPull: true });
        // syncSaveCfg 会设标记；这里模拟直接保存后的 reload
        localStorage.setItem('taiyuan_sync_gh_choice', '1');
        CloudSync._started = false;
    });
    await pageC.reload({ waitUntil: 'domcontentloaded' });
    await pageC.waitForTimeout(2000);
    const s8 = await pageC.evaluate(() => {
        const c = CloudSync.loadCfg();
        return { provider: c.provider, hasToken: !!c.ghToken };
    });
    ok('U8 用户手动选择的 GitHub 配置不被自动迁移', s8.provider === 'github' && s8.hasToken === true);

    /* 清理 */
    await pageA.evaluate(() => {
        const ids = ['c_unify1', 'c_lww_new', 'c_lww_old', 'c_gh_backup', 'c_doublewrite'];
        ids.forEach(id => { const d = DB.get('customers', id); if (d) DB.remove('customers', id); });
        localStorage.removeItem('taiyuan_sync_cfg_v1');
        localStorage.removeItem('taiyuan_sync_status_v1');
        localStorage.removeItem('taiyuan_sync_gh_choice');
        CloudSync.cfg = null; CloudSync.status = null; CloudSync._started = false; CloudSync._legacyChecked = false;
    });

    await browser.close();
    console.log('----------------------------------------');
    console.log('总计： ' + passed + ' 通过 / ' + failed + ' 失败');
    if (failed > 0) { console.log(results.filter(r => r.indexOf('FAIL') >= 0).join('\n')); process.exit(1); }
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
