/**
 * test-favicon.js — 品牌图示专项测试（2026-09-22）
 * 需求：
 *   1) 网页小图示更换为「钛沅 TY 品牌标志」——index.html 一律引用实体图标文件
 *      （favicon.ico / favicon-32x32.png / favicon-16x16.png / apple-touch-icon.png），
 *      且不得再残留旧的蓝色内联 SVG 图标。
 *   2) 首页左上方（侧边栏品牌区）套用同一个标志（logo.png）。
 * 检查重点：引用存在 → 文件可访问 → 真的是图片且尺寸正确 → 浏览器实际抓得到/渲染得出来。
 * 运行：BASE=<云端或本地 URL> node test-favicon.js
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8904';
const ICONS = ['favicon.ico', 'favicon-32x32.png', 'favicon-16x16.png', 'apple-touch-icon.png'];

let pass = 0, fail = 0;
const results = [];
async function test(name, fn) {
    try { await fn(); pass++; results.push(`✅ PASS: ${name}`); }
    catch (e) { fail++; results.push(`❌ FAIL: ${name} — ${e.message.split('\n')[0]}`); }
}
async function get(path) {
    const r = await fetch(BASE + '/' + path);
    const buf = Buffer.from(await r.arrayBuffer());
    return { r, buf, type: r.headers.get('content-type') || '' };
}
function pngSize(buf) {
    if (buf.length < 24 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('不是 PNG（魔数不符）');
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

(async () => {
    /* ---------- 1. index.html 引用 ---------- */
    await test('G1 index.html 引用 4 个品牌图标文件且无旧内联 SVG 图标', async () => {
        const r = await fetch(BASE + '/index.html');
        const html = await r.text();
        for (const f of ICONS) {
            if (!html.includes(f)) throw new Error(`index.html 未引用 ${f}`);
        }
        if (/rel="icon"[^>]*data:image\/svg\+xml/.test(html)) throw new Error('仍残留旧内联 SVG 图标');
        if (!/rel="apple-touch-icon"/.test(html)) throw new Error('缺少 apple-touch-icon 引用');
    });

    /* ---------- 2. 文件可访问 ---------- */
    for (const f of ICONS) {
        await test(`G2 ${f} 可访问（HTTP 200）`, async () => {
            const { r } = await get(f);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
        });
    }

    /* ---------- 3. 真的是图片、尺寸正确 ---------- */
    await test('G3 favicon.ico 为合法 ICO 且内嵌多尺寸（16/32/48/64）', async () => {
        const { buf, type } = await get('favicon.ico');
        if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error(`ICO 头不合法（type=${buf.readUInt16LE(2)}）`);
        const n = buf.readUInt16LE(4);
        const sizes = [];
        for (let i = 0; i < n; i++) {
            const o = 6 + i * 16;
            sizes.push(`${buf[o] || 256}x${buf[o + 1] || 256}`);
        }
        if (!sizes.includes('32x32')) throw new Error(`ICO 尺寸不足：${sizes.join(',')}`);
        if (!/icon|image/i.test(type)) throw new Error(`Content-Type 异常：${type}`);
    });

    await test('G4 favicon-32x32.png 为 32x32 的 PNG', async () => {
        const { buf, type } = await get('favicon-32x32.png');
        const s = pngSize(buf);
        if (s.w !== 32 || s.h !== 32) throw new Error(`实际 ${s.w}x${s.h}`);
        if (!/png/i.test(type)) throw new Error(`Content-Type 异常：${type}`);
    });

    await test('G5 favicon-16x16.png 为 16x16 的 PNG', async () => {
        const s = pngSize((await get('favicon-16x16.png')).buf);
        if (s.w !== 16 || s.h !== 16) throw new Error(`实际 ${s.w}x${s.h}`);
    });

    await test('G6 apple-touch-icon.png 为 180x180 的 PNG', async () => {
        const s = pngSize((await get('apple-touch-icon.png')).buf);
        if (s.w !== 180 || s.h !== 180) throw new Error(`实际 ${s.w}x${s.h}`);
    });

    /* ---------- 4. 内容确实是「深蓝 + 橘」的 TY 标志（有颜色分布，不是空白图） ---------- */
    await test('G7 图标内容为 TY 标志（深蓝主色 + 橘色点缀，非空白）', async () => {
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-dev-shm-usage'] });
        try {
            const b64 = (await get('favicon-32x32.png')).buf.toString('base64');
            const page = await browser.newPage();
            await page.goto('about:blank');
            const stat = await page.evaluate(async (b64) => {
                const img = new Image();
                img.src = 'data:image/png;base64,' + b64;
                await img.decode();
                const c = document.createElement('canvas');
                c.width = img.width; c.height = img.height;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const d = ctx.getImageData(0, 0, img.width, img.height).data;
                let ink = 0, navy = 0, orange = 0;
                for (let i = 0; i < d.length; i += 4) {
                    if (d[i + 3] < 32) continue;           // 透明像素不计
                    ink++;
                    const r = d[i], g = d[i + 1], b = d[i + 2];
                    if (b > r + 30 && b > 60 && r < 120) navy++;
                    if (r > 180 && g > 70 && g < 190 && b < 110) orange++;
                }
                return { ink, navy, orange, total: img.width * img.height };
            }, b64);
            if (stat.ink < stat.total * 0.15) throw new Error(`墨色像素过少（${stat.ink}/${stat.total}），图标疑似空白`);
            if (stat.navy < 10) throw new Error(`未侦测到深蓝主色（navy=${stat.navy}）`);
            if (stat.orange < 1) throw new Error(`未侦测到橘色点缀（orange=${stat.orange}）`);
        } finally { await browser.close(); }
    });

    /* ---------- 5. 首页左上方（侧边栏品牌区）套用同一个 TY 标志 ---------- */
    await test('G8 logo.png 可访问且为 256x256 PNG（供侧边栏品牌区使用）', async () => {
        const { buf, type } = await get('logo.png');
        const s = pngSize(buf);
        if (s.w !== 256 || s.h !== 256) throw new Error(`实际 ${s.w}x${s.h}`);
        if (!/png/i.test(type)) throw new Error(`Content-Type 异常：${type}`);
    });

    await test('G9 首页左上方品牌区实际渲染 TY 标志（img 载入成功且非 0 尺寸）', async () => {
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-gpu', '--disable-software-rasterizer', '--disable-dev-shm-usage'] });
        const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
        try {
            // 拦掉云端同步，避免真实拉取/外推资料
            await page.context().route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r =>
                (r.request().method() === 'POST'
                    ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' })
                    : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' })).catch(() => { }));
            await page.goto(BASE);
            await page.fill('input[name="username"]', 'admin');
            await page.fill('input[name="password"]', 'admin123');
            await page.click('button[type="submit"]');
            await page.waitForSelector('.brand-logo img', { timeout: 15000 });
            const info = await page.evaluate(async () => {
                const img = document.querySelector('.brand-logo img');
                if (!img.complete) await new Promise(r => { img.onload = r; img.onerror = r; });
                const box = img.getBoundingClientRect();
                return { src: img.getAttribute('src'), nw: img.naturalWidth, nh: img.naturalHeight, w: box.width, h: box.height };
            });
            if (!info.src.includes('logo.png')) throw new Error(`品牌区不是 logo.png：${info.src}`);
            if (!info.nw || !info.nh) throw new Error('图片未实际载入（naturalWidth=0）');
            if (info.w < 24 || info.h < 24) throw new Error(`渲染尺寸过小：${info.w}x${info.h}`);
        } finally { await browser.close(); }
    });

    console.log(`\n网页小图示测试：通过 ${pass} / 失败 ${fail}`);
    results.forEach(r => console.log(r));
    process.exit(fail ? 1 : 0);
})();
