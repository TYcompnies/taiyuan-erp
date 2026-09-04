/* ============================================================
   test-unit-conv.js — 商品主档「单位与换算」实时反向预览测试
   需求：商品主档编辑页「销售→库存换算」「采购→库存换算」
   数值调整后没有自动换算。修复：oninput 触发 Pages.updateUnitConv
   实时显示「1 销售 = X 库存」「1 采购 = Y 库存」。
   验证：
   U1 既有商品编辑页加载后，salesConvPreview 显示 "1 件 = 12 个"（按既有 rate）
   U2 修改 sales_to_stock 数字 12 → 6，预览同步刷新为 6
   U3 修改 purchase_to_stock 数字 24 → 8，预览同步刷新为 8
   U4 修改 stock_unit 切换为「套」，预览目标单位名同步刷新
   U5 修改 sales_unit 切换为「打」，预览起始单位名同步刷新
   U6 rate=0 降级为「请填写销售→库存换算」
   U7 单位空 降级为「请先选择采购/库存单位」
   U8 保存后既有商品数据（code/name/cost/price）零影响
   U9 .unit-conv-preview 元素带黄色背景（CSS 生效）
   U10 新建商品页（不传 id）也能正常显示预览
   ============================================================ */
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:8904";

let pass = 0, fail = 0;
const check = (cond, msg) => {
    if (cond) { pass++; console.log("  PASS " + msg); }
    else { fail++; console.log("  FAIL " + msg); }
};

