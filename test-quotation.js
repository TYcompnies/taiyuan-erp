// 估价试算（外挂跨境成本利润试算嵌入页）自动化测试
// 覆盖：进销存账款/财务→商品估价试算 菜单/路由/iframe 嵌入、URL 正确、
//       权限种子（管理员/管理者/业务/会计有、仓管无）、migrateQuote 迁移
//       （判据 sales.view 或 finance.bookkeeping，幂等）、无权限拒绝
// 运行前提：本地服务器 http://127.0.0.1:8904（cd erp-clone && node serve.js 8904 .）
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8904';
const QT_URL = 'https://93590751eb284b0587ff220bbcdec39b.app.workbuddy.link/';
let pass = 0, fail = 0, failures = [];
const errors = [];

function check(cond, msg) {
  if (cond) { pass++; console.log('  PASS:', msg); }
  else { fail++; failures.push(msg); console.error('  FAIL:', msg); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', err => errors.push('[pageerror] ' + err.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });

  // 线上跑时彻底断开云同步（防测试种子/迁移数据推送生产云，本地 8904 localhost 自动豁免）
  async function killSync() {
    await page.evaluate(() => {
      try {
        localStorage.removeItem('taiyuan_sync_cfg_v1');
        if (typeof CloudSync !== 'undefined') {
          CloudSync.DEFAULT_SYNC_CFG = null;
          CloudSync._started = true;
          if (CloudSync._pullTimer) clearInterval(CloudSync._pullTimer);
        }
      } catch (e) { }
    });
  }
  async function login(user, pwd) {
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    await killSync();
    await page.waitForTimeout(500);
    const inputs = page.locator('#loginForm input');
    const n = await inputs.count();
    for (let i = 0; i < n; i++) {
      const ph = await inputs.nth(i).getAttribute('placeholder') || '';
      if (/账号|用户/i.test(ph)) await inputs.nth(i).fill(user);
      if (/密码/i.test(ph)) await inputs.nth(i).fill(pwd);
    }
    await page.locator('#loginForm button[type=submit]').click();
    await page.waitForTimeout(1000);
  }
  async function gotoHash(hash) {
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForTimeout(700);
  }
  const db = (fn, arg) => page.evaluate(({ src, a }) => { const f = eval('(' + src + ')'); return f(a); }, { src: fn.toString(), a: arg });
  async function bodyText() { return await page.textContent('body'); }
  async function toastText() {
    const t = await page.locator('.toast').allTextContents().catch(() => []);
    return t.join(' | ');
  }
  const menuHrefs = () => page.evaluate(() => Array.from(document.querySelectorAll('.sidebar a')).map(a => a.getAttribute('href')));

  // ========== 1. 登录 ==========
  console.log('\n[1] 登录管理员');
  await login('admin', 'admin123');
  check((await bodyText()).includes('仪表板'), '管理员登录成功');

  // ========== 2. 菜单含商品估价试算 ==========
  console.log('\n[2] 进销存账款/财务菜单');
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('.sidebar a')).map(a => ({ t: a.textContent.trim(), href: a.getAttribute('href') })));
  const qtItem = menu.find(m => m.href === '#/quote');
  check(!!qtItem && qtItem.t.includes('商品估价试算'), '侧边栏菜单含「商品估价试算」(#/quote)');
  const inGroup = await page.evaluate(() => {
    const g = Array.from(document.querySelectorAll('.menu-group')).find(grp => {
      const sp = grp.querySelector('.menu-main span');
      return sp && sp.textContent.trim() === '进销存账款/财务';
    });
    return g ? Array.from(g.querySelectorAll('.menu-link')).map(a => a.textContent.trim()) : [];
  });
  check(inGroup.includes('商品估价试算'), '「商品估价试算」位于进销存账款/财务菜单组');
  check(inGroup.indexOf('财务会记') < inGroup.indexOf('商品估价试算'), '「商品估价试算」排在「财务会记」之后');

  // ========== 3. 页面渲染（iframe 嵌入） ==========
  console.log('\n[3] 商品估价试算嵌入页');
  await gotoHash('#/quote');
  const frame = await page.evaluate(() => {
    const f = document.getElementById('quotationFrame');
    const a = document.querySelector('.bk-toolbar-actions a');
    return {
      exists: !!f,
      src: f ? f.getAttribute('src') : null,
      title: f ? f.getAttribute('title') : null,
      toolbar: document.querySelector('.bk-toolbar-info strong') ? document.querySelector('.bk-toolbar-info strong').textContent : '',
      desc: document.querySelector('.bk-toolbar-info span') ? document.querySelector('.bk-toolbar-info span').textContent : '',
      crumb: document.querySelector('.breadcrumb') ? document.querySelector('.breadcrumb').textContent : '',
      openHref: a ? a.getAttribute('href') : null,
      openTarget: a ? a.getAttribute('target') : null
    };
  });
  check(frame.exists, 'iframe#quotationFrame 存在');
  check(frame.src === QT_URL, `iframe src 为商品估价试算网址（实际 ${frame.src}）`);
  check(frame.title && frame.title.includes('商品估价试算'), 'iframe title 正确');
  check(frame.toolbar.includes('商品估价试算'), '工具栏标题含「商品估价试算」');
  check(frame.desc.includes('EXW/FOB'), '工具栏说明含 EXW/FOB 出口估价描述');
  check(frame.crumb.includes('商品估价试算') && frame.crumb.includes('进销存账款/财务'), '面包屑「首页 / 进销存账款/财务 / 商品估价试算」');
  check(frame.openHref === QT_URL && frame.openTarget === '_blank', '「新窗口打开」按钮指向同一网址且 target=_blank');

  // ========== 4. 角色种子权限 ==========
  console.log('\n[4] 角色种子权限');
  const perms = await db(() => {
    const pick = id => DB.list('roles').find(r => r.id === id).permissions || [];
    return { r1: pick('r1'), r3: pick('r3'), r4: pick('r4'), r5: pick('r5') };
  });
  check(perms.r1.includes('finance.quote'), '种子 r1 系统管理员含 finance.quote');
  check(perms.r3.includes('finance.quote'), '种子 r3 业务含 finance.quote（报价用）');
  check(!perms.r4.includes('finance.quote'), '种子 r4 仓管不含 finance.quote');
  check(perms.r5.includes('finance.quote'), '种子 r5 会计含 finance.quote');

  // ========== 5. 会计/业务可见可打开 ==========
  console.log('\n[5] 会计与业务可见');
  await page.evaluate(() => DB.clearSession());
  await login('accounting', '123456');
  check((await menuHrefs()).includes('#/quote'), '会计账号菜单含商品估价试算');
  await gotoHash('#/quote');
  check((await bodyText()).includes('估价试算'), '会计可打开商品估价试算嵌入页');
  await page.evaluate(() => DB.clearSession());
  await login('sales', '123456');
  check((await menuHrefs()).includes('#/quote'), '业务账号菜单含商品估价试算');
  await gotoHash('#/quote');
  check((await bodyText()).includes('估价试算'), '业务可打开商品估价试算嵌入页');

  // ========== 6. 仓管无权限（不可见 + 直连被拒） ==========
  console.log('\n[6] 仓管角色拒绝');
  await page.evaluate(() => DB.clearSession());
  await login('warehouse', '123456');
  check(!(await menuHrefs()).includes('#/quote'), '仓管账号菜单不含商品估价试算');
  await gotoHash('#/quote');
  const deniedToast = await toastText();
  check(deniedToast.includes('没有访问该页面的权限'), `无权限访问被拒（toast：${deniedToast.slice(0, 40)}）`);
  check((await bodyText()).includes('仪表板'), '被拒后回到仪表板');

  // ========== 7. 权限迁移（旧数据平滑升级） ==========
  console.log('\n[7] 权限迁移');
  await page.evaluate(() => DB.clearSession());
  await login('admin', 'admin123');
  const prep = await db(() => {
    // r4 仓管：本就没有；再确保移除后迁移不会补（r4 无 sales.view / finance.bookkeeping）
    const r4 = DB.list('roles').find(r => r.id === 'r4');
    r4.permissions = (r4.permissions || []).filter(p => p !== 'finance.quote');
    DB.update('roles', r4.id, { permissions: r4.permissions });
    // r5 会计：移除 finance.quote（模拟旧数据，有 finance.bookkeeping → 迁移应补回）
    const r5 = DB.list('roles').find(r => r.id === 'r5');
    r5.permissions = (r5.permissions || []).filter(p => p !== 'finance.quote');
    DB.update('roles', r5.id, { permissions: r5.permissions });
    // r2 管理者：移除 finance.quote（模拟旧数据，有 sales.create → 迁移应补回）
    const r2 = DB.list('roles').find(r => r.id === 'r2');
    r2.permissions = (r2.permissions || []).filter(p => p !== 'finance.quote');
    DB.update('roles', r2.id, { permissions: r2.permissions });
    // 自定义角色：仅有 finance.ar（无 sales.view/bookkeeping）→ 迁移不应补
    const plain = DB.insert('roles', { id: 'r_qt_plain', name: '仅应收', description: '', permissions: ['dashboard.view', 'finance.ar'], created_at: new Date().toISOString() });
    return { plainId: plain.id };
  });
  check(!!prep.plainId, '创建仅 finance.ar 的自定义角色 r_qt_plain');
  await page.reload({ waitUntil: 'networkidle' });
  await killSync();
  await page.waitForTimeout(800);
  const mig = await db(() => {
    const pick = id => DB.list('roles').find(r => r.id === id).permissions || [];
    return {
      r4: pick('r4').includes('finance.quote'),
      r5: pick('r5').includes('finance.quote'),
      r2: pick('r2').includes('finance.quote'),
      plain: pick('r_qt_plain').includes('finance.quote'),
      r1: pick('r1').includes('finance.quote')
    };
  });
  check(!mig.r4, 'reload 后 r4 仓管仍无 finance.quote（无 sales.view/bookkeeping）');
  check(mig.r5, 'reload 后 r5（有 finance.bookkeeping）被 migrateQuote 补回');
  check(mig.r2, 'reload 后 r2（有 sales.create）被 migrateQuote 补回');
  check(!mig.plain, '仅 finance.ar 的角色不被补权（防无差别扩散）');
  check(mig.r1, 'r1 系统管理员含 finance.quote');
  check((await menuHrefs()).includes('#/quote'), '迁移后管理员菜单出现估价试算');

  // ========== 8. 清理测试角色 ==========
  await db(() => { DB.remove('roles', 'r_qt_plain'); });

  // ========== 汇总 ==========
  console.log('\n==================================');
  console.log(`== 估价试算嵌入测试: ${pass} 通过, ${fail} 失败 ==`);
  if (failures.length) { console.error('失败项:', failures.join(' | ')); }
  if (errors.length) { console.error('页面错误:', errors.slice(0, 5).join(' | ')); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
