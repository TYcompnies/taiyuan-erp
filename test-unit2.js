/* ============================================================
   test-unit2.js — 商品第二单位(最小单位)/第二换算 + 库存总览最小单位列
   需求（v=20260904d）：
   商品主档编辑「单位与换算」：
     - 销售→库存换算/采购→库存换算 改名「第一销售→库存换算/第一采购→库存换算」
     - 新增 第二销售单位(最小单位)、第二库存单位(最小单位)
     - 新增 第二销售→库存换算(最小单位)、第二采购→库存换算(最小单位)
     - 成本与售价 新增 安全库存(最小单位)、最高库存(最小单位)（独立输入）
   进销存库存总览：
     - 新增 第二目前库存(最小单位)（= 目前库存 × 第二换算 ÷ 第一换算；不重复计入库存价值）
     - 新增 第二安全库存(最小单位)、最高库存、第二最高库存(最小单位)
   验证：
   F1 表单标签改名 + 新标签齐全；独立 label 不再出现「销售→库存换算」
   F2 新 select/input 字段存在
   F3 第一/第二换算预览文字正确（1 箱 = 1 箱 / 1 箱 = 24 包（最小单位））
   F4 改 sales_to_stock2 24→48 实时刷新预览与总览最小换算提示
   F5 保存后新字段落库 + 旧字段零破坏
   F6 旧商品（无新字段）编辑页正常、总览最小列显示 —
   F7 总览列顺序与数字：第二目前库存=目前库存×(24÷1)
   F8 库存价值列不因第二列翻倍（50.00 而非 1200）
   F9 第二安全库存/第二最高库存为独立数字（50/13000，非主单位×24）
   F10 总览含「最高库存」列，共 18 列
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

    console.log("== 注入数据：MN0001（含最小单位字段，5 箱 = 120 包）+ OL0001（旧字段商品） ==");
    await db(() => {
        ["箱", "包", "个"].forEach(u => { if (!DB.find("units", x => x.name === u)) DB.insert("units", { name: u }); });
        DB.remove("items", "it_mn001");
        DB.remove("items", "it_old001");
        DB.insert("items", {
            id: "it_mn001", code: "MN0001", name: "最小单位测试品", spec: "每箱24包",
            brand: "测试", category_id: "", product_type: "成品",
            sales_unit: "箱", purchase_unit: "箱", stock_unit: "箱",
            sales_unit2: "包", stock_unit2: "包",
            sales_to_stock: 1, purchase_to_stock: 1,
            sales_to_stock2: 24, purchase_to_stock2: 24,
            cost: 10, price: 20, min_price: 18, purchase_currency: "CNY",
            safety_stock: 2, max_stock: 500, safety_stock2: 50, max_stock2: 13000,
            weight: 0, volume: 0, length_cm: 0, width_cm: 0, height_cm: 0,
            barcode: "", qrcode: "", remark: "", disabled: false
        });
        DB.insert("items", {
            id: "it_old001", code: "OL0001", name: "旧字段商品", spec: "",
            brand: "", category_id: "", product_type: "成品",
            sales_unit: "箱", purchase_unit: "箱", stock_unit: "个",
            sales_to_stock: 12, purchase_to_stock: 12,
            cost: 3, price: 5, min_price: 4, purchase_currency: "CNY",
            safety_stock: 5, max_stock: 100, weight: 0, volume: 0,
            length_cm: 0, width_cm: 0, height_cm: 0,
            barcode: "", qrcode: "", remark: "", disabled: false
        });
        const wh = DB.list("warehouses")[0];
        DB.addStock(wh.id, "it_mn001", 5);   // 5 箱
        DB.addStock(wh.id, "it_old001", 40); // 40 个
        return true;
    });

    console.log("== F1 商品编辑页标签（改名 + 新增） ==");
    await gotoHash("#/master/items/it_mn001/edit");
    const f1 = await page.evaluate(() => {
        const labels = [...document.querySelectorAll("form.form-panel label")].map(l => l.textContent.trim());
        return { labels };
    });
    const want = ["第一销售→库存换算", "第二销售→库存换算(最小单位)", "第一采购→库存换算", "第二采购→库存换算(最小单位)", "第二销售单位(最小单位)", "第二库存单位(最小单位)", "安全库存(最小单位)", "最高库存(最小单位)"];
    const have = want.every(w => f1.labels.indexOf(w) >= 0);
    check(have, `F1 新/改名标签齐全（缺: ${want.filter(w => f1.labels.indexOf(w) < 0).join(",") || "无"}）`);
    check(!f1.labels.includes("销售→库存换算"), `F1 独立 label「销售→库存换算」已改名（实际列表含: ${f1.labels.filter(l => l.includes("→库存换算")).join(" | ")}）`);
    check(!f1.labels.includes("采购→库存换算"), `F1 独立 label「采购→库存换算」已改名`);

    console.log("== F2 新字段存在 ==");
    const f2 = await page.evaluate(() => {
        const names = ["sales_unit2", "stock_unit2", "sales_to_stock2", "purchase_to_stock2", "safety_stock2", "max_stock2"].map(sel => !!document.querySelector(`[name="${sel}"]`));
        const s2 = document.querySelector('[name="sales_unit2"]');
        return { names, optHas: s2 ? [...s2.options].some(o => o.textContent.trim() === "包") : false };
    });
    check(f2.names.every(Boolean), `F2 六个新字段全部存在（实际: ${JSON.stringify(f2.names)}）`);
    check(f2.optHas, `F2 第二销售单位含「包」选项`);

    console.log("== F3 第一/第二换算预览 ==");
    const f3 = await page.evaluate(() => ({
        s1: document.getElementById("salesConvPreview").textContent.trim(),
        s2: document.getElementById("salesConv2Preview").textContent.trim(),
        p1: document.getElementById("purchaseConvPreview").textContent.trim(),
        p2: document.getElementById("purchaseConv2Preview").textContent.trim(),
        hint: document.getElementById("minFactorHint").textContent.trim()
    }));
    console.log("  ", JSON.stringify(f3));
    check(f3.s1 === "1 箱 = 1 箱", `F3 第一销售预览「1 箱 = 1 箱」（实际: ${f3.s1}）`);
    check(f3.s2 === "1 箱 = 24 包（最小单位）", `F3 第二销售预览「1 箱 = 24 包（最小单位）」（实际: ${f3.s2}）`);
    check(f3.p1 === "1 箱 = 1 箱", `F3 第一采购预览「1 箱 = 1 箱」（实际: ${f3.p1}）`);
    check(f3.p2 === "1 箱 = 24 包（最小单位）", `F3 第二采购预览「1 箱 = 24 包（最小单位）」（实际: ${f3.p2}）`);
    check(f3.hint.includes("24") && f3.hint.includes("包"), `F3 最小换算提示含 24/包（实际: ${f3.hint}）`);

    console.log("== F4 改 sales_to_stock2 24 → 48 实时刷新 ==");
    await page.evaluate(() => {
        const el = document.querySelector('[name="sales_to_stock2"]');
        el.value = "48";
        el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.waitForTimeout(200);
    const f4 = await page.evaluate(() => ({
        s2: document.getElementById("salesConv2Preview").textContent.trim(),
        hint: document.getElementById("minFactorHint").textContent.trim()
    }));
    console.log("  ", JSON.stringify(f4));
    check(f4.s2.includes("48") && !f4.s2.includes("24"), `F4 第二销售预览 48（实际: ${f4.s2}）`);
    check(f4.hint.includes("48"), `F4 最小换算提示同步 48（实际: ${f4.hint}）`);
    // 还原 24
    await page.evaluate(() => {
        const el = document.querySelector('[name="sales_to_stock2"]');
        el.value = "24";
        el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    console.log("== F5 保存后新字段落库 + 旧字段零破坏 ==");
    // 长表单按钮在视口外：先 scrollIntoView 居中，规避 actionability stable 死等
    await page.evaluate(() => {
        const b = document.querySelector("form.form-panel button[type=submit]");
        if (b) b.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(400);
    await page.locator("form.form-panel button[type=submit]").click();
    await page.waitForTimeout(900);
    const f5 = await db(() => {
        const it = DB.get("items", "it_mn001");
        return it ? { sales_unit: it.sales_unit, purchase_unit: it.purchase_unit, stock_unit: it.stock_unit, sales_to_stock: it.sales_to_stock, purchase_to_stock: it.purchase_to_stock, sales_unit2: it.sales_unit2, stock_unit2: it.stock_unit2, sales_to_stock2: it.sales_to_stock2, purchase_to_stock2: it.purchase_to_stock2, safety_stock: it.safety_stock, max_stock: it.max_stock, safety_stock2: it.safety_stock2, max_stock2: it.max_stock2, cost: it.cost, name: it.name } : null;
    });
    console.log("  保存后:", JSON.stringify(f5));
    check(f5 && f5.sales_unit2 === "包" && f5.stock_unit2 === "包", `F5 第二销售/库存单位已存（包）`);
    check(f5 && f5.sales_to_stock2 === 24 && f5.purchase_to_stock2 === 24, `F5 第二换算 24/24 已存`);
    check(f5 && f5.safety_stock2 === 50 && f5.max_stock2 === 13000, `F5 安全/最高(最小) 50/13000 已存`);
    check(f5 && f5.sales_unit === "箱" && f5.stock_unit === "箱" && f5.sales_to_stock === 1 && f5.purchase_to_stock === 1 && f5.safety_stock === 2 && f5.max_stock === 500 && f5.cost === 10 && f5.name === "最小单位测试品", `F5 旧字段零破坏`);

    console.log("== F6 旧商品（无新字段）编辑页正常 + 总览最小列 — ==");
    await gotoHash("#/master/items/it_old001/edit");
    const f6a = await page.evaluate(() => ({
        s1: document.getElementById("salesConvPreview").textContent.trim(),
        s2: document.getElementById("salesConv2Preview").textContent.trim(),
        hint: document.getElementById("minFactorHint").textContent.trim()
    }));
    console.log("  ", JSON.stringify(f6a));
    check(f6a.s1 === "1 箱 = 12 个", `F6 旧商品第一换算预览正常（实际: ${f6a.s1}）`);
    check(f6a.s2.includes("请先选择第二库存单位"), `F6 旧商品第二换算降级提示（实际: ${f6a.s2}）`);

    console.log("== F7/F8/F9/F10 库存总览 ==");
    await gotoHash("#/inventory/inventory_overview");
    const ov = await page.evaluate(() => {
        const ths = [...document.querySelectorAll("#app table thead th")].map(t => t.textContent.trim());
        const tr = [...document.querySelectorAll("#app table tbody tr")].find(r => r.textContent.includes("MN0001") && r.textContent.includes("主仓库"));
        const tro = [...document.querySelectorAll("#app table tbody tr")].find(r => r.textContent.includes("OL0001") && r.textContent.includes("主仓库"));
        const cells = tr ? [...tr.querySelectorAll("td")].map(td => td.textContent.replace(/\s+/g, " ").trim()) : [];
        const cellso = tro ? [...tro.querySelectorAll("td")].map(td => td.textContent.replace(/\s+/g, " ").trim()) : [];
        return { ths, cells, cellso, headerCount: ths.length };
    });
    console.log("  表头:", ov.ths.join(" | "));
    console.log("  MN0001 行:", JSON.stringify(ov.cells));
    check(ov.headerCount === 18, `F10 总览共 18 列（实际: ${ov.headerCount}）`);
    check(ov.ths[8] === "目前库存" && ov.ths[9] === "第二目前库存(最小单位)", `F7 目前库存后接第二目前库存(最小单位)`);
    check(ov.ths[10] === "安全库存" && ov.ths[11] === "第二安全库存(最小单位)", `F7 安全库存后接第二安全库存(最小单位)`);
    check(ov.ths[12] === "最高库存" && ov.ths[13] === "第二最高库存(最小单位)", `F10 安全库存后新增最高库存/第二最高库存(最小单位)`);
    check(ov.ths[15] === "库存价值(本位币)", `F8 库存价值列仍在（不重复计最小单位）`);
    check(ov.cells.length === 18, `F7 MN0001 行 18 格（实际: ${ov.cells.length}）`);
    check(/^120\s*包/.test(ov.cells[9]), `F7 第二目前库存=5箱×24=120 包（实际: ${ov.cells[9]}）`);
    check(/^5\s*箱/.test(ov.cells[8]), `F7 目前库存 5 箱（实际: ${ov.cells[8]}）`);
    check(/^50\s*包/.test(ov.cells[11]), `F9 第二安全库存独立 50 包（实际: ${ov.cells[11]}）`);
    check(/^500\s*箱/.test(ov.cells[12]), `F10 最高库存列 500 箱（实际: ${ov.cells[12]}）`);
    check(/^13000\s*包/.test(ov.cells[13]), `F9 第二最高库存独立 13000 包（实际: ${ov.cells[13]}）`);
    check(/^50/.test(ov.cells[15]), `F8 库存价值=5×10=50.00 未因最小列翻倍（实际: ${ov.cells[15]}）`);
    check(/^—$/.test(ov.cellso[9]), `F6 旧商品第二目前库存显示 —（实际: ${ov.cellso[9]}）`);
    check(/^—$/.test(ov.cellso[11]) && /^—$/.test(ov.cellso[13]), `F6 旧商品第二安全/最高(最小)显示 —`);
    check(/^120/.test(ov.cellso[15]), `F8 旧商品库存价值 40×3=120.00（实际: ${ov.cellso[15]}）`);

    console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
    await browser.close();
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
