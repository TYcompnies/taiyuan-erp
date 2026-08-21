/* ============================================================
   会计引擎（accounting.js）
   - 会计科目查找（含旧科目名称兼容映射）
   - 业务事件自动产生已过账传票（幂等：biz_key 去重）
   - 总分类账 / 试算表 / 资产负债表 计算口径
   - 业务资料回填传票（含期初差额调整，衔接既有账款财务数据）
   所有传票金额一律为本位币（CNY），与损益表/应收应付口径一致。
   ============================================================ */

/* 旧版传票/费用使用的科目名称 → 标准科目名称映射 */
const ACCT_LEGACY_MAP = {
    "现金": "库存现金",
    "应交税费-销项税": "应交税费",
    "应交税费-进项税": "应交税费",
    "销售费用-物流": "销售费用",
    "销售费用-平台费": "销售费用",
    "销售费用-广告": "销售费用",
    "销售费用-包装": "销售费用",
    "管理费用-房租": "管理费用",
    "管理费用-水电": "管理费用",
    "管理费用-办公": "管理费用",
    "管理费用-工资": "管理费用",
    "管理费用-差旅": "管理费用"
};

const ACCT = {
    /* ---------- 科目查找 ---------- */
    account(name) {
        if (!name) return null;
        const std = ACCT_LEGACY_MAP[name] || name;
        return DB.find("chart_accounts", a => a.name === std) || DB.find("chart_accounts", a => a.name === name);
    },
    accountType(name) {
        const a = this.account(name);
        return a ? a.type : "未分类";
    },
    accountDirection(name) {
        const a = this.account(name);
        return a ? a.direction : "借";
    },
    /* 收付款方式对应的货币资金科目：现金类方式记库存现金，其余记银行存款 */
    cashAccountFor(method) {
        return /现金|现款/i.test(String(method || "")) ? "库存现金" : "银行存款";
    },

    /* ---------- 传票写入（幂等） ----------
       spec: { bizKey, date, source, source_no, counterparty, payment_method, lines:[{account,debit,credit}], remark } */
    postAutoVoucher(spec) {
        if (!spec || !spec.bizKey) return null;
        if (DB.list("vouchers").some(v => v.biz_key === spec.bizKey)) return null; // 幂等
        const lines = (spec.lines || []).filter(l => l && l.account && (Utils.num(l.debit) !== 0 || Utils.num(l.credit) !== 0))
            .map(l => ({ account: l.account, debit: Utils.round(Math.abs(Utils.num(l.debit))), credit: Utils.round(Math.abs(Utils.num(l.credit))) }));
        if (!lines.length) return null;
        const dTotal = lines.reduce((s, l) => s + l.debit, 0);
        const cTotal = lines.reduce((s, l) => s + l.credit, 0);
        if (Math.abs(dTotal - cTotal) > 0.01) return null; // 不平衡不写
        if (dTotal < 0.005 && cTotal < 0.005) return null; // 零金额不写
        return DB.insert("vouchers", {
            no: nextDocNo("JV", "vouchers", spec.date), date: spec.date || Utils.today(),
            source: spec.source || "其他", source_no: spec.source_no || "", counterparty: spec.counterparty || "",
            payment_method: spec.payment_method || "", status: "已过账",
            lines, balanced: true, auto: true, biz_key: spec.bizKey,
            remark: spec.remark || "系统自动产生", created_by: "系统自动"
        });
    },

    /* 作废某业务键的自动传票（随业务单据删除/回冲，传票不再计入报表） */
    voidVouchers(bizKey) {
        if (!bizKey) return 0;
        let n = 0;
        DB.list("vouchers").filter(v => v.biz_key === bizKey && v.status === "已过账").forEach(v => {
            DB.update("vouchers", v.id, { status: "已作废", voided_at: Utils.now() });
            n++;
        });
        return n;
    },

    /* ---------- 业务事件 → 传票 ---------- */

    /* 出货：借应收账款(含税) / 贷主营业务收入 + 应交税费；借主营业务成本 / 贷库存商品 */
    onShipment(shipment, order) {
        if (!shipment || !order) return null;
        const inv = toCNY(Utils.num(order.invoice_amount), order.currency);
        const tax = toCNY(Utils.num(order.tax_amount), order.currency);
        const net = inv - tax;
        const cogs = (shipment.lines || []).reduce((s, l) => {
            const it = DB.get("items", l.item_id);
            const rate = it && Utils.num(it.sales_to_stock) > 0 ? Utils.num(it.sales_to_stock) : 1;
            return s + Utils.num(l.qty) * rate * itemCostCNY(it);
        }, 0);
        const cust = DB.get("customers", order.customer_id);
        const lines = [
            { account: "应收账款", debit: inv, credit: 0 },
            { account: "主营业务收入", debit: 0, credit: net }
        ];
        if (tax > 0.004) lines.push({ account: "应交税费", debit: 0, credit: tax });
        if (cogs > 0.004) {
            lines.push({ account: "主营业务成本", debit: cogs, credit: 0 });
            lines.push({ account: "库存商品", debit: 0, credit: cogs });
        }
        return this.postAutoVoucher({
            bizKey: "SHIP:" + shipment.id, date: shipment.ship_date, source: "应收账款",
            source_no: shipment.no, counterparty: cust ? cust.name : "", lines,
            remark: "出货收入与成本 " + shipment.order_no
        });
    },

    /* 进货：借库存商品(含税分拆) / 贷应付账款 */
    onPOReceive(po) {
        if (!po) return null;
        const amt = toCNY(Utils.num(po.amount), po.currency);
        const tax = toCNY(Utils.num(po.tax_amount || 0), po.currency);
        const goods = amt - tax;
        const sp = DB.get("suppliers", po.supplier_id);
        const lines = [
            { account: "库存商品", debit: goods, credit: 0 },
            { account: "应付账款", debit: 0, credit: amt }
        ];
        if (tax > 0.004) lines.push({ account: "应交税费", debit: tax, credit: 0 });
        return this.postAutoVoucher({
            bizKey: "PO:" + po.id, date: po.po_date || Utils.today(), source: "应付账款",
            source_no: po.no, counterparty: sp ? sp.name : "", lines,
            remark: "进货入库 " + po.no
        });
    },

    /* 收款：借货币资金 / 贷应收账款 */
    onReceipt(so, amount, date, method) {
        if (!so || Utils.num(amount) <= 0) return null;
        const amt = toCNY(Utils.num(amount), so.currency);
        const cust = DB.get("customers", so.customer_id);
        const n = DB.list("vouchers").filter(v => (v.biz_key || "").indexOf("RECV:" + so.id + ":") === 0).length + 1;
        return this.postAutoVoucher({
            bizKey: "RECV:" + so.id + ":" + n, date: date || Utils.today(), source: "收款作业",
            source_no: so.no, counterparty: cust ? cust.name : "", payment_method: method || "",
            lines: [
                { account: this.cashAccountFor(method), debit: amt, credit: 0 },
                { account: "应收账款", debit: 0, credit: amt }
            ],
            remark: "收到货款 " + so.no
        });
    },

    /* 付款：借应付账款 / 贷货币资金 */
    onPayment(po, amount, date, method) {
        if (!po || Utils.num(amount) <= 0) return null;
        const amt = toCNY(Utils.num(amount), po.currency);
        const sp = DB.get("suppliers", po.supplier_id);
        const n = DB.list("vouchers").filter(v => (v.biz_key || "").indexOf("PAY:" + po.id + ":") === 0).length + 1;
        return this.postAutoVoucher({
            bizKey: "PAY:" + po.id + ":" + n, date: date || Utils.today(), source: "付款作业",
            source_no: po.no, counterparty: sp ? sp.name : "", payment_method: method || "",
            lines: [
                { account: "应付账款", debit: amt, credit: 0 },
                { account: this.cashAccountFor(method), debit: 0, credit: amt }
            ],
            remark: "支付货款 " + po.no
        });
    },

    /* 费用：借费用科目 / 贷货币资金 */
    onExpense(ex) {
        if (!ex) return null;
        const v = this.postAutoVoucher({
            bizKey: "EXP:" + ex.id, date: ex.date, source: "费用支出",
            source_no: ex.no, counterparty: "", payment_method: ex.payment_method || "",
            lines: [
                { account: ex.account, debit: Utils.num(ex.amount), credit: 0 },
                { account: this.cashAccountFor(ex.payment_method), debit: 0, credit: Utils.num(ex.amount) }
            ],
            remark: "费用支出 " + (ex.type || "") + " " + ex.no
        });
        if (v) DB.update("expenses", ex.id, { voucher_no: v.no });
        return v;
    },

    /* 销货退回：冲收入冲应收（冲减应收时）；回补库存时冲回成本 */
    onSalesReturn(sr, so) {
        if (!sr || !so) return null;
        const total = toCNY(Utils.num(sr.total_amount), so.currency);
        const cost = Utils.num(sr.cost_reversal);
        const cust = DB.get("customers", so.customer_id);
        const lines = [];
        if (sr.offset_receivable && total > 0.004) {
            lines.push({ account: "主营业务收入", debit: total, credit: 0 });
            lines.push({ account: "应收账款", debit: 0, credit: total });
        }
        if (sr.type === "退回" && cost > 0.004) {
            lines.push({ account: "库存商品", debit: cost, credit: 0 });
            lines.push({ account: "主营业务成本", debit: 0, credit: cost });
        }
        return this.postAutoVoucher({
            bizKey: "SRET:" + sr.id, date: sr.return_date, source: "应收账款",
            source_no: sr.no, counterparty: cust ? cust.name : "", lines,
            remark: "销货退回/折让 " + sr.no
        });
    },

    /* 采购退回：冲应付（冲减应付时）；库存减少 */
    onPurchaseReturn(pr, po) {
        if (!pr || !po) return null;
        const amt = toCNY(Utils.num(pr.amount), po.currency);
        const sp = DB.get("suppliers", po.supplier_id);
        const lines = [];
        if (pr.offset_payable && amt > 0.004) {
            lines.push({ account: "应付账款", debit: amt, credit: 0 });
            lines.push({ account: "库存商品", debit: 0, credit: amt });
        } else if (pr.type === "退回" && amt > 0.004) {
            // 不冲应付的退货：库存减少先挂待处理财产损溢
            lines.push({ account: "待处理财产损溢", debit: amt, credit: 0 });
            lines.push({ account: "库存商品", debit: 0, credit: amt });
        }
        return this.postAutoVoucher({
            bizKey: "PRET:" + pr.id, date: pr.return_date, source: "应付账款",
            source_no: pr.no, counterparty: sp ? sp.name : "", lines,
            remark: "采购退回/折让 " + pr.no
        });
    },

    /* 库存调整：按库存价值异动调库存商品，对方挂待处理财产损溢 */
    onAdjust(adj) {
        if (!adj) return null;
        const value = (adj.lines || []).reduce((s, l) => {
            const it = DB.get("items", l.item_id);
            return s + Utils.num(l.qty) * itemCostCNY(it);
        }, 0);
        if (Math.abs(value) < 0.005) return null;
        const lines = value > 0 ? [
            { account: "库存商品", debit: value, credit: 0 },
            { account: "待处理财产损溢", debit: 0, credit: value }
        ] : [
            { account: "待处理财产损溢", debit: -value, credit: 0 },
            { account: "库存商品", debit: 0, credit: -value }
        ];
        return this.postAutoVoucher({
            bizKey: "ADJ:" + adj.id, date: (adj.created_at || Utils.now()).slice(0, 10), source: "其他",
            source_no: adj.no, counterparty: "", lines,
            remark: "库存调整 " + adj.no + " " + (adj.type || "")
        });
    },

    /* ---------- 业务资料回填（衔接既有数据） ----------
       扫描全部业务单据，为缺传票的事件补生成；最后做一次期初差额调整，
       使 应收/应付/库存商品 科目余额与业务报表口径一致。可重复执行（幂等）。 */
    backfill(verbose) {
        const result = { shipments: 0, pos: 0, receipts: 0, payments: 0, expenses: 0, srets: 0, prets: 0, adjs: 0, truetup: 0 };
        // 1. 出货单
        DB.list("shipments").forEach(s => {
            const o = DB.get("sales_orders", s.sales_order_id);
            if (o && o.status === "shipped" && this.onShipment(s, o)) result.shipments++;
        });
        // 2. 已进货采购单
        DB.list("purchase_orders").filter(o => o.status === "received").forEach(o => {
            if (this.onPOReceive(o)) result.pos++;
        });
        // 3. 收款（按订单已收金额补一张汇总收款传票）
        DB.list("sales_orders").forEach(o => {
            const recv = Utils.num(o.received_amount);
            if (recv > 0 && o.payment_date) {
                const n = DB.list("vouchers").filter(v => (v.biz_key || "").indexOf("RECV:" + o.id + ":") === 0).length;
                if (n === 0 && this.onReceipt(o, recv, o.payment_date, o.payment_method)) result.receipts++;
            }
        });
        // 4. 付款
        DB.list("purchase_orders").forEach(o => {
            const paid = Utils.num(o.paid_amount);
            if (paid > 0 && o.payment_date) {
                const n = DB.list("vouchers").filter(v => (v.biz_key || "").indexOf("PAY:" + o.id + ":") === 0).length;
                if (n === 0 && this.onPayment(o, paid, o.payment_date, o.payment_method)) result.payments++;
            }
        });
        // 5. 费用（未切传票的）
        DB.list("expenses").filter(e => !e.voucher_no).forEach(e => {
            if (this.onExpense(e)) result.expenses++;
        });
        // 6. 销货退回
        DB.list("sales_returns").forEach(sr => {
            const so = DB.get("sales_orders", sr.sales_order_id);
            if (so && this.onSalesReturn(sr, so)) result.srets++;
        });
        // 7. 采购退回
        DB.list("purchase_returns").forEach(pr => {
            const po = DB.get("purchase_orders", pr.purchase_order_id);
            if (po && this.onPurchaseReturn(pr, po)) result.prets++;
        });
        // 8. 库存调整
        DB.list("inventory_adjusts").forEach(a => {
            if (this.onAdjust(a)) result.adjs++;
        });
        // 9. 期初差额调整（只做一次）：应收/应付/库存商品 科目余额与业务口径对齐
        result.truetup = this._trueUp() ? 1 : 0;
        if (verbose) {
            const total = result.shipments + result.pos + result.receipts + result.payments +
                result.expenses + result.srets + result.prets + result.adjs + result.truetup;
            toast(`业务资料同步传票完成：新增 ${total} 张（出货${result.shipments} 进货${result.pos} 收款${result.receipts} 付款${result.payments} 费用${result.expenses} 销退${result.srets} 采退${result.prets} 库调${result.adjs} 期初调整${result.truetup}）`, "success");
        }
        return result;
    },

    /* 应收账款业务口径（净额，本位币） */
    arNet() {
        const returnMap = {};
        DB.list("sales_returns").filter(r => r.offset_receivable).forEach(r => {
            const so = DB.get("sales_orders", r.sales_order_id);
            returnMap[r.sales_order_id] = (returnMap[r.sales_order_id] || 0) + toCNY(Utils.num(r.total_amount), so ? so.currency : "CNY");
        });
        return DB.list("sales_orders").filter(o => o.status === "shipped").reduce((s, o) =>
            s + Math.max(toCNY(Utils.num(o.invoice_amount), o.currency) - toCNY(Utils.num(o.received_amount), o.currency) - (returnMap[o.id] || 0), 0), 0);
    },
    /* 应付账款业务口径（净额，本位币） */
    apNet() {
        const returnMap = {};
        DB.list("purchase_returns").filter(r => r.offset_payable).forEach(r => {
            const po = DB.get("purchase_orders", r.purchase_order_id);
            returnMap[r.purchase_order_id] = (returnMap[r.purchase_order_id] || 0) + toCNY(Utils.num(r.amount), po ? po.currency : "CNY");
        });
        return DB.list("purchase_orders").filter(o => o.status === "received").reduce((s, o) =>
            s + Math.max(toCNY(Utils.num(o.amount), o.currency) - toCNY(Utils.num(o.paid_amount), o.currency) - (returnMap[o.id] || 0), 0), 0);
    },
    /* 库存价值（本位币，与库存总览一致） */
    stockValueAll() {
        return DB.list("items").reduce((s, it) => s + DB.stockValue(it.id), 0);
    },

    /* 期初差额调整传票：库存商品/应收/应付 与业务口径差异 → 未分配利润 */
    _trueUp() {
        const hasTrueUp = DB.list("vouchers").some(v => (v.biz_key || "").indexOf("OPEN:trueup") === 0 && v.status !== "已作废");
        if (hasTrueUp) return false;
        const arDiff = Utils.round(this.arNet() - this._balanceOf("应收账款"));
        const apDiff = Utils.round(this.apNet() - this._balanceOf("应付账款"));
        const invDiff = Utils.round(this.stockValueAll() - this._balanceOf("库存商品"));
        if (Math.abs(arDiff) < 0.01 && Math.abs(apDiff) < 0.01 && Math.abs(invDiff) < 0.01) return false;
        const lines = [];
        if (Math.abs(arDiff) >= 0.01) {
            if (arDiff > 0) { lines.push({ account: "应收账款", debit: arDiff, credit: 0 }); lines.push({ account: "未分配利润", debit: 0, credit: arDiff }); }
            else { lines.push({ account: "未分配利润", debit: -arDiff, credit: 0 }); lines.push({ account: "应收账款", debit: 0, credit: -arDiff }); }
        }
        if (Math.abs(apDiff) >= 0.01) {
            if (apDiff > 0) { lines.push({ account: "未分配利润", debit: apDiff, credit: 0 }); lines.push({ account: "应付账款", debit: 0, credit: apDiff }); }
            else { lines.push({ account: "应付账款", debit: -apDiff, credit: 0 }); lines.push({ account: "未分配利润", debit: 0, credit: -apDiff }); }
        }
        if (Math.abs(invDiff) >= 0.01) {
            if (invDiff > 0) { lines.push({ account: "库存商品", debit: invDiff, credit: 0 }); lines.push({ account: "未分配利润", debit: 0, credit: invDiff }); }
            else { lines.push({ account: "未分配利润", debit: -invDiff, credit: 0 }); lines.push({ account: "库存商品", debit: 0, credit: -invDiff }); }
        }
        return !!this.postAutoVoucher({
            bizKey: "OPEN:trueup:" + Utils.today(), date: Utils.today(), source: "其他",
            source_no: "", counterparty: "", lines,
            remark: "期初差额调整（衔接既有账款/库存口径）"
        });
    },

    /* ---------- 报表计算（只计已过账、未作废传票） ---------- */
    postedVouchers(from, to) {
        return DB.list("vouchers").filter(v => v.status === "已过账" && (!from || v.date >= from) && (!to || v.date <= to));
    },
    /* 某科目借贷发生额 */
    accountFlow(name, from, to) {
        let debit = 0, credit = 0;
        this.postedVouchers(from, to).forEach(v => (v.lines || []).forEach(l => {
            const std = ACCT_LEGACY_MAP[l.account] || l.account;
            if (std === name) { debit += Utils.num(l.debit); credit += Utils.num(l.credit); }
        }));
        return { debit: Utils.round(debit), credit: Utils.round(credit) };
    },
    /* 某科目余额（截止日期，含期初） */
    _balanceOf(name, asOf) {
        const f = this.accountFlow(name, null, asOf);
        return Utils.round(f.debit - f.credit); // 正=借余，负=贷余
    },
    /* 全科目汇总（用于试算表/资产负债表） */
    allAccountBalances(asOf) {
        const map = {}; // name -> {debit, credit}
        this.postedVouchers(null, asOf).forEach(v => (v.lines || []).forEach(l => {
            const std = ACCT_LEGACY_MAP[l.account] || l.account;
            if (!map[std]) map[std] = { debit: 0, credit: 0 };
            map[std].debit += Utils.num(l.debit);
            map[std].credit += Utils.num(l.credit);
        }));
        Object.keys(map).forEach(k => { map[k].debit = Utils.round(map[k].debit); map[k].credit = Utils.round(map[k].credit); });
        return map;
    }
};

