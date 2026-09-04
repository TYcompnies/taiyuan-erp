/* ============================================================
   test-safety-label.js — 安全库存报表「总仓库存」标签与口径测试
   需求：进销存安全库存页「目前库存」改为「总仓库存」，
   数值带入全部仓库实时合计；库存总览仍为分仓「目前库存」不变。
   验证：
   S1 安全库存页表头为「总仓库存」（不再出现「目前库存」）
   S2 安全库存页数值 = 各仓库合计（两仓 60+40=100）
   S3 单元格悬浮 title 含各仓明细（主仓/备用仓）
   S4 库存总览页表头为「库存」+「库存(最小单位)」，无安全/最高库存相关列
   ============================================================ */
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8904";

let pass = 0, fail = 0;
const check = (cond, msg) => {
    if (cond) { pass++; console.log("  PASS " + msg); }
    else { fail++; console.log("  FAIL " + msg); }
};

(async () => {
    const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.context().route(/textdb\.online|api\.github\.com|raw\.githubusercontent\.com/i, r => (r.request().url().includes('github') ? r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }) : (r.request().method() === 'POST' ? r.fulfill({ status: 200, contentType: 'text/plain', body: '{}' }) : r.fulfill({ status: 200, contentType: 'text/plain', body: 'key not found' }))).catch(() => { }));
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const inputs = page.locator("#loginForm input");
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
        const ph = await inputs.nth(i).getAttribute("placeholder") || "";
        if (/账号|用户/i.test(ph)) await inputs.nth(i).fill("admin");
        if (/密码/i.test(ph)) await inputs.nth(i).fill("admin123");
    }
    await page.locator("#loginForm button[type=submit]").click();
    await page.waitForTimeout(1000);

    async function gotoHash(hash) {
        await page.evaluate(() => document.querySelectorAll(".modal-mask").forEach(m => m.remove()));
        await page.evaluate(h => { location.hash = h; }, hash);
        await page.waitForTimeout(1100);
    }
    const db = (fn, arg) => page.evaluate(({ src, a }) => eval("(" + src + ")")(a), { src: fn.toString(), a: arg });

    console.log("== 注入数据：商品 A + 两仓库存 60 / 40（合计 100）==");
    await db(() => {
        ["it_sft", "wh_sft2"].forEach(id => {
            DB.remove("items", id); DB.remove("warehouses", id);
        });
        DB.insert("items", {
            id: "it_sft", code: "SFT0001", name: "安全库存标签测试品", spec: "", brand: "测试",
            category_id: DB.list("categories")[0] ? DB.list("categories")[0].id : "",
            product_type: "成品", sales_unit: "箱", purchase_unit: "箱", stock_unit: "箱",
            sales_to_stock: 1, purchase_to_stock: 1, cost: 10, price: 20, min_price: 15,
            purchase_currency: "CNY", safety_stock: 30, max_stock: 500, weight: 0, volume: 0,
            remark: "", disabled: false
        });
        const wh1 = DB.list("warehouses")[0];
        const sm = DB.stockMap();
        if (!sm[wh1.id]) sm[wh1.id] = {};
        sm[wh1.id]["it_sft"] = 60;
        // 备用仓：复制主仓字段，仅改 id/name/code
        const w2 = Object.assign({}, wh1, { id: "wh_sft2", code: "WH999", name: "备用仓" });
        DB.insert("warehouses", w2);
        if (!sm["wh_sft2"]) sm["wh_sft2"] = {};
        sm["wh_sft2"]["it_sft"] = 40;
        return { total: DB.totalStock("it_sft") };
    }).then(r => console.log("  合计:", JSON.stringify(r)));

    console.log("== S1/S2/S3 安全库存页 ==");
    await gotoHash("#/inventory/inventory_safety");
    const sf = await page.evaluate(() => {
        const ths = [...document.querySelectorAll("#app .table thead th")].map(t => t.textContent.trim());
        const tr = [...document.querySelectorAll("#app .table tbody tr")].find(r => r.textContent.includes("SFT0001"));
        const cells = tr ? [...tr.querySelectorAll("td")] : [];
        const totalCell = cells[4] || null;
        return {
            ths: ths.join("|"),
            qty: totalCell ? totalCell.textContent.replace(/\s+/g, " ").trim() : null,
            title: totalCell ? (totalCell.getAttribute("title") || "") : null,
            body: document.body.textContent.replace(/\s+/g, " ")
        };
    });
    console.log("  表头:", sf.ths);
    console.log("  总仓库存单元格:", JSON.stringify(sf.qty), " title:", sf.title);
    check(sf.ths.includes("总仓库存"), `表头含「总仓库存」（实际: ${sf.ths}）`);
    check(!sf.ths.includes("目前库存"), `安全库存页表头不再出现「目前库存」`);
    check(sf.qty && /^100/.test(sf.qty), `总仓库存数值=两仓合计 100（实际: ${sf.qty}）`);
    check(sf.title && sf.title.includes("主仓库") && sf.title.includes("备用仓") && sf.title.includes("60") && sf.title.includes("40"), `悬浮 title 含各仓明细 60/40（实际: ${sf.title}）`);

    console.log("== S4 库存总览页（分仓口径，v20260904d 改名+精简列）==");
    await gotoHash("#/inventory/inventory_overview");
    const ovThs = await page.evaluate(() =>
        [...document.querySelectorAll("#app .table thead th")].map(t => t.textContent.trim()).join("|"));
    console.log("  总览表头:", ovThs);
    check(ovThs.includes("库存"), `库存总览表头含「库存」（分仓显示，实际: ${ovThs}）`);
    check(!ovThs.includes("目前库存"), `库存总览表头不再出现「目前库存」`);
    check(ovThs.includes("库存(最小单位)"), `库存总览表头含「库存(最小单位)」`);

    console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
    await browser.close();
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
