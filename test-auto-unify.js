/**
 * test-auto-unify.js — 统一同步空间自动收敛验证（7 项）
 *
 * 场景：不同网域 / 不同 IP / 不同装置打开系统，无需手动输入同步码即自动接入统一同步空间。
 * （本地 localhost 需带 ?sync=1 强制启用自动配置逻辑；云端/任意网域天然生效）
 * 全程拦截云同步通道（textdb / GitHub），模拟云端无数据，不产生真实网络副作用。
 *
 * U1 全新设备（从未保存配置）→ 自动接入统一同步空间并启动自动同步
 * U2 旧设备曾手动保存过其他同步码（MANUAL_KEY）→ 一次性收敛到统一空间
 * U3 收敛完成后手动改回私有同步码 → 不再被自动干预（用户选择受尊重）
 * U4 手动 flag 缺失且同步码为空（配置损坏）→ 自愈到统一空间（安全网保留）
 * U5 已在统一空间（手动保存过同码）→ 配置不变，仅补收敛标记
 * U6 同步页「接入统一同步空间」按钮 → 任意时刻手动切回统一空间
 * U7 DEFAULT_SYNC_CFG 完整性：textdb + 同步码 + 口令 + 自动上传/下载全开
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8904';
let browser, page;
let passed = 0, failed = 0;

function ok(name, cond) {
    if (cond) passed++; else failed++;
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name);
}

async function open() {
    // 注意：goto 到「同 URL 仅哈希差异」是 same-document 导航不会重载，必须显式 reload 模拟新装置打开
    await page.goto(BASE + '/?sync=1#/', { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
}

async function login() {
    await page.evaluate(() => {
        const u = document.querySelector('#loginForm input[name="username"]');
        const p = document.querySelector('#loginForm input[name="password"]');
        if (u) u.value = 'admin';
        if (p) p.value = 'admin123';
        const f = document.querySelector('#loginForm');
        if (f) f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(900);
}

async function state() {
    return await page.evaluate(() => {
        const c = CloudSync.loadCfg();
        return {
            provider: c.provider,
            code: (c.code || '').trim(),
            pass: c.pass,
            autoPush: !!c.autoPush,
            autoPull: !!c.autoPull,
            flag: !!localStorage.getItem(CloudSync.UNIFY_KEY),
            started: !!CloudSync._started,
            defCode: (CloudSync.DEFAULT_SYNC_CFG.code || '').trim(),
            defPass: CloudSync.DEFAULT_SYNC_CFG.pass
        };
    });
}

(async () => {
    browser = await chromium.launch({ headless: true, channel: 'msedge', args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext();
    page = await ctx.newPage();
    // 断云：textdb / GitHub 全部拦截并模拟「云端无数据」，测试无真实网络副作用
    await ctx.route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r => {
        if (r.request().url().includes('github')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return r.request().method() === 'POST'
            ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' })
            : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' });
    });

    // == U7: DEFAULT_SYNC_CFG 完整性（前提校验） ==
    await open();
    const d = await page.evaluate(() => CloudSync.DEFAULT_SYNC_CFG || {});
    ok('U7 内置统一同步空间完整（textdb+同步码+口令+自动上传/下载）',
        d.provider === 'textdb' && !!(d.code && d.code.trim()) && !!(d.pass && d.pass.trim()) && d.autoPush === true && d.autoPull === true);

    // == U1: 全新设备自动接入 ==
    console.log('== U1: 全新设备零设定自动接入 ==');
    await open();
    await page.evaluate(() => {
        localStorage.clear();
        CloudSync.cfg = null; CloudSync.status = null;
    });
    await open();
    await login();
    let s = await state();
    ok('U1 全新设备自动接入统一同步空间（同步码一致）', s.code === s.defCode && s.provider === 'textdb');
    ok('U1b 自动上传/下载均已开启', s.autoPush && s.autoPull);
    ok('U1c 自动同步已启动（首拉+12秒轮询）', s.started);
    ok('U1d 收敛标记已写入（此后手动配置受尊重）', s.flag);

    // == U2: 旧设备手动保存过其他同步码 → 一次性收敛 ==
    console.log('== U2: 旧设备手动保存过其他同步码自动收敛 ==');
    await open();
    await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('taiyuan_sync_cfg_v1', JSON.stringify({ provider: 'textdb', code: 'old-private-code-888', pass: 'oldpass', autoPush: true, autoPull: true }));
        localStorage.setItem('taiyuan_sync_manual_v1', '1'); // 手动保存过（历史版本会因此永不自动修复）
        CloudSync.cfg = null; CloudSync.status = null;
    });
    await open();
    await login();
    s = await state();
    ok('U2 手动保存过其他同步码的旧设备仍自动收敛到统一空间', s.code === s.defCode && s.pass === s.defPass);
    ok('U2b 收敛标记已写入', s.flag);

    // == U3: 收敛后手动改回私有码 → 不再干预 ==
    console.log('== U3: 收敛后手动配置受尊重 ==');
    await open();
    await page.evaluate(() => {
        localStorage.setItem('taiyuan_sync_cfg_v1', JSON.stringify({ provider: 'textdb', code: 'my-private-space', pass: 'pp', autoPush: true, autoPull: true }));
        localStorage.setItem('taiyuan_sync_manual_v1', '1');
        CloudSync.cfg = null;
    });
    await open();
    await login();
    s = await state();
    ok('U3 收敛完成后手动保存的私有同步码不被覆盖', s.code === 'my-private-space');

    // == U4: 手动 flag 缺失 + 空码（配置损坏）→ 自愈（安全网保留） ==
    console.log('== U4: 空码配置自愈 ==');
    await open();
    await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('taiyuan_sync_cfg_v1', JSON.stringify({ provider: 'textdb', code: '', pass: '', autoPush: true, autoPull: true }));
        localStorage.setItem('taiyuan_sync_unified_v2', '1'); // 已收敛过（手动 flag 缺失）
        CloudSync.cfg = null;
    });
    await open();
    await login();
    s = await state();
    ok('U4 空同步码配置（无手动 flag）自愈到统一空间', s.code === s.defCode);

    // == U5: 已在统一空间（手动保存过同码）→ 不改动仅补标记 ==
    console.log('== U5: 已在统一空间仅补标记 ==');
    await open();
    await page.evaluate(() => {
        localStorage.clear();
        localStorage.setItem('taiyuan_sync_cfg_v1', JSON.stringify({ provider: 'textdb', code: CloudSync.DEFAULT_SYNC_CFG.code, pass: CloudSync.DEFAULT_SYNC_CFG.pass, autoPush: true, autoPull: true }));
        localStorage.setItem('taiyuan_sync_manual_v1', '1');
        localStorage.removeItem('taiyuan_sync_unified_v2');
        CloudSync.cfg = null;
    });
    await open();
    await login();
    s = await state();
    ok('U5 已在统一空间配置保持不变并补收敛标记', s.code === s.defCode && s.flag);

    // == U6: 同步页「接入统一同步空间」按钮 ==
    console.log('== U6: 手动切回统一空间按钮 ==');
    await open();
    await page.evaluate(() => {
        localStorage.setItem('taiyuan_sync_cfg_v1', JSON.stringify({ provider: 'textdb', code: 'divergent-again', pass: '', autoPush: true, autoPull: true }));
        localStorage.setItem('taiyuan_sync_manual_v1', '1');
        localStorage.setItem('taiyuan_sync_unified_v2', '1');
        CloudSync.cfg = null;
    });
    await open();
    await login();
    await page.evaluate(() => {
        try { document.querySelectorAll('.modal-mask').forEach(m => m.remove()); } catch (e) { }
        location.hash = '#/tools/cloud-sync';
    });
    await page.waitForTimeout(800);
    const btnFound = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        const b = btns.find(x => x.textContent.includes('接入统一同步空间'));
        if (b) { b.click(); return true; }
        return false;
    });
    await page.waitForTimeout(600);
    s = await state();
    ok('U6 「接入统一同步空间」按钮存在并切回统一空间', btnFound && s.code === s.defCode);

    await browser.close();
    console.log('\n测试完成：' + passed + ' 通过 / ' + failed + ' 失败');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
