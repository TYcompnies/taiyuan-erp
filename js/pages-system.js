/* ============================================================
   义乌市钛沅商贸有限公司 ERP 系统 - 报表与系统设置页面
   库存总览 / 安全库存 / 导入中心 / 备份 / 用户 / 角色 / 权限
   ============================================================ */
"use strict";

/* ============================================================
   库存总览
   ============================================================ */
Pages.inventoryOverview = function () {
    const whFilter = window.__invWh || "";
    const q = (window.__invSearch || "").toLowerCase();
    const warehouses = DB.list("warehouses");
    const items = DB.list("items").sort((a, b) => a.code.localeCompare(b.code));

    let rows = "";
    warehouses.forEach(wh => {
        if (whFilter && wh.id !== whFilter) return;
        const stock = DB.stockMap()[wh.id] || {};
        // 显示全部启用商品（含 0 库存），数量以库存单位为准，避免商品「消失」造成判读困惑
        const whItems = items.filter(i => !i.disabled).sort((a, b) => a.code.localeCompare(b.code));
        whItems.forEach(it => {
            const qty = Utils.num(stock[it.id]);
            const cost = Utils.num(it.cost);
            const cur = DB.currencyByCode(it.purchase_currency);
            const rate = cur ? Utils.num(cur.rate) : 1;
            const costBase = Utils.round(cost * rate);
            const value = Utils.round(qty * costBase);
            // 最小单位口径：第二换算 ÷ 第一换算（销售组优先，缺则采购组）；仅显示不重复计价值
            const s1 = Utils.num(it.sales_to_stock), s2 = Utils.num(it.sales_to_stock2);
            const p1 = Utils.num(it.purchase_to_stock), p2 = Utils.num(it.purchase_to_stock2);
            let minFactor = 0;
            if (s1 > 0 && s2 > 0) minFactor = s2 / s1;
            else if (p1 > 0 && p2 > 0) minFactor = p2 / p1;
            const u2 = it.stock_unit2 || it.sales_unit2 || "";
            const u1 = it.stock_unit || "";
            const minQtyCell = (minFactor > 0 && u2) ? `<td class="num">${Utils.round(qty * minFactor)} <small style="color:var(--muted)">${h(u2)}</small></td>` : `<td class="num"><span style="color:var(--muted)">—</span></td>`;
            const minCell = (v) => (v == null || v === "") ? `<td class="num"><span style="color:var(--muted)">—</span></td>` : `<td class="num">${Utils.num(v)} <small style="color:var(--muted)">${h(u2)}</small></td>`;
            const last = DB.list("inventory_adjusts").filter(a => a.warehouse_id === wh.id && a.lines.some(l => l.item_id === it.id)).sort((a, b) => b.no.localeCompare(a.no))[0];
            const txt = (it.code + it.name + it.spec).toLowerCase();
            if (q && txt.indexOf(q) < 0) return;
            const cls = qty < 0 ? "neg" : qty < it.safety_stock ? "low" : "";
            rows += `<tr>
                <td><b>${h(it.code)}</b></td>
                <td>${h(it.name)}</td>
                <td>${h(it.spec || "-")}</td>
                <td>${h(wh.name)}</td>
                <td>${h(it.purchase_currency || "-")}</td>
                <td class="num">${fmt(it.cost)}</td>
                <td class="num">${fmt(costBase)}</td>
                <td>${h(it.stock_unit || "-")}</td>
                <td><div class="stock-bar-wrap">
                    <span class="num" style="width:76px;${qty < 0 ? "color:var(--danger);font-weight:700" : ""}">${qty} <small style="color:var(--muted)">${h(u1)}</small></span>
                    <span class="stock-bar ${cls}"><i style="width:${it.safety_stock > 0 ? Math.min(Math.max(qty, 0) / it.safety_stock * 100, 100) : 100}%"></i></span>
                </div></td>
                ${minQtyCell}
                <td>${qty < 0 ? badge("负库存") : qty < it.safety_stock ? badge("低库存") : badge("正常")}</td>
                <td class="num">${fmt(value)}</td>
                <td class="num">${rate}</td>
                <td>${last ? h(last.no) : "-"}</td>
            </tr>`;
        });
    });

    const whOpts = `<option value="">全部仓库</option>` + warehouses.map(w => `<option value="${w.id}" ${whFilter === w.id ? "selected" : ""}>${h(w.name)}</option>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>进销存库存总览</h1><p>查询各仓库商品库存数量、成本与库存价值（本位币 ${COMPANY.baseCurrency}）。「库存(最小单位)」按最小库存单位显示，不重复计入库存价值。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/inventory/inventory_safety">进销存安全库存</a></div>
    </div>
    <div class="toolbar">
        <div class="search"><input placeholder="搜索品号/品名..." value="${h(window.__invSearch || "")}" oninput="Pages.invSearch(this.value)"></div>
        <div class="filters"><select onchange="Pages.invWh(this.value)">${whOpts}</select></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>品号</th><th>品名</th><th>规格</th><th>仓库</th><th>币别</th><th class="num">采购成本</th><th class="num">成本(本位币)</th><th>库存单位</th><th>库存</th><th class="num">库存(最小单位)</th><th>状态</th><th class="num">库存价值(本位币)</th><th class="num">汇率</th><th>最后异动</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="14"><div class="empty-state"><div class="big">📦</div>没有符合的库存资料</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("inventory_overview", content, "首页 / 报表查询 / 进销存库存总览");
};

Pages.invSearch = function (v) { window.__invSearch = v; Pages.inventoryOverview(); };
Pages.invWh = function (v) { window.__invWh = v; Pages.inventoryOverview(); };

/* ============================================================
   安全库存报表
   ============================================================ */
Pages.inventorySafety = function () {
    const items = DB.list("items").filter(i => !i.disabled).sort((a, b) => a.code.localeCompare(b.code));
    const sm = DB.stockMap();
    const whs = DB.list("warehouses");
    const rows = items.map(it => {
        const total = DB.totalStock(it.id);
        const short = it.safety_stock - total;
        const cls = total < 0 ? "red" : short > 0 ? "orange" : "green";
        // 不足数量：负库存显示「缺货」；不足显示 +N；充足显示 0（避免负数误解）
        const shortTxt = total < 0 ? "缺货" : short > 0 ? "+" + short : "0";
        const unit = it.stock_unit || it.sales_unit || "";
        // 总仓库存＝全部仓库实时合计；title 悬浮显示各仓明细（主仓/各分仓自动带入）
        const breakdown = whs.map(w => `${w.name} ${Utils.num(sm[w.id] && sm[w.id][it.id])}${unit || ""}`).join("，");
        return `<tr>
            <td><b>${h(it.code)}</b></td>
            <td>${h(it.name)}</td>
            <td>${h(it.brand || "-")}</td>
            <td>${h(unit)}</td>
            <td class="num" title="各仓库存：${h(breakdown)}">${total} <small style="color:var(--muted)">${h(unit)}</small></td>
            <td class="num">${it.safety_stock} <small style="color:var(--muted)">${h(unit)}</small></td>
            <td class="num">${it.max_stock || "-"}</td>
            <td class="num" style="color:${cls === "green" ? "var(--green)" : cls === "orange" ? "var(--orange)" : "var(--danger)"};font-weight:700">${shortTxt}</td>
            <td>${cls === "green" ? badge("库存充足") : cls === "orange" ? badge("低于安全库存") : badge("负库存")}</td>
            <td class="action-col"><a class="link-btn" href="#/master/items/${it.id}/edit">调整安全库存</a></td>
        </tr>`;
    }).join("");
    const lowCount = items.filter(i => DB.totalStock(i.id) < i.safety_stock && DB.totalStock(i.id) >= 0).length;
    const negCount = items.filter(i => DB.totalStock(i.id) < 0).length;

    const content = `
    <div class="page-head">
        <div><h1>进销存安全库存</h1><p>总仓库存＝全部仓库实时合计（主仓及各分仓自动带入）；低于安全库存的商品需要评估是否采购，负库存需修正。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/inventory/inventory_overview">进销存库存总览</a></div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>库存充足</span><strong style="color:var(--green)">${items.length - lowCount - negCount}</strong><p>高于或等于安全库存</p></div>
        <div class="kpi-card"><span>低于安全库存</span><strong style="color:var(--orange)">${lowCount}</strong><p>建议安排采购</p></div>
        <div class="kpi-card"><span>负库存</span><strong style="color:var(--danger)">${negCount}</strong><p>需修正库存异动</p></div>
    </div>
    <div class="table-wrap list-scroll">
        <table class="table">
            <thead><tr><th>品号</th><th>品名</th><th>品牌</th><th>单位</th><th class="num">总仓库存</th><th class="num">安全库存</th><th class="num">最高库存</th><th class="num">不足数量</th><th>状态</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
    renderShell("inventory_safety", content, "首页 / 报表查询 / 进销存安全库存");
};

/* ============================================================
   Excel 导入中心
   ============================================================ */
Pages.migrationCenter = function () {
    const list = DB.list("migrations").sort((a, b) => b.date.localeCompare(a.date));
    const rows = list.map(m => `<tr>
        <td><b>${h(m.type)}</b></td>
        <td>${h(m.filename)}</td>
        <td class="num">${m.total}</td>
        <td class="num" style="color:var(--green)">${m.ok}</td>
        <td class="num" style="color:${m.fail ? "var(--danger)" : "var(--muted)"}">${m.fail}</td>
        <td>${h(m.date)}</td>
        <td>${h(m.note || "-")}</td>
    </tr>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>Excel 导入中心</h1><p>批次导入商品、客户、供应商等主档资料。支持 .csv（首行为表头；.xlsx 请先在 Excel 中另存为 CSV 再导入）。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/tools/migration-center" onclick="event.preventDefault();Pages.downloadTemplate()">下载导入模板</a></div>
    </div>
    <div class="panel" style="margin-bottom:16px">
        <div class="panel-title"><h2>批次导入</h2></div>
        <div class="panel-body">
            <div class="toolbar" style="margin-bottom:0">
                <div class="filters">
                    <select id="migType">
                        <option value="items">商品主档</option>
                        <option value="customers">客户主档</option>
                        <option value="suppliers">供应商主档</option>
                    </select>
                    <input type="file" id="migFile" accept=".csv" style="max-width:300px">
                    <button class="btn primary" onclick="Pages.doMigrate()">开始导入</button>
                </div>
            </div>
            <p class="stat-line">支持 UTF-8 编码的 CSV 文件（Excel 另存为 CSV）。可先下载对应模板，按模板字段填写后导入。</p>
        </div>
    </div>
    <div class="table-wrap master-table-wrap">
        <table class="table">
            <thead><tr><th>导入类型</th><th>文件名称</th><th class="num">总笔数</th><th class="num">成功</th><th class="num">失败</th><th>导入时间</th><th>说明</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="7"><div class="empty-state"><div class="big">📥</div>暂无导入记录</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("migration_center", content, "首页 / 系统设置 / Excel 导入中心");
};

Pages.downloadTemplate = function () {
    const sel = document.getElementById("migType");
    const type = sel ? sel.value : "items";
    let csv = "", name = "";
    if (type === "customers") {
        csv = "客户代码,客户名称,联系人,电话,地址\nCUS000001,示例客户,张三,13800000000,浙江省义乌市\n";
        name = "客户导入模板.csv";
    } else if (type === "suppliers") {
        csv = "供应商代码,供应商名称,联系人,电话,地址\nSUP000001,示例供应商,李四,13900000000,浙江省义乌市\n";
        name = "供应商导入模板.csv";
    } else {
        csv = "品号,品名,规格,品牌,分类,成本,售价,安全库存,销售单位,采购币别\n605900001,越南1合1黑咖啡,,VINACAFE,咖啡饮品,239,320,20,箱,CNY\n";
        name = "商品导入模板.csv";
    }
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

Pages.doMigrate = function () {
    const type = document.getElementById("migType").value;
    const file = document.getElementById("migFile").files[0];
    if (!file) { toast("请先选择文件", "error"); return; }
    if (/\.xlsx?$/i.test(file.name)) { toast("暂不支持直接导入 .xlsx，请先在 Excel 中另存为 CSV（UTF-8）再导入", "error"); return; }
    const reader = new FileReader();
    reader.onload = function (ev) {
        let text = ev.target.result;
        // 尝试去除 BOM
        text = text.replace(/^\ufeff/, "");
        // 简单 CSV 解析
        const lines = text.split(/\r?\n/).filter(l => l.trim());
        if (lines.length < 2) { toast("文件内容为空", "error"); return; }
        const headers = Pages.parseCSVLine(lines[0]).map(x => x.trim());
        let ok = 0, fail = 0;
        const errors = [];

        for (let i = 1; i < lines.length; i++) {
            const vals = Pages.parseCSVLine(lines[i]);
            const row = {};
            headers.forEach((hd, idx) => { row[hd] = (vals[idx] || "").trim(); });
            try {
                if (type === "items") {
                    if (!row["品号"] || !row["品名"]) throw new Error("品号/品名不可为空");
                    if (DB.find("items", x => x.code === row["品号"])) throw new Error("品号已存在");
                    const cat = DB.find("categories", x => x.name === row["分类"]);
                    DB.insert("items", {
                        code: row["品号"], name: row["品名"], english_name: "", spec: row["规格"] || "",
                        brand: row["品牌"] || "", model: "", category_id: cat ? cat.id : "",
                        product_type: "成品", sales_unit: row["销售单位"] || "个", purchase_unit: row["销售单位"] || "个",
                        stock_unit: row["销售单位"] || "个", sales_to_stock: 1, purchase_to_stock: 1,
                        cost: Utils.num(row["成本"]), price: Utils.num(row["售价"]), min_price: Utils.num(row["售价"]) * 0.8,
                        purchase_currency: row["采购币别"] || "CNY", safety_stock: Utils.num(row["安全库存"]),
                        max_stock: 0, weight: 0, volume: 0, length_cm: 0, width_cm: 0, height_cm: 0,
                        barcode: "", qrcode: "", remark: "", disabled: false
                    });
                } else if (type === "customers") {
                    if (!row["客户代码"] || !row["客户名称"]) throw new Error("客户代码/客户名称不可为空");
                    if (DB.find("customers", x => x.code === row["客户代码"])) throw new Error("客户代码已存在");
                    DB.insert("customers", {
                        code: row["客户代码"], name: row["客户名称"], english_name: "", contact_person: row["联系人"] || "",
                        phone: row["电话"] || "", fax: "", email: "", address: row["地址"] || "",
                        city: "", country: "中国", tax_id: "", payment_method: "现款现货", payment_days: 0,
                        currency: "CNY", credit_limit: 0, level: "散客", sales_owner: "", remark: "", disabled: false
                    });
                } else if (type === "suppliers") {
                    if (!row["供应商代码"] || !row["供应商名称"]) throw new Error("供应商代码/供应商名称不可为空");
                    if (DB.find("suppliers", x => x.code === row["供应商代码"])) throw new Error("供应商代码已存在");
                    DB.insert("suppliers", {
                        code: row["供应商代码"], name: row["供应商名称"], english_name: "", contact_person: row["联系人"] || "",
                        phone: row["电话"] || "", fax: "", email: "", address: row["地址"] || "",
                        city: "", country: "中国", tax_id: "", payment_method: "现款现货", payment_days: 0,
                        currency: "CNY", credit_limit: 0, level: "国内供应商", remark: "", disabled: false
                    });
                }
                ok++;
            } catch (err) {
                fail++;
                if (errors.length < 5) errors.push(`第 ${i + 1} 行：${err.message}`);
            }
        }
        DB.insert("migrations", {
            type: type === "items" ? "商品主档" : type === "customers" ? "客户主档" : "供应商主档",
            filename: file.name, total: lines.length - 1, ok, fail,
            date: Utils.now(), note: errors.join("；")
        });
        toast(`导入完成：成功 ${ok} 笔，失败 ${fail} 笔`, fail ? "error" : "success");
        render();
    };
    reader.readAsText(file);
};

Pages.parseCSVLine = function (line) {
    const result = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else inQ = false;
            } else cur += ch;
        } else {
            if (ch === '"') inQ = true;
            else if (ch === ",") { result.push(cur); cur = ""; }
            else cur += ch;
        }
    }
    result.push(cur);
    return result;
};

/* ============================================================
   系统备份
   ============================================================ */
Pages.systemBackup = function () {
    const list = DB.list("backups").sort((a, b) => b.date.localeCompare(a.date));
    const rows = list.map(b => `<tr>
        <td><b>${h(b.no)}</b></td>
        <td>${h(b.date)}</td>
        <td class="num">${h(b.size)}</td>
        <td>${h(b.note || "-")}</td>
        <td class="action-col">
            ${b.snapshot ? `<button class="link-btn" onclick="Pages.restoreBackup('${b.id}')">恢复</button>` : `<span class="badge gray">无快照</span>`}
            <button class="link-btn danger" onclick="Pages.deleteBackup('${b.id}')">删除</button>
        </td>
    </tr>`).join("");
    const last = list[0];

    const content = `
    <div class="page-head">
        <div><h1>系统备份</h1><p>备份当前系统全部数据；正式使用前建议定期备份，降低数据遗失风险。</p></div>
        <div class="head-actions">
            <button class="btn primary" onclick="Pages.createBackup()">立即备份</button>
            <button class="btn ghost" onclick="Pages.exportData()">导出数据(JSON)</button>
            <button class="btn ghost" onclick="Pages.importData()">导入数据(JSON)</button>
            <button class="btn danger" onclick="Pages.clearBusinessData()">清空业务数据</button>
        </div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>最近备份</span><strong>${last ? h(last.date.slice(0, 16)) : "从未备份"}</strong><p>${last ? h(last.note) : "建议立即执行首次备份"}</p></div>
        <div class="kpi-card"><span>备份总数</span><strong>${list.length}</strong><p>历史备份记录</p></div>
    </div>
    <div class="table-wrap backup-list">
        <table class="table">
            <thead><tr><th>备份编号</th><th>备份时间</th><th class="num">大小</th><th>说明</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="5"><div class="empty-state"><div class="big">💾</div>暂无备份记录</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("system_backup", content, "首页 / 系统设置 / 系统备份");
};

/* 清空业务数据（保留基础资料与账号） */
Pages.clearBusinessData = function () {
    confirmModal(
        "确定要清空全部业务数据吗？将删除：销货单、出货单、采购单、样品领料、销货退回/折让、采购退回/折让、商品主档及全部库存（安全库存一并清零）。<br><br>系统账号、客户、供应商、仓库、币别、单位、分类等基础资料会保留。此操作不可撤销！",
        () => {
            DB.clearBusiness();
            toast("已清空全部业务数据", "success");
            setTimeout(() => { location.hash = "#/system/backup"; location.reload(); }, 600);
        },
        "清空业务数据"
    );
};

Pages.createBackup = function () {
    const data = JSON.parse(JSON.stringify(DB._mem));
    // 清理备份记录中的历史快照，避免快照嵌套导致存储体积无限膨胀
    (data.backups || []).forEach(b => { delete b.snapshot; });
    const size = Math.max(1, Math.round(JSON.stringify(data).length / 1024));
    DB.insert("backups", {
        no: nextDocNo("BK", "backups"), date: Utils.now(),        size: (size / 1024).toFixed(1) + " MB",
        note: "手动备份",
        snapshot: JSON.stringify(data)
    });
    toast("备份完成", "success");
    render();
};

Pages.restoreBackup = function (id) {
    const b = DB.get("backups", id);
    if (!b || !b.snapshot) { toast("该备份不包含数据快照", "error"); return; }
    confirmModal(`确定要从备份 ${b.no}（${b.date}）恢复数据吗？当前数据将被覆盖。`, () => {
        try {
            const data = JSON.parse(b.snapshot);
            data.backups = DB.list("backups"); // 保留现有备份历史，避免恢复后丢失快照清单
            // 恢复的数据视为最新版本（rev 抬到当前时间），避免 12 秒轮询被云端旧快照覆盖还原；
            // 并经 DB.flush() 触发云同步，让其他设备自动拉到恢复后的数据
            data.__rev = Date.now();
            if (typeof CloudSync !== "undefined" && CloudSync && CloudSync.deviceId) data.__device = CloudSync.deviceId();
            DB._mem = data;
            DB._loaded = true;
            DB.flush();
            toast("数据已恢复（已同步到云端）", "success");
            render();
        } catch (e) { toast("恢复失败：数据损坏", "error"); }
    }, "恢复备份");
};

Pages.deleteBackup = function (id) {
    confirmModal("确定要删除这笔备份记录吗？", () => {
        DB.remove("backups", id);
        toast("已删除", "success");
        render();
    });
};

Pages.exportData = function () {
    const blob = new Blob([JSON.stringify(DB._mem, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "钛沅ERP_备份_" + Utils.today() + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("数据已导出", "success");
};

Pages.importData = function () {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = function () {
        const f = input.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = function (ev) {
            try {
                const data = JSON.parse(ev.target.result);
                if (!data.items) throw new Error("不是有效的备份文件");
                confirmModal(`确定要导入该备份文件吗？当前数据将被覆盖（共 ${Object.keys(data).length} 个数据表）。`, () => {
                    // 导入的数据视为最新版本并经 DB.flush() 触发云同步，其他设备自动拉到
                    data.__rev = Date.now();
                    if (typeof CloudSync !== "undefined" && CloudSync && CloudSync.deviceId) data.__device = CloudSync.deviceId();
                    DB._mem = data;
                    DB._loaded = true;
                    DB.flush();
                    toast("数据导入成功（已同步到云端）", "success");
                    render();
                }, "导入数据");
            } catch (e) { toast("导入失败：文件格式不正确", "error"); }
        };
        reader.readAsText(f);
    };
    input.click();
};

/* ============================================================
   用户管理
   ============================================================ */
Pages.users = function () {
    const list = DB.list("users").sort((a, b) => a.username.localeCompare(b.username));
    const rows = list.map(u => {
        const role = DB.get("roles", u.role_id);
        return `<tr>
            <td><b>${h(u.username)}</b></td>
            <td>${h(u.name)}</td>
            <td><span class="badge blue">${h(role ? role.name : "-")}</span></td>
            <td>${h(u.email || "-")}</td>
            <td>${h(u.phone || "-")}</td>
            <td>${u.status === "启用" ? badge("启用") : badge("停用")}</td>
            <td>${h((u.created_at || "").slice(0, 10))}</td>
            <td class="action-col">
                <a class="link-btn" href="#/users/${u.id}/edit">编辑</a>
                ${u.username !== "admin" ? `<button class="link-btn danger" onclick="Pages.deleteUser('${u.id}')">删除</button>` : ""}
            </td>
        </tr>`;
    }).join("");

    const content = `
    <div class="page-head">
        <div><h1>用户管理</h1><p>维护系统登录账号与所属角色。</p></div>
        <div class="head-actions">${can("system.user") ? `<a class="btn primary" href="#/users/create">+ 新增用户</a>` : ""}</div>
    </div>
    <div class="table-wrap master-table-wrap">
        <table class="table">
            <thead><tr><th>账号</th><th>姓名</th><th>角色</th><th>Email</th><th>电话</th><th>状态</th><th>建立日期</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
    renderShell("users", content, "首页 / 系统设置 / 用户管理");
};

Pages.deleteUser = function (id) {
    const u = DB.get("users", id);
    if (!u) return;
    const me = DB.currentUser();
    if (me && me.id === id) { toast("不能删除当前登录的账号", "error"); return; }
    const role = DB.get("roles", u.role_id);
    if (role && role.name === "系统管理员") {
        const admins = DB.list("users").filter(x => {
            const r = DB.get("roles", x.role_id);
            return r && r.name === "系统管理员" && x.status !== "停用";
        });
        if (admins.length <= 1) { toast("至少保留一位启用的系统管理员账号", "error"); return; }
    }
    confirmModal(`确定要删除用户 ${u.username} 吗？`, () => {
        DB.remove("users", id);
        toast("用户已删除", "success");
        render();
    });
};

Pages.userForm = function (id) {
    const u = id ? DB.get("users", id) : null;
    if (id && !u) { toast("找不到该用户", "error"); render(); return; }
    const isEdit = !!u;
    const roleOpts = DB.list("roles").map(r => `<option value="${r.id}" ${u && u.role_id === r.id ? "selected" : ""}>${h(r.name)}</option>`).join("");

    const content = `
    <div class="page-head">
        <div><h2>用户管理｜${isEdit ? "编辑" : "新增"}</h2></div>
        <div class="actions"><a class="btn" href="#/users">返回用户管理</a></div>
    </div>
    <form class="form-panel" style="max-width:720px" novalidate onsubmit="Pages.saveUser(event, '${id || ""}')">
        <div class="form-grid section-grid">
            <div class="form-item"><label>账号<b>*</b></label><input name="username" value="${h(u ? u.username : "")}" required ${isEdit ? "readonly" : ""}></div>
            <div class="form-item"><label>密码<b>*</b></label><input type="password" name="password" value="${h(u ? u.password : "")}" required placeholder="${isEdit ? "输入新密码或保留原密码" : "设置登录密码"}"></div>
            <div class="form-item"><label>姓名<b>*</b></label><input name="name" value="${h(u ? u.name : "")}" required></div>
            <div class="form-item"><label>角色<b>*</b></label><select name="role_id" required>${roleOpts}</select></div>
            <div class="form-item"><label>Email</label><input name="email" value="${h(u ? u.email : "")}"></div>
            <div class="form-item"><label>电话</label><input name="phone" value="${h(u ? u.phone : "")}"></div>
            <div class="form-item"><label>状态</label><select name="status"><option ${!u || u.status === "启用" ? "selected" : ""}>启用</option><option ${u && u.status === "停用" ? "selected" : ""}>停用</option></select></div>
        </div>
        <div class="form-actions">
            <button class="btn primary" type="submit">保存用户</button>
            <a class="btn" href="#/users">返回</a>
        </div>
    </form>`;
    renderShell("users", content, "首页 / 系统设置 / 用户管理");
};

Pages.saveUser = function (e, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const d = {};
    fd.forEach((v, k) => { d[k] = v; });
    const dup = DB.find("users", x => x.username === d.username && x.id !== id);
    if (dup) { toast("账号已存在", "error"); return; }
    if (!d.username) { toast("请输入账号", "error"); return; }
    if (!d.name) { toast("请输入姓名", "error"); return; }
    if (!d.role_id) { toast("请选择角色", "error"); return; }
    if (!d.password) { toast("请输入密码", "error"); return; }
    const payload = { username: d.username, password: d.password, name: d.name, role_id: d.role_id, email: d.email || "", phone: d.phone || "", status: d.status };
    // 最后一个管理员保护：不允许把唯一的启用的系统管理员改为其他角色或停用
    if (id) {
        const old = DB.get("users", id);
        const oldRole = old ? DB.get("roles", old.role_id) : null;
        const newRole = DB.get("roles", d.role_id);
        const isAdminRole = (r) => r && r.name === "系统管理员";
        if (isAdminRole(oldRole)) {
            const otherAdmins = DB.list("users").filter(x => {
                const r = DB.get("roles", x.role_id);
                return isAdminRole(r) && x.id !== id && x.status !== "停用";
            }).length;
            if (otherAdmins < 1) {
                if (!isAdminRole(newRole)) { toast("至少保留一位启用的系统管理员账号，不能变更其角色", "error"); return; }
                if (d.status === "停用") { toast("至少保留一位启用的系统管理员账号，不能停用", "error"); return; }
            }
        }
    }
    if (id) {
        DB.update("users", id, payload);
        toast("用户已更新", "success");
    } else {
        DB.insert("users", payload);
        toast("用户已新增", "success");
    }
    setTimeout(() => { location.hash = "#/users"; }, 300);
};

/* ============================================================
   角色管理
   ============================================================ */
Pages.roles = function () {
    const list = DB.list("roles");
    const rows = list.map(r => `<tr>
        <td><b>${h(r.name)}</b></td>
        <td>${h(r.description || "-")}</td>
        <td><span class="badge blue">${r.permissions.length}</span></td>
        <td>${DB.list("users").filter(u => u.role_id === r.id).length} 人</td>
        <td class="action-col">
            <a class="link-btn" href="#/roles/${r.id}/edit">编辑权限</a>
            <button class="link-btn danger" onclick="Pages.deleteRole('${r.id}')">删除</button>
        </td>
    </tr>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>角色管理</h1><p>设定角色的功能权限，用户透过角色取得权限。</p></div>
        <div class="head-actions">${can("system.role") ? `<a class="btn primary" href="#/roles/create">+ 新增角色</a>` : ""}</div>
    </div>
    <div class="table-wrap master-table-wrap">
        <table class="table">
            <thead><tr><th>角色名称</th><th>说明</th><th>权限数</th><th>用户数</th><th class="action-col">操作</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="5"><div class="empty-state"><div class="big">🎭</div>暂无角色</div></td></tr>`}</tbody>
        </table>
    </div>`;
    renderShell("roles", content, "首页 / 系统设置 / 角色管理");
};

Pages.deleteRole = function (id) {
    const r = DB.get("roles", id);
    if (!r) return;
    const used = DB.list("users").filter(u => u.role_id === id).length;
    if (used > 0) { toast("该角色已有用户使用，无法删除", "error"); return; }
    confirmModal(`确定要删除角色 ${r.name} 吗？`, () => {
        DB.remove("roles", id);
        toast("角色已删除", "success");
        render();
    });
};

Pages.roleForm = function (id) {
    const r = id ? DB.get("roles", id) : null;
    if (id && !r) { toast("找不到该角色", "error"); render(); return; }
    const isEdit = !!r;
    const groups = {};
    PERMISSIONS.forEach(p => {
        if (!groups[p.group]) groups[p.group] = [];
        groups[p.group].push(p);
    });
    const permHtml = Object.keys(groups).map(g => `
        <div class="form-section">
            <div class="form-section-title"><h3>${g}</h3></div>
            <div class="section-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px">
                ${groups[g].map(p => `<label class="inline-check" style="padding:6px 10px;background:var(--panel);border:1px solid var(--line);border-radius:7px">
                    <input type="checkbox" name="perm" value="${p.code}" ${r && r.permissions.indexOf(p.code) >= 0 ? "checked" : ""}> ${h(p.label)}
                </label>`).join("")}
            </div>
        </div>`).join("");

    const content = `
    <div class="page-head">
        <div><h2>角色管理｜${isEdit ? "编辑" : "新增"}</h2><p>勾选该角色可使用的功能权限。</p></div>
        <div class="actions"><a class="btn" href="#/roles">返回角色管理</a></div>
    </div>
    <form class="form-panel" novalidate onsubmit="Pages.saveRole(event, '${id || ""}')">
        <div class="form-grid section-grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">
            <div class="form-item"><label>角色名称<b>*</b></label><input name="name" value="${h(r ? r.name : "")}" required></div>
            <div class="form-item"><label>说明</label><input name="description" value="${h(r ? r.description : "")}"></div>
        </div>
        <div class="toolbar" style="margin:18px 0 0">
            <button class="btn sm" type="button" onclick="Pages.checkAllPerm(true)">全选</button>
            <button class="btn sm" type="button" onclick="Pages.checkAllPerm(false)">全不选</button>
        </div>
        ${permHtml}
        <div class="form-actions sticky-actions">
            <button class="btn primary" type="submit">保存角色</button>
            <a class="btn" href="#/roles">返回</a>
        </div>
    </form>`;
    renderShell("roles", content, "首页 / 系统设置 / 角色管理");
};

Pages.checkAllPerm = function (check) {
    document.querySelectorAll('[name="perm"]').forEach(cb => { cb.checked = check; });
};

Pages.saveRole = function (e, id) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = fd.get("name");
    const desc = fd.get("description") || "";
    const perms = e.target.querySelectorAll('[name="perm"]:checked');
    const permissions = Array.from(perms).map(cb => cb.value);
    if (!name) { toast("请输入角色名称", "error"); return; }
    if (!permissions.length) { toast("请至少勾选一项权限", "error"); return; }
    if (id) {
        DB.update("roles", id, { name, description: desc, permissions });
        toast("角色已更新", "success");
    } else {
        DB.insert("roles", { name, description: desc, permissions });
        toast("角色已新增", "success");
    }
    setTimeout(() => { location.hash = "#/roles"; }, 300);
};

/* ============================================================
   权限管理
   ============================================================ */
Pages.permissions = function () {
    const groups = {};
    PERMISSIONS.forEach(p => {
        if (!groups[p.group]) groups[p.group] = [];
        groups[p.group].push(p);
    });
    const rows = Object.keys(groups).map(g => `
        <tr class="section-row"><td colspan="3" style="color:var(--blue);font-weight:700">${g}</td></tr>
        ${groups[g].map(p => `<tr class="indent">
            <td><code style="background:var(--bg);padding:2px 8px;border-radius:5px;font-size:12px">${h(p.code)}</code></td>
            <td>${h(p.label)}</td>
            <td>${DB.list("roles").filter(r => r.permissions.indexOf(p.code) >= 0).map(r => `<span class="badge blue" style="margin:1px 2px">${h(r.name)}</span>`).join("") || '<span style="color:var(--muted)">-</span>'}</td>
        </tr>`).join("")}`).join("");

    const content = `
    <div class="page-head">
        <div><h1>权限管理</h1><p>系统全部功能权限一览；权限由角色分配，用户透过角色取得。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/roles">前往角色管理</a></div>
    </div>
    <div class="table-wrap master-table-wrap">
        <table class="table">
            <thead><tr><th>权限代码</th><th>权限说明</th><th>拥有角色</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
    renderShell("permissions", content, "首页 / 系统设置 / 权限管理");
};

/* ============================================================
   损益报表（每日 / 每月）
   口径与仪表板「本月经营摘要」一致（本位币）：
   - 收入按「出货日期」归属（订单已出货 shipment 1:1，整单金额计入出货日所在期间）
   - 销货成本 = Σ 明细 qty × 销售→库存换算率 × 商品成本(采购币别折本位币)
   - 销退按「退回日期」冲减营收（订单币别折本位币）与成本（cost_reversal 已为本位币）
   - 毛利 = (营收 - 销退营收) - (销货成本 - 销退成本)
   ============================================================ */
Pages.profitReport = function () {
    const mode = window.__profitMode || "day";       // day | month
    const range = window.__profitRange || (mode === "day" ? "30" : "12");

    const buckets = profitSeries(mode, range);

    // ---- 汇总 ----
    const totRev = Utils.round(buckets.reduce((s, b) => s + b.netRevenue, 0));
    const totCogs = Utils.round(buckets.reduce((s, b) => s + (b.cogs - b.retCost), 0));
    const totProfit = Utils.round(buckets.reduce((s, b) => s + b.profit, 0));
    const totMargin = totRev !== 0 ? totProfit / totRev * 100 : 0;

    const rangeOpts = mode === "day"
        ? [["7", "近 7 天"], ["14", "近 14 天"], ["30", "近 30 天"], ["90", "近 90 天"]]
        : [["3", "近 3 个月"], ["6", "近 6 个月"], ["12", "近 12 个月"], ["24", "近 24 个月"]];
    const rangeHtml = rangeOpts.map(o => `<option value="${o[0]}" ${range === o[0] ? "selected" : ""}>${o[1]}</option>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>进销存损益报表</h1><p>营收 / 销货成本 / 毛利走势（本位币 ${COMPANY.baseCurrency}，收入按出货日期归属、销退冲减）。</p></div>
        <div class="head-actions"><a class="btn ghost" href="#/dashboard">仪表板</a></div>
    </div>
    <div class="toolbar">
        <div class="filters">
            <div class="seg">
                <button class="btn ${mode === "day" ? "primary" : "ghost"}" onclick="Pages.setProfitMode('day')">每日</button>
                <button class="btn ${mode === "month" ? "primary" : "ghost"}" onclick="Pages.setProfitMode('month')">每月</button>
            </div>
            <select onchange="Pages.setProfitRange(this.value)">${rangeHtml}</select>
        </div>
    </div>
    <div class="kpi-grid">
        <div class="kpi-card"><span>区间净营收</span><strong>${fmt(totRev)}</strong><p>营收 - 销退冲减</p></div>
        <div class="kpi-card"><span>销货成本</span><strong>${fmt(totCogs)}</strong><p>出货成本 - 销退成本冲回</p></div>
        <div class="kpi-card"><span>区间毛利</span><strong style="color:${totProfit >= 0 ? "var(--green)" : "var(--danger)"}">${fmt(totProfit)}</strong><p>净营收 - 销货成本净额</p></div>
        <div class="kpi-card"><span>毛利率</span><strong>${totMargin.toFixed(1)}%</strong><p>毛利 ÷ 净营收</p></div>
    </div>
    <div class="panel" style="margin-bottom:16px">
        <div class="panel-title"><h2>${mode === "day" ? "每日" : "每月"}损益走势</h2>
            <span style="font-size:12px;color:var(--muted)">hover 柱体查看数值</span></div>
        <div class="panel-body">${profitChartSVG(buckets)}</div>
    </div>
    <div class="table-wrap master-table-wrap">
        <table class="table">
            <thead><tr><th>${mode === "day" ? "日期" : "月份"}</th><th class="num">净营收</th><th class="num">销货成本</th><th class="num">毛利</th><th class="num">毛利率</th></tr></thead>
            <tbody>${buckets.map(b => `<tr>
                <td><b>${h(b.label)}</b></td>
                <td class="num line-amount" data-v="${b.netRevenue}">${fmt(b.netRevenue)}</td>
                <td class="num line-amount" data-v="${b.cogs - b.retCost}">${fmt(b.cogs - b.retCost)}</td>
                <td class="num line-amount" data-v="${b.profit}" style="color:${b.profit >= 0 ? "var(--green)" : "var(--danger)"}">${fmt(b.profit)}</td>
                <td class="num">${b.netRevenue !== 0 ? (b.profit / b.netRevenue * 100).toFixed(1) + "%" : "-"}</td>
            </tr>`).join("")}
            <tr class="section-row">
                <td><b>合计</b></td>
                <td class="num line-amount" data-v="${totRev}"><b>${fmt(totRev)}</b></td>
                <td class="num line-amount" data-v="${totCogs}"><b>${fmt(totCogs)}</b></td>
                <td class="num line-amount" data-v="${totProfit}" style="color:${totProfit >= 0 ? "var(--green)" : "var(--danger)"}"><b>${fmt(totProfit)}</b></td>
                <td class="num"><b>${totMargin.toFixed(1)}%</b></td>
            </tr></tbody>
        </table>
    </div>`;
    renderShell("profit_report", content, "首页 / 报表查询 / 进销存损益报表");
};

Pages.setProfitMode = function (mode) {
    window.__profitMode = mode;
    // 当前范围对目标视图不合法时重置为默认（day→30 / month→12），避免 select 值与选项错位
    const legal = mode === "day" ? ["7", "14", "30", "90"] : ["3", "6", "12", "24"];
    if (!legal.includes(window.__profitRange)) window.__profitRange = mode === "day" ? "30" : "12";
    Pages.profitReport();
};
Pages.setProfitRange = function (range) { window.__profitRange = range; Pages.profitReport(); };

/* 生成损益期间桶序列（每桶含营收/成本/销退冲减/毛利） */
function profitSeries(mode, range) {
    const n = parseInt(range, 10) || (mode === "day" ? 30 : 12);
    const now = new Date();
    const buckets = [];
    if (mode === "day") {
        for (let i = n - 1; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
            buckets.push({ key, label: key.slice(5), start: key, end: key });
        }
    } else {
        for (let i = n - 1; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const y = d.getFullYear(), m = d.getMonth() + 1;
            const start = y + "-" + String(m).padStart(2, "0") + "-01";
            const end = y + "-" + String(m).padStart(2, "0") + "-" + String(new Date(y, m, 0).getDate()).padStart(2, "0");
            buckets.push({ key: y + "-" + String(m).padStart(2, "0"), label: y + "-" + String(m).padStart(2, "0"), start, end });
        }
    }

    // 出货归属：shipment.ship_date → 已出货订单（一个订单只出货一次，1:1）
    const orders = DB.list("sales_orders");
    const ordersById = {};
    orders.forEach(o => { ordersById[o.id] = o; });
    const shipMap = {};
    DB.list("shipments").forEach(s => {
        const o = ordersById[s.sales_order_id];
        if (o && o.status === "shipped") {
            (shipMap[s.ship_date] = shipMap[s.ship_date] || []).push(s.sales_order_id);
        }
    });
    // 销退按退回日期归属
    const retMap = {};
    DB.list("sales_returns").forEach(r => {
        (retMap[r.return_date] = retMap[r.return_date] || []).push(r);
    });

    buckets.forEach(b => {
        let revenue = 0, cogs = 0, retTotal = 0, retCost = 0;
        Object.keys(shipMap).forEach(d => {
            if (d < b.start || d > b.end) return;
            shipMap[d].forEach(oid => {
                const o = ordersById[oid];
                revenue += toCNY(o.invoice_amount, o.currency);
                o.lines.forEach(l => {
                    const it = DB.get("items", l.item_id);
                    const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
                    cogs += Utils.num(l.qty) * rate * itemCostCNY(it);
                });
            });
        });
        Object.keys(retMap).forEach(d => {
            if (d < b.start || d > b.end) return;
            retMap[d].forEach(r => {
                const so = ordersById[r.sales_order_id];
                retTotal += toCNY(r.total_amount, so ? so.currency : "");
                retCost += Utils.num(r.cost_reversal);
            });
        });
        b.revenue = Utils.round(revenue);
        b.cogs = Utils.round(cogs);
        b.retTotal = Utils.round(retTotal);
        b.retCost = Utils.round(retCost);
        b.netRevenue = Utils.round(revenue - retTotal);
        b.profit = Utils.round((revenue - retTotal) - (cogs - retCost));
    });
    return buckets;
}

/* SVG 分组柱状图（营收 / 销货成本 / 毛利），自适应宽度 */
function profitChartSVG(buckets) {
    const W = 960, H = 330, PL = 54, PR = 14, PT = 20, PB = 36;
    const plotW = W - PL - PR, plotH = H - PT - PB;
    const n = buckets.length;

    // 值域（含负毛利）与 Y 轴 nice 刻度
    let vmax = 0, vmin = 0;
    buckets.forEach(b => {
        [b.netRevenue, b.cogs - b.retCost, b.profit].forEach(v => {
            if (v > vmax) vmax = v;
            if (v < vmin) vmin = v;
        });
    });
    const yHi = niceCeil(vmax), yLo = niceFloor(vmin);
    const span = (yHi - yLo) || 1;
    const y0px = PT + (yHi - 0) / span * plotH;            // 0 线像素位置
    const yPx = v => PT + (yHi - v) / span * plotH;

    // Y 网格线（4 段）
    const gridStep = niceCeil((yHi - yLo) / 4);
    let grid = "";
    for (let gv = yLo; gv <= yHi + 1e-9; gv += gridStep) {
        const gy = yPx(gv);
        grid += `<line x1="${PL}" y1="${gy}" x2="${W - PR}" y2="${gy}" stroke="var(--line)" stroke-width="1" ${gv === 0 ? 'stroke-dasharray="0"' : 'stroke-dasharray="3 3"'}/>`;
        grid += `<text x="${PL - 8}" y="${gy + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${fmtShort(gv)}</text>`;
    }

    // 柱体（每桶三柱：净营收 / 成本 / 毛利）
    const bw = plotW / n;
    const groupW = Math.min(bw * 0.62, 34);
    const barW = Math.max(groupW / 3 - 2, 2);
    const labelEvery = Math.ceil(n / 14);                    // X 轴标签抽稀
    let bars = "", labels = "";
    buckets.forEach((b, i) => {
        const gx = PL + i * bw + (bw - groupW) / 2;
        const gy = yPx(0);
        const series = [
            { v: b.netRevenue, fill: "var(--blue)", name: "净营收" },
            { v: b.cogs - b.retCost, fill: "var(--muted)", name: "销货成本" },
            { v: b.profit, fill: b.profit >= 0 ? "var(--green)" : "var(--danger)", name: "毛利" }
        ];
        series.forEach((s, j) => {
            const x = gx + j * (barW + 2);
            const hgt = Math.abs(s.v) / span * plotH;
            const yy = s.v >= 0 ? gy - hgt : gy;
            bars += `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(hgt.toFixed(1), 0.5)}" rx="1.5" fill="${s.fill}" opacity="0.92">
                <title>${h(b.label)}｜${s.name}：${fmt(s.v)}</title></rect>`;
        });
        if (i % labelEvery === 0 || i === n - 1) {
            labels += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${h(b.label)}</text>`;
        }
    });

    // 0 线
    const zero = `<line x1="${PL}" y1="${y0px.toFixed(1)}" x2="${W - PR}" y2="${y0px.toFixed(1)}" stroke="var(--text)" stroke-width="1.2" opacity="0.55"/>`;

    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="损益走势图" class="profit-chart">
        ${grid}${zero}${bars}${labels}
    </svg>
    <div class="chart-legend">
        <span><i style="background:var(--blue)"></i>净营收</span>
        <span><i style="background:var(--muted)"></i>销货成本</span>
        <span><i style="background:var(--green)"></i>毛利</span>
        <span><i style="background:var(--danger)"></i>亏损</span>
    </div>`;
}

function niceCeil(v) {
    if (v === 0) return 1;
    const a = Math.abs(v);
    const p = Math.pow(10, Math.floor(Math.log10(a)));
    const d = a / p;
    const m = d <= 1 ? 1 : d <= 2 ? 2 : d <= 5 ? 5 : 10;
    return m * p * (v < 0 ? -1 : 1);
}
function niceFloor(v) {
    if (v >= 0) return 0;
    return -niceCeil(-v);
}
function fmtShort(v) {
    const a = Math.abs(v);
    if (a >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, "") + "亿";
    if (a >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, "") + "万";
    return Utils.num(v).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
}
