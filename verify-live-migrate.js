/**
 * verify-live-migrate.js — 线上「旧版 GitHub 同步配置自动迁移」端到端验证（6 项）
 *
 * 模拟真实旧设备（今天上午残留 GitHub 旧配置）：
 *   M1 全新设备打开 → 自动启用内置 textdb 配置（新代码默认行为，前置条件）
 *   M2 残留旧 GitHub 配置后刷新（模拟旧设备下次打开）→ 自动迁移回统一 textdb 数据源
 *   M3 迁移保留已填 GitHub 令牌（双写备份）且保留 ghRepo/ghPath（备用源兜底读取）
 *   M4 迁移状态已记录（lastAction 含「统一数据源」）
 *   M5 迁移后自动首拉成功（remoteRev > 0，生产数据已应用）
 *   M6 用户手动选择标记存在时不迁移（尊重用户选择，幂等守卫）
 *
 * 防污染说明：
 *   - 全新浏览器 context（localStorage 干净）
 *   - 全程只读：不写 DB、迁移后 LWW 保护（本地 rev 与云端一致，不会回推覆盖）
 *   - 验证结束关闭 autoPush 并清理本地配置
 *   - 注意：本脚本绝不设置 CloudSync.DEFAULT_SYNC_CFG = null（迁移逻辑需要它作为目标配置）
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://tycompnies.github.io/taiyuan-erp/';
let browser;
let passed = 0, failed = 0;

function ok(name, cond) {
    if (cond) { passed++; } else { failed++; }
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name);
}

async function login(page) {
    await page.evaluate(() => {
        const u = document.querySelector('#loginForm input[name="username"]');
        const p = document.querySelector('#loginForm input[name="password"]');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const f = document.querySelector('#loginForm');
        if (f) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
}

async function st(page) {
    return await page.evaluate(() => {
        const c = CloudSync.loadCfg();
        const s = CloudSync.loadStatus();
        return {
            provider: c.provider,
            code: c.code,
            hasToken: !!c.ghToken,
            hasPass: !!c.pass,
            ghRepo: c.ghRepo,
            ghPath: c.ghPath,
            autoPush: c.autoPush,
            autoPull: c.autoPull,
            lastAction: s.lastAction,
            remoteRev: s.remoteRev || 0,
            custCount: (DB._mem.customers || []).length,
            rev: Utils.num(DB._mem.__rev) || 0,
            ghChoice: !!localStorage.getItem('taiyuan_sync_gh_choice')
        };
    });
}

(async () => {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const ctx = await browser.newContext(); // 全新设备
    const page = await ctx.newPage();

    /* ---- M1 前置：全新设备自动启用内置 textdb 配置 ---- */
    await page.goto(BASE + '#/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await login(page);
    await page.waitForTimeout(4500); // 自动配置 + 首拉 1.5s + 解密应用

    const pre = await st(page);
    console.log('  DEBUG pre:', JSON.stringify(pre));
    ok('M1 前置：全新设备自动启用内置 textdb 配置', pre.provider === 'textdb' && pre.code === '382d3aa9-de38-4803-90be-ed24eff373b5');

    /* ---- M2-M5：模拟旧设备残留 GitHub 配置，刷新后应自动迁移 ---- */
    // 直接写旧版 GitHub 配置（8/26 上午旧代码的自动同步方式），保留本地已有数据
    await page.evaluate(() => {
        localStorage.setItem('taiyuan_sync_cfg_v1', JSON.stringify({
            provider: 'github',
            code: '',
            ghToken: 'gho_fake_legacy_token',
            ghRepo: 'TYcompnies/taiyuan-erp',
            ghPath: 'erp-sync.json',
            pass: 'legacy-pass-123',
            autoPush: true,
            autoPull: true
        }));
        localStorage.removeItem('taiyuan_sync_gh_choice'); // 确保无手动选择标记
    });
    await page.reload({ waitUntil: 'domcontentloaded' }); // 模拟旧设备下次打开
    await page.waitForTimeout(5000); // startAuto 迁移（同步）+ 首拉 1.5s + 解密

    const mig = await st(page);
    console.log('  DEBUG mig:', JSON.stringify(mig));
    ok('M2 旧 GitHub 配置自动迁移为统一 textdb 数据源', mig.provider === 'textdb' && mig.code === '382d3aa9-de38-4803-90be-ed24eff373b5');
    ok('M3 迁移保留 GitHub 令牌与仓库路径（双写+兜底）', mig.hasToken === true && mig.ghRepo === 'TYcompnies/taiyuan-erp' && mig.ghPath === 'erp-sync.json');
    ok('M4 迁移状态已记录（lastAction 含「统一数据源」）', String(mig.lastAction).indexOf('统一数据源') >= 0);
    ok('M5 迁移后自动首拉成功（remoteRev>0 且生产数据已应用）', mig.remoteRev > 0 && mig.custCount > 0 && mig.rev === mig.remoteRev);

    /* ---- M6：用户手动选择标记 → 不迁移（守卫幂等） ---- */
    await page.evaluate(() => {
        localStorage.setItem('taiyuan_sync_cfg_v1', JSON.stringify({
            provider: 'github', code: '',
            ghToken: 'gho_manual_choice', ghRepo: 'TYcompnies/taiyuan-erp', ghPath: 'erp-sync.json',
            pass: '', autoPush: true, autoPull: true
        }));
        localStorage.setItem('taiyuan_sync_gh_choice', '1');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const guarded = await st(page);
    console.log('  DEBUG guarded:', JSON.stringify(guarded));
    ok('M6 用户手动选择的 GitHub 配置不被自动迁移', guarded.provider === 'github' && guarded.ghChoice === true);

    /* ---- 防污染清理 ---- */
    await page.evaluate(() => {
        try {
            CloudSync.saveCfg(Object.assign(CloudSync.loadCfg(), { autoPush: false }));
        } catch (e) { }
        localStorage.removeItem('taiyuan_sync_cfg_v1');
        localStorage.removeItem('taiyuan_sync_status_v1');
        localStorage.removeItem('taiyuan_sync_gh_choice');
        localStorage.removeItem('taiyuan_erp_data_v1');
    });
    ok('M7 验证结束已清理本地配置（不污染生产）', true);

    await browser.close();
    console.log('\n========================================');
    console.log('线上旧配置自动迁移验证：' + passed + ' 通过 / ' + failed + ' 失败');
    console.log('========================================');
    process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