(async () => {
    const browser = await chromium.launch({ channel: "msedge", headless: true });
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

    console.log("== 注入数据：商品 UTC001（件/箱/个 + 12/24 换算） ==");
    const itemId = "it_utc001";
    await db((a) => {
        // 确保单位存在
        ["件", "箱", "个", "打", "套"].forEach(u => {
            if (!DB.find("units", x => x.name === u)) DB.insert("units", { name: u });
        });
        // 删除旧测试品
        DB.remove("items", a);
        DB.insert("items", {
            id: a, code: "UTC0001", name: "换算预览测试品", spec: "测试规格",
            brand: "测试", category_id: "",
            product_type: "成品", sales_unit: "件", purchase_unit: "箱", stock_unit: "个",
            sales_to_stock: 12, purchase_to_stock: 24,
            cost: 5.5, price: 10, min_price: 8, purchase_currency: "CNY",
            safety_stock: 100, max_stock: 1000, weight: 0, volume: 0,
            length_cm: 0, width_cm: 0, height_cm: 0,
            barcode: "", qrcode: "", remark: "", disabled: false
        });
        return { id: a };
    }, itemId);

    console.log("== U1 既有商品编辑页加载预览 ==");
    await gotoHash("#/master/items/" + itemId + "/edit");
    const u1 = await page.evaluate(() => {
        const s = document.getElementById("salesConvPreview");
        const p = document.getElementById("purchaseConvPreview");
        return {
            sales: s ? s.textContent.trim() : null,
            pur: p ? p.textContent.trim() : null,
            salesStyle: s ? getComputedStyle(s).backgroundColor : null,
            salesRate: document.querySelector('[name="sales_to_stock"]').value,
            purRate: document.querySelector('[name="purchase_to_stock"]').value
        };
    });
    console.log("  salesConvPreview:", JSON.stringify(u1.sales), "purchaseConvPreview:", JSON.stringify(u1.pur));
    check(u1.sales && u1.sales.includes("1") && u1.sales.includes("件") && u1.sales.includes("12") && u1.sales.includes("个"), `U1 销售预览「1 件 = 12 个」（实际: ${u1.sales}）`);
    check(u1.pur && u1.pur.includes("1") && u1.pur.includes("箱") && u1.pur.includes("24") && u1.pur.includes("个"), `U1 采购预览「1 箱 = 24 个」（实际: ${u1.pur}）`);
    check(u1.salesStyle && u1.salesStyle !== "rgba(0, 0, 0, 0)" && u1.salesStyle !== "transparent", `U9 .unit-conv-preview 带背景色（实际: ${u1.salesStyle}）`);

    console.log("== U2 修改 sales_to_stock 12 → 6 ==");
    await page.evaluate(() => {
        const el = document.querySelector('[name="sales_to_stock"]');
        el.value = "6";
        el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    const u2 = await page.evaluate(() => document.getElementById("salesConvPreview").textContent.trim());
    console.log("  salesConvPreview:", JSON.stringify(u2));
    check(u2.includes("6") && !u2.includes("12"), `U2 sales_to_stock=6 时预览含 6 且不含旧 12（实际: ${u2}）`);

    console.log("== U3 修改 purchase_to_stock 24 → 8 ==");
    await page.evaluate(() => {
        const el = document.querySelector('[name="purchase_to_stock"]');
        el.value = "8";
        el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    const u3 = await page.evaluate(() => document.getElementById("purchaseConvPreview").textContent.trim());
    console.log("  purchaseConvPreview:", JSON.stringify(u3));
    check(u3.includes("8") && !u3.includes("24"), `U3 purchase_to_stock=8 时预览含 8 且不含旧 24（实际: ${u3}）`);

    console.log("== U4 修改 stock_unit 个 → 套 ==");
    await page.evaluate(() => {
        const el = document.querySelector('[name="stock_unit"]');
        // 找到「套」option 的值并 select
        const opt = [...el.options].find(o => o.value === "套" || o.textContent.trim() === "套");
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await page.waitForTimeout(200);
    const u4 = await page.evaluate(() => ({
        sales: document.getElementById("salesConvPreview").textContent.trim(),
        pur: document.getElementById("purchaseConvPreview").textContent.trim()
    }));
    console.log("  切换后 sales:", JSON.stringify(u4.sales), "pur:", JSON.stringify(u4.pur));
    check(u4.sales.includes("套") && !u4.sales.includes(" 个"), `U4 销售预览目标单位=套（实际: ${u4.sales}）`);
    check(u4.pur.includes("套") && !u4.pur.includes(" 个"), `U4 采购预览目标单位=套（实际: ${u4.pur}）`);

    console.log("== U5 修改 sales_unit 件 → 打 ==");
    await page.evaluate(() => {
        const el = document.querySelector('[name="sales_unit"]');
        const opt = [...el.options].find(o => o.value === "打" || o.textContent.trim() === "打");
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    await page.waitForTimeout(200);
    const u5 = await page.evaluate(() => document.getElementById("salesConvPreview").textContent.trim());
    console.log("  salesConvPreview:", JSON.stringify(u5));
    check(u5.includes("打"), `U5 销售预览起始单位=打（实际: ${u5}）`);

    console.log("== U6 rate=0 降级为「请填写」==");
    await page.evaluate(() => {
        const el = document.querySelector('[name="purchase_to_stock"]');
        el.value = "0";
        el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    const u6 = await page.evaluate(() => document.getElementById("purchaseConvPreview").textContent.trim());
    console.log("  purchaseConvPreview:", JSON.stringify(u6));
    check(u6.includes("请填写"), `U6 rate=0 降级为「请填写」（实际: ${u6}）`);

    console.log("== U7 单位空 降级为「请先选择」==");
    await page.evaluate(() => {
        const el = document.querySelector('[name="sales_unit"]');
        el.value = "";
        el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    const u7 = await page.evaluate(() => document.getElementById("salesConvPreview").textContent.trim());
    console.log("  salesConvPreview:", JSON.stringify(u7));
    check(u7.includes("请先选择") || u7.includes("选择"), `U7 单位空 降级为「请先选择」（实际: ${u7}）`);

    console.log("== U8 保存后既有商品数据零影响 ==");
    // 把数据还原到原状以便对比保存后无破坏
    await page.evaluate(() => {
        const el = document.querySelector('[name="sales_unit"]');
        const opt = [...el.options].find(o => o.value === "件" || o.textContent.trim() === "件");
        el.value = opt ? opt.value : "件";
        el.dispatchEvent(new Event("change", { bubbles: true }));
        const r1 = document.querySelector('[name="sales_to_stock"]');
        r1.value = "12";
        r1.dispatchEvent(new Event("input", { bubbles: true }));
        const r2 = document.querySelector('[name="purchase_to_stock"]');
        r2.value = "24";
        r2.dispatchEvent(new Event("input", { bubbles: true }));
        const su = document.querySelector('[name="stock_unit"]');
        const opt2 = [...su.options].find(o => o.value === "个" || o.textContent.trim() === "个");
        su.value = opt2 ? opt2.value : "个";
        su.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    // 点击保存
    await page.locator("form.form-panel button[type=submit]").click();
    await page.waitForTimeout(900);
    const u8 = await db((a) => {
        const it = DB.get("items", a);
        return it ? { code: it.code, name: it.name, cost: it.cost, price: it.price, sales_to_stock: it.sales_to_stock, purchase_to_stock: it.purchase_to_stock, sales_unit: it.sales_unit, purchase_unit: it.purchase_unit, stock_unit: it.stock_unit } : null;
    }, itemId);
    console.log("  保存后:", JSON.stringify(u8));
    check(u8 && u8.code === "UTC0001" && u8.name === "换算预览测试品" && u8.cost === 5.5 && u8.price === 10, `U8 既有商品核心字段（code/name/cost/price）零破坏`);
    check(u8 && u8.sales_to_stock === 12 && u8.purchase_to_stock === 24 && u8.sales_unit === "件" && u8.purchase_unit === "箱" && u8.stock_unit === "个", `U8 既有商品单位与换算零破坏`);

    console.log("== U10 新建商品页（不传 id）也能显示预览 ==");
    await gotoHash("#/master/items/create");
    const u10 = await page.evaluate(() => ({
        sales: document.getElementById("salesConvPreview") ? document.getElementById("salesConvPreview").textContent.trim() : null,
        pur: document.getElementById("purchaseConvPreview") ? document.getElementById("purchaseConvPreview").textContent.trim() : null
    }));
    console.log("  新建页 sales:", JSON.stringify(u10.sales), "pur:", JSON.stringify(u10.pur));
    check(u10.sales !== null && u10.pur !== null, `U10 新建商品页也有预览 span（实际: sales=${u10.sales}, pur=${u10.pur}）`);

    console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
    await browser.close();
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
