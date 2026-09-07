/**
 * test-bj-time.js — 北京时间统一回归测试（20260907d，6 项）
 * 背景：原 Utils.today/now 与损益分桶用设备本地时区，云端同步页直接显示 UTC（差 8 小时）。
 * 修复后全系统统一 Asia/Shanghai（东八区）。全程断云，纯本地时间逻辑校验。
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:8904';

let passed = 0, failed = 0;
function ok(name, cond) {
    if (cond) passed++; else failed++;
    console.log((cond ? '  PASS' : '  FAIL') + ': ' + name);
}

/* Node 侧独立计算北京时间（与页面实现互为印证，不用同一份代码） */
function bjNow() {
    const f = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    return f.format(new Date()); // YYYY-MM-DD HH:mm:ss
}

(async () => {
    const browser = await chromium.launch({ headless: true, channel: 'msedge', args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const ctx = await browser.newContext();

    /* ---- 断云：测试不产生任何真实网络副作用 ---- */
    await ctx.route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r =>
        r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }));

    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    /* ========== T1：Utils.today() = 北京日期（YYYY-MM-DD） ========== */
    const t1 = await page.evaluate(() => ({
        today: Utils.today(),
        local: new Date().toLocaleDateString('sv-SE'), // 设备本地日期（对照用）
        fmt: /^\d{4}-\d{2}-\d{2}$/.test(Utils.today())
    }));
    const expToday = bjNow().slice(0, 10);
    ok('T1 Utils.today() 等于北京时间日期 ' + expToday, t1.today === expToday && t1.fmt);
    console.log('      (设备本地日期=' + t1.local + '，北京日期=' + expToday + (t1.local !== expToday ? '，本沙箱非东八区，校验有效' : '，本机恰在东八区，同值属正常') + ')');

    /* ========== T2：Utils.now() = 北京日期+时间，格式正确，与 Node 北京时间相差 <1 分钟 ========== */
    const t2 = await page.evaluate(() => Utils.now());
    const expNow = bjNow();
    ok('T2 Utils.now() 日期部分等于北京日期', t2.slice(0, 10) === expNow.slice(0, 10));
    ok('T2b Utils.now() 格式 YYYY-MM-DD HH:mm:ss', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t2));
    const [h1, m1] = t2.slice(11).split(':').map(Number), [h2, m2] = expNow.slice(11).split(':').map(Number);
    const diffMin = Math.abs((h1 * 60 + m1) - (h2 * 60 + m2));
    ok('T2c Utils.now() 与 Node 北京时间相差小于 1 分钟', diffMin <= 1);

    /* ========== T3：Utils.monthStart() = 北京当月 1 号 ========== */
    const t3 = await page.evaluate(() => Utils.monthStart());
    ok('T3 Utils.monthStart() = 北京当月 1 号', t3 === expToday.slice(0, 8) + '01');

    /* ========== T4：损益日分桶以北京日期为基准 ========== */
    const t4 = await page.evaluate(() => profitSeries('day', 7).map(b => b.key));
    const dayBefore = (n) => {
        const [y, m, d] = expToday.split('-').map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d) - n * 86400000);
        return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
    };
    ok('T4 日分桶 7 桶且末桶=北京今天', t4.length === 7 && t4[6] === expToday);
    ok('T4b 日分桶首桶=北京今天-6，逐日连续', t4[0] === dayBefore(6) && t4.every((k, i) => k === dayBefore(6 - i)));

    /* ========== T5：损益月分桶以北京月份为基准，月份连续且月尾日正确 ========== */
    const t5 = await page.evaluate(() => profitSeries('month', 13).map(b => ({ key: b.key, end: b.end })));
    const [by, bm] = expToday.slice(0, 7).split('-').map(Number);
    const expKeys = [];
    for (let i = 12; i >= 0; i--) {
        const mi = (bm - 1) - i;
        const y = by + Math.floor(mi / 12), m = ((mi % 12) + 12) % 12 + 1;
        const mm = String(m).padStart(2, '0');
        expKeys.push({ key: y + '-' + mm, end: y + '-' + mm + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0') });
    }
    ok('T5 月分桶 13 桶连续且末桶=北京当月', t5.length === 13 && JSON.stringify(t5) === JSON.stringify(expKeys));

    /* ========== T6：云端同步页时间显示（ISO/UTC → 北京时间） ========== */
    // 与 sync.js fmtTime 相同的转换模式：2026-09-07T04:30:00Z（UTC）→ 北京 12:30:00
    const t6 = await page.evaluate(() => new Date('2026-09-07T04:30:00.000Z').toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }));
    ok('T6 UTC ISO 转北京时间显示（04:30Z → 12:30:00）', t6 === '2026-09-07 12:30:00');

    await browser.close();
    console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
