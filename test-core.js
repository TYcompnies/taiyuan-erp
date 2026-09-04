// ERP 复刻系统核心逻辑测试脚本（Node 模拟浏览器环境）
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- 模拟浏览器环境 ----
const storage = {};
global.localStorage = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; },
  clear: () => { for (const k in storage) delete storage[k]; }
};
global.window = { localStorage: global.localStorage };

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log('  PASS:', msg);
  } else {
    failures++;
    console.error('  FAIL:', msg);
  }
}

// ---- 加载 store.js ----
const storeCode = fs.readFileSync(path.join(__dirname, 'js', 'store.js'), 'utf8');
const ctx = vm.createContext({ localStorage: global.localStorage, window: global.window, console });
vm.runInContext(storeCode + '\n;globalThis.__export = { COMPANY, DB, Utils, PERMISSIONS };', ctx);
const { COMPANY, DB, Utils, PERMISSIONS } = ctx.__export;

const coll = (n) => DB.list(n);

console.log('=== 1. 公司信息 ===');
assert(COMPANY.name === '义乌市钛沅商贸有限公司', '公司名称为 义乌市钛沅商贸有限公司');
assert(COMPANY.short === '钛沅商贸', '公司简称正确');
assert(!/[繁體字]/.test(COMPANY.name), '公司名称为简体');

console.log('=== 2. 种子数据（业务数据为空，基础资料保留） ===');
assert(coll('warehouses').length === 2, '2 个仓库');
assert(coll('currencies').length === 6, '6 种币别');
assert(coll('categories').length === 6, '6 个分类');
assert(coll('units').length === 8, '8 个单位');
assert(coll('shipping_methods').length === 10, '10 种物流方式');
assert(coll('payment_terms').length === 7, '7 种付款条件（含平台已付款）');
assert(coll('items').length === 0, '商品主档为空');
assert(coll('customers').length === 6, '6 个客户');
assert(coll('suppliers').length === 4, '4 个供应商');
assert(coll('sales_orders').length === 0, '销货订单为空');
assert(coll('shipments').length === 0, '出货单为空');
assert(coll('purchase_orders').length === 0, '采购单为空');
assert(coll('inventory_adjusts').length === 0, '样品领料为空');
assert(coll('sales_returns').length === 0, '销货退回为空');
assert(coll('purchase_returns').length === 0, '采购退回为空');
assert(coll('expenses').length === 0, '费用支出为空');
assert(coll('vouchers').length === 0, '传票为空');
assert(coll('roles').length === 5, '5 个角色');
assert(coll('users').length === 4, '4 个用户');

console.log('=== 3. 库存映射 ===');
const sm = DB.stockMap();
assert(Object.keys(sm).length === 0, '库存映射为空（库存清零）');
assert(DB.stockOf('wh1', 'it_605900001') === 0, '查询空库存返回 0');

console.log('=== 4. 单号生成 ===');
const n1 = Utils.nextNo('SO', '2026-08-19', coll('sales_orders'));
assert(/^SO20260819\d{3}$/.test(n1), '销货单号格式正确: ' + n1);
const n2 = Utils.nextNo('PO', '2026-08-19', coll('purchase_orders'));
assert(/^PO20260819\d{3}$/.test(n2), '采购单号格式正确: ' + n2);

console.log('=== 5. 会话与登录 ===');
DB.setSession({ user_id: 'u_adm' });
assert(DB.session().user_id === 'u_adm', '会话保存/读取正常');
assert(DB.currentUser() && DB.currentUser().id === 'u_adm', '当前用户解析正常');

console.log('=== 6. 权限 ===');
assert(PERMISSIONS.length >= 25, '权限代码 >= 25 个（会计模块移除后 29）');
const adminRole = coll('roles').find(r => r.id === 'r1');
assert(adminRole && adminRole.permissions.length === PERMISSIONS.length, '系统管理员角色拥有全部权限');

console.log('=== 7. 财务计算（临时插入测试单据） ===');
const tItem = DB.insert('items', { id: 'it_test1', code: 'TEST001', name: '测试商品', sales_unit: '个', price: 100, cost: 50 });
const tSO = DB.insert('sales_orders', { id: 'so_test1', no: 'SO20260819001', invoice_amount: 200, lines: [{ item_id: 'it_test1', qty: 2, unit_price: 100, amount: 200 }] });
assert(Utils.num(tSO.invoice_amount) > 0, '销货订单金额 > 0');
const sum = tSO.lines.reduce((t, l) => t + Utils.num(l.qty) * Utils.num(l.unit_price), 0);
assert(Math.abs(sum - Utils.num(tSO.invoice_amount)) < 0.01, '订单明细合计 = 发票金额');
DB.remove('items', tItem.id);
DB.remove('sales_orders', tSO.id);

console.log('=== 7b. 清空业务数据（clearBusiness） ===');
DB.insert('sales_orders', { id: 'so_x', no: 'SO20260819002', invoice_amount: 99, lines: [] });
DB.insert('items', { id: 'it_x', code: 'X001', name: '临时商品' });
DB.clearBusiness();
assert(coll('sales_orders').length === 0, '清空后销货订单为 0');
assert(coll('items').length === 0, '清空后商品主档为 0');
assert(coll('customers').length === 6, '清空后客户保留');
assert(coll('warehouses').length === 2, '清空后仓库保留');
assert(Object.keys(DB.stockMap()).length === 0, '清空后库存为 0');

console.log('=== 8. 关联名称查找 ===');
assert(DB.itemName(tItem.id) === '-', '不存在的商品返回占位符');
assert(DB.customerName(coll('customers')[0].id) !== '-', '客户名称查找正常');
assert(DB.supplierName(coll('suppliers')[0].id) !== '-', '供应商名称查找正常');
assert(DB.warehouseName('wh1') === '主仓库', '仓库名称查找正常');

console.log('=== 9. CRUD 操作 ===');
const rec = DB.insert('items', { code: 'TEST001', name: '测试商品' });
assert(!!DB.get('items', rec.id), '插入后可按 ID 查询');
DB.update('items', rec.id, { name: '测试商品改' });
assert(DB.get('items', rec.id).name === '测试商品改', '更新生效');
DB.remove('items', rec.id);
assert(!DB.get('items', rec.id), '删除生效');

console.log('=== 10. 全库文字检查（繁体残留扫描） ===');
// 真正的繁简异形字（有简体对应字的繁体字），排除繁简同形字
const tradChars = '銷貨採購帳庫單據傳應營費損憑證幣別類倉戶員碼權維護異動過沖讓贈稅額計刪儲匯還遷調滯週轉淨進開報價訂審認確備';
let tradFound = [];
const allText = JSON.stringify(DB._mem);
for (const ch of tradChars) {
  if (allText.includes(ch)) tradFound.push(ch);
}
assert(tradFound.length === 0, '种子数据无繁体字' + (tradFound.length ? ' 发现: ' + tradFound.join('') : ''));

console.log('=== 11. 币别含人民币 ===');
const cny = coll('currencies').find(c => c.code === 'CNY');
assert(!!cny, '存在 CNY 人民币币别');
assert(cny.symbol === '¥', '人民币符号为 ¥');
assert(cny.is_base === true, 'CNY 为本位币');

console.log('\n' + (failures === 0 ? '== 全部测试通过 ==' : `== ${failures} 个测试失败 ==`));
process.exit(failures === 0 ? 0 : 1);