/* ============================================================
   科目下拉选项（供传票/费用表单使用）
   - 从 chart_accounts 动态读取，按 科目类别 分组展示
   - types: 可选类别过滤数组，如 ["资产","负债"]；不传=全部
   - selected 值经 legacy 映射后匹配标准科目名
   - 若 selected 是旧科目名（不在科目表），追加为额外选项保留显示
   ============================================================ */
function chartAccountOptions(selected, types) {
    const sel = selected ? (ACCT_LEGACY_MAP[selected] || selected) : "";
    let list = DB.list("chart_accounts");
    if (types && types.length) list = list.filter(a => types.indexOf(a.type) >= 0);
    const groups = {};
    list.forEach(a => {
        if (!groups[a.type]) groups[a.type] = [];
        groups[a.type].push(a);
    });
    const typeOrder = ["资产", "负债", "权益", "损益", "未分类"];
    let html = `<option value="">请选择科目</option>`;
    typeOrder.filter(t => groups[t] && groups[t].length).forEach(t => {
        html += `<optgroup label="${h(t)}">`;
        groups[t].forEach(a => {
            html += `<option value="${h(a.name)}"${a.name === sel ? " selected" : ""}>${h(a.code)} ${h(a.name)}</option>`;
        });
        html += `</optgroup>`;
    });
    // 旧科目名兜底：selected 经映射后仍不在科目表时追加显示，避免编辑既有单据时选项丢失
    if (selected && !list.some(a => a.name === sel)) {
        html += `<option value="${h(selected)}" selected>${h(selected)}（未入科目表）</option>`;
    }
    return html;
}
