// 财务会计（外挂复式记账系统嵌入页）自动化测试
// 覆盖：财务会计独立组（不跟进销存账款） 菜单/路由/iframe 嵌入、URL 正确、
//       权限种子（admin/管理者/会计有、业务/仓管无）、migrateBookkeeping 迁移
//       （只给已有 finance.ap 的角色补权，幂等）、无权限拒绝
// 运行前提：本地服务器 http://127.0.0.1:8904（cd erp-clone && node serve.js 8904 .）
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8904';
const BK_URL = 'https://95d7803cee5b42be927e0212e9f5ebb1.app.workbuddy.link/';
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
  const menuLabels = () => page.evaluate(() => Array.from(document.querySelectorAll('.sidebar a')).map(a => a.textContent.trim()));

  // ========== 1. 登录 ==========
  console.log('\n[1] 登录管理员');
  await login('admin', 'admin123');
  check((await bodyText()).includes('仪表板'), '管理员登录成功');

  // ========== 2. 菜单独立组（财务会计 不跟 进销存账款 同组） ==========
  console.log('\n[2] 财务会计独立菜单组');
  const menu = await page.evaluate(() => Array.from(document.querySelectorAll('.sidebar a')).map(a => ({ t: a.textContent.trim(), href: a.getAttribute('href') })));
  const bkItem = menu.find(m => m.href === '#/bookkeeping');
  check(!!bkItem && bkItem.t.includes('财务会计'), '侧边栏菜单含「财务会计」(#/bookkeeping)');
  const groups = await page.evaluate(() => Array.from(document.querySelectorAll('.menu-group')).map(grp => {
    const sp = grp.querySelector('.menu-main span');
    return {
      title: sp ? sp.textContent.trim() : '',
      links: Array.from(grp.querySelectorAll('.menu-link')).map(a => a.textContent.trim())
    };
  }));
  const bkGrp = groups.find(g => g.title === '财务会计');
  check(!!bkGrp && bkGrp.links.includes('财务会计'), '「财务会计」独立成组（组标题=菜单名）');
  const finGrp = groups.find(g => g.title === '进销存账款');
  check(!!finGrp && finGrp.links.includes('进销存应收账款') && finGrp.links.includes('进销存应付账款'), '「进销存账款」组保留应收账款/应付账款');
  check(!!finGrp && !finGrp.links.includes('财务会计'), '「财务会计」不跟在「进销存账款」组内');

  // ========== 3. 页面渲染（iframe 嵌入） ==========
  console.log('\n[3] 外贸记账嵌入页');
  await gotoHash('#/bookkeeping');
  const frame = await page.evaluate(() => {
    const f = document.getElementById('bookkeepingFrame');
    const a = document.querySelector('.bk-toolbar-actions a');
    return {
      exists: !!f,
      src: f ? f.getAttribute('src') : null,
      title: f ? f.getAttribute('title') : null,
      toolbar: document.querySelector('.bk-toolbar-info strong') ? document.querySelector('.bk-toolbar-info strong').textContent : '',
      crumb: document.querySelector('.breadcrumb') ? document.querySelector('.breadcrumb').textContent : '',
      openHref: a ? a.getAttribute('href') : null,
      openTarget: a ? a.getAttribute('target') : null
    };
  });
  check(frame.exists, 'iframe#bookkeepingFrame 存在');
  check(frame.src === BK_URL, `iframe src 为外挂记账网址（实际 ${frame.src}）`);
  check(frame.title && frame.title.includes('外贸记账'), 'iframe title 正确');
  check(frame.toolbar.includes('财务会计'), '工具栏标题「财务会计（41大叔外贸记账系统）」');
  check(frame.crumb.includes('财务会计') && !frame.crumb.includes('进销存账款'), '面包屑「首页 / 财务会计」（不含进销存账款组）');
  check(frame.openHref === BK_URL && frame.openTarget === '_blank', '「新窗口打开」按钮指向同一网址且 target=_blank');

  // ========== 4. 会计角色可见（r5 种子含 finance.bookkeeping） ==========
  console.log('\n[4] 会计角色可见');
  const perms = await db(() => ({
    r5: DB.list('roles').find(r => r.id === 'r5'),
    r3: DB.list('roles').find(r => r.id === 'r3')
  }));
  check((perms.r5.permissions || []).includes('finance.bookkeeping'), '种子 r5 会计含 finance.bookkeeping');
  check(!(perms.r3.permissions || []).includes('finance.bookkeeping'), '种子 r3 业务不含 finance.bookkeeping');
  await page.evaluate(() => DB.clearSession());   // 登出 admin
  await login('accounting', '123456');
  const hrefAcc = await menuHrefs();
  check(hrefAcc.includes('#/bookkeeping'), '会计账号菜单含外贸记账');
  await gotoHash('#/bookkeeping');
  check((await bodyText()).includes('41大叔外贸记账系统'), '会计可打开外贸记账嵌入页');

  // ========== 5. 业务角色无权限（不可见 + 直连被拒） ==========
  console.log('\n[5] 业务角色拒绝');
  await page.evaluate(() => DB.clearSession());
  await login('sales', '123456');
  const hrefSal = await menuHrefs();
  check(!hrefSal.includes('#/bookkeeping'), '业务账号菜单不含外贸记账');
  await gotoHash('#/bookkeeping');
  const deniedToast = await toastText();
  check(deniedToast.includes('没有访问该页面的权限'), `无权限访问被拒（toast：${deniedToast.slice(0, 40)}）`);
  check((await bodyText()).includes('仪表板'), '被拒后回到仪表板');

  // ========== 6. 权限迁移（旧数据平滑升级：只给已有 finance.ap 角色补） ==========
  console.log('\n[6] 权限迁移');
  await page.evaluate(() => DB.clearSession());
  await login('admin', 'admin123');
  const prep = await db(() => {
    // r2 管理者：移除 finance.bookkeeping（模拟旧数据，r2 有 finance.ap → 迁移应补回）
    const r2 = DB.list('roles').find(r => r.id === 'r2');
    r2.permissions = (r2.permissions || []).filter(p => p !== 'finance.bookkeeping');
    DB.update('roles', r2.id, { permissions: r2.permissions });
    // 自定义角色：只有 finance.ar（无 finance.ap）→ 迁移不应补
    const plain = DB.insert('roles', { id: 'r_bk_plain', name: '仅应收', description: '', permissions: ['dashboard.view', 'finance.ar'], created_at: new Date().toISOString() });
    return { r2Removed: !r2.permissions.includes('finance.bookkeeping'), plainId: plain.id };
  });
  check(prep.r2Removed, '已从 r2 移除 finance.bookkeeping（模拟旧数据）');
  check(!!prep.plainId, '创建仅 finance.ar 的自定义角色 r_bk_plain');
  await page.reload({ waitUntil: 'networkidle' });
  await killSync();
  await page.waitForTimeout(800);
  const mig = await db(() => ({
    r2: (DB.list('roles').find(r => r.id === 'r2').permissions || []).includes('finance.bookkeeping'),
    plain: (DB.list('roles').find(r => r.id === 'r_bk_plain').permissions || []).includes('finance.bookkeeping'),
    r1: (DB.list('roles').find(r => r.id === 'r1').permissions || []).includes('finance.bookkeeping')
  }));
  check(mig.r2, 'reload 后 r2（有 finance.ap）被 migrateBookkeeping 补回');
  check(!mig.plain, '仅 finance.ar 的角色不被补权（防账本数据扩散）');
  check(mig.r1, 'r1 系统管理员含 finance.bookkeeping');
  const hrefAfter = await menuHrefs();
  check(hrefAfter.includes('#/bookkeeping'), '迁移后菜单重新出现外贸记账');

  // ========== 7. 清理测试角色 ==========
  await db(() => { DB.remove('roles', 'r_bk_plain'); });

  // ========== 汇总 ==========
  console.log('\n==================================');
  console.log(`== 外贸记账嵌入测试: ${pass} 通过, ${fail} 失败 ==`);
  if (failures.length) { console.error('失败项:', failures.join(' | ')); }
  if (errors.length) { console.error('页面错误:', errors.slice(0, 5).join(' | ')); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
