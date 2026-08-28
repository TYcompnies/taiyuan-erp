/* ============================================================
   云端同步（sync.js）
   - 跨设备 / 跨网络 IP 共用同一份 ERP 数据（LWW 快照同步）
   - 双供应商：textdb.online（零设定同步码） / GitHub Contents API（PAT）
   - 传输格式：JSON → deflate 压缩 →（可选 AES-GCM 加密）→ base64
     标记：TY0: 明文 JSON ／ TY1: 压缩+base64 ／ TYE1: 加密(TY0/TY1)
   - 自动上传：DB.flush() 防抖 3 秒触发（仅 autoPush 开启时）
   - 自动下载：render() 后首拉 + 每 12 秒轮询 + 切回窗口/标签即时拉取（仅 autoPull 开启时）
   - 同浏览器多标签页：通过 storage 事件即时同步，无需轮询
   - 下载覆盖本地前自动备份（localStorage，保留最近 5 份），确保原有资料不丢失
   ============================================================ */

const CloudSync = {
    CFG_KEY: "taiyuan_sync_cfg_v1",
    STATUS_KEY: "taiyuan_sync_status_v1",
    BACKUP_KEY: "taiyuan_erp_backups_v1",
    DEVICE_KEY: "taiyuan_device_id_v1",
    MANUAL_KEY: "taiyuan_sync_manual_v1", // 用户手动保存过同步配置（自动修复逻辑不再干预）
    MAX_TEXTDB_BYTES: 28000,   // textdb URL 安全上限（编码后字符数）
    BACKUP_KEEP: 5,
    PULL_INTERVAL: 12000,
    FETCH_TIMEOUT: 15000,      // 弱网/跨网络下 fetch 超时（毫秒）：快速失败并转入备用通道，避免同步卡死

    // 内置默认同步配置：任何设备/浏览器/网域首次打开时自动启用，
    // 无需手动输入同步码或口令即可跨设备自动同步（可随时在云端同步页修改并保存覆盖）。
    // 采用 textdb 同步码（无账号权限，安全）；数据 AES-256-GCM 加密存储。
    DEFAULT_SYNC_CFG: {
        provider: "textdb",
        code: "382d3aa9-de38-4803-90be-ed24eff373b5",
        pass: "c663bf4076dc622b4f8fd1e2",
        autoPush: true,
        autoPull: true
    },

    cfg: null,
    status: null,
    _pushTimer: null,
    _pullTimer: null,
    _busy: false,      // 上传/下载执行中
    _applying: false,  // 正在应用远端数据（禁止回推）
    _started: false,
    _pendingPush: false,  // 本地有未上传的改动（重要：自动下载遇到它时先推本地，防止手机删除被云端旧数据覆盖还原）
    _lastAutoErr: "",  // 自动同步失败去重（同一错误只 toast 一次，变化或恢复后重置）

    /* ---------- 配置 ---------- */
    defaults() {
        return {
            provider: "textdb",       // textdb | github
            code: "",                 // textdb 同步码
            ghToken: "",              // GitHub PAT
            ghRepo: "TYcompnies/taiyuan-erp",
            ghPath: "erp-sync.json",
            pass: "",                 // 加密口令（可选）
            autoPush: true,
            autoPull: true
        };
    },
    loadCfg() {
        if (this.cfg) return this.cfg;
        let c = this.defaults();
        try {
            const raw = localStorage.getItem(this.CFG_KEY);
            if (raw) c = Object.assign(c, JSON.parse(raw));
        } catch (e) { }
        this.cfg = c;
        return c;
    },
    saveCfg(cfg) {
        this.cfg = Object.assign(this.loadCfg(), cfg);
        localStorage.setItem(this.CFG_KEY, JSON.stringify(this.cfg));
        return this.cfg;
    },
    isConfigured() {
        const c = this.loadCfg();
        if (c.provider === "textdb") return !!c.code;
        if (c.provider === "github") return !!c.ghToken && !!c.ghRepo;
        return false;
    },
    // 旧版 GitHub 同步配置（系统自身的旧默认数据源 erp-sync.json）自动迁移到统一 textdb 数据源，
    // 防止多台设备配置分裂（一台用 GitHub、一台用 textdb 导致数据不联动）。
    // 保留已填的 GitHub 令牌用于「双写备份」（push 时同步写到 GitHub，保持备用源最新）。
    migrateLegacyCfg() {
        if (!this.DEFAULT_SYNC_CFG) return false;
        // 用户在云端同步页手动保存过 GitHub 配置（有意选择）→ 不自动迁移，尊重用户选择
        if (localStorage.getItem("taiyuan_sync_gh_choice")) return false;
        const c = this.loadCfg();
        const isLegacy = c.provider === "github" && c.ghRepo === "TYcompnies/taiyuan-erp" && c.ghPath === "erp-sync.json";
        if (!isLegacy) return false;
        const keep = c.ghToken ? { ghToken: c.ghToken } : {};
        this.saveCfg(Object.assign({}, this.DEFAULT_SYNC_CFG, keep));
        this.setStatus({ lastAction: "已自动切换旧版同步配置到统一数据源（textdb）", lastError: "" });
        if (typeof toast === "function") toast("🔄 检测到旧版同步配置，已自动切换到统一数据源", "success");
        return true;
    },
    deviceId() {
        let d = localStorage.getItem(this.DEVICE_KEY);
        if (!d) {
            d = "D" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            localStorage.setItem(this.DEVICE_KEY, d);
        }
        return d;
    },

    /* ---------- 状态 ---------- */
    loadStatus() {
        if (this.status) return this.status;
        let s = { lastPushAt: "", lastPullAt: "", lastPushSize: 0, lastPullSize: 0, lastError: "", lastAction: "", remoteRev: 0 };
        try {
            const raw = localStorage.getItem(this.STATUS_KEY);
            if (raw) s = Object.assign(s, JSON.parse(raw));
        } catch (e) { }
        this.status = s;
        return s;
    },
    setStatus(patch) {
        const s = Object.assign(this.loadStatus(), patch);
        this.status = s;
        try { localStorage.setItem(this.STATUS_KEY, JSON.stringify(s)); } catch (e) { }
    },

    /* ---------- 编解码 ---------- */
    _b64(bytes) {
        let bin = "";
        bytes = new Uint8Array(bytes);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
    },
    _unb64(str) {
        const bin = atob(str.replace(/\s+/g, ""));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    },
    async _compress(text) {
        if (typeof CompressionStream !== "undefined") {
            try {
                const cs = new CompressionStream("deflate");
                const stream = new Blob([text]).stream().pipeThrough(cs);
                const buf = new Uint8Array(await new Response(stream).arrayBuffer());
                return "TY1:" + this._b64(buf);
            } catch (e) { /* 压缩失败回退明文 */ }
        }
        return "TY0:" + text;
    },
    async _decompress(marked) {
        if (marked.indexOf("TY1:") === 0) {
            const raw = this._unb64(marked.slice(4));
            const ds = new DecompressionStream("deflate");
            const stream = new Blob([raw]).stream().pipeThrough(ds);
            return await new Response(stream).text();
        }
        if (marked.indexOf("TY0:") === 0) return marked.slice(4);
        throw new Error("云端数据格式无法识别");
    },
    async _deriveKey(pass, salt) {
        const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
        return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    },
    async _encrypt(marked) {
        const pass = this.loadCfg().pass;
        if (!pass) return marked;
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await this._deriveKey(pass, salt);
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(marked)));
        const out = new Uint8Array(16 + 12 + ct.length);
        out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
        return "TYE1:" + this._b64(out);
    },
    async _decrypt(enc) {
        if (enc.indexOf("TYE1:") !== 0) return enc; // 未加密数据
        const pass = this.loadCfg().pass;
        if (!pass) throw new Error("云端数据已加密，请先填写加密口令");
        const raw = this._unb64(enc.slice(5));
        const salt = raw.slice(0, 16), iv = raw.slice(16, 28), ct = raw.slice(28);
        const key = await this._deriveKey(pass, salt);
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
        return new TextDecoder().decode(pt);
    },

    /* ---------- 快照 ---------- */
    buildSnapshot() {
        const payload = JSON.parse(JSON.stringify(DB._mem));
        const rev = Date.now();
        payload.__rev = rev;
        payload.__device = this.deviceId();
        return { v: 1, rev, device: this.deviceId(), updated_at: new Date().toISOString(), payload };
    },
    /* ---------- 内容指纹对账（hash） ---------- */
    // 稳定序列化：键排序、排除同步元数据（__rev/__device/__hash）
    _canon(v) {
        if (v === null || typeof v !== "object") return typeof v + ":" + String(v);
        if (Array.isArray(v)) return "[" + v.map(x => this._canon(x)).join(",") + "]";
        const ks = Object.keys(v).filter(k => k !== "__rev" && k !== "__device" && k !== "__hash").sort();
        return "{" + ks.map(k => JSON.stringify(k) + ":" + this._canon(v[k])).join(",") + "}";
    },
    // 64 位内容指纹（FNV-1a 双 lane）。
    // 为什么只比 rev 不够：rev 只在「推送成功后」推进——若本地的改动从未上传成功
    // （旧版本静默丢推 / 网络持续失败后 App 重开，内存标志 _pendingPush 归零），
    // 本地 __rev 与云端完全相同但内容不同 = 本地存在「孤儿改动」，对旧逻辑永远不可见，
    // 永远推不上云，其他设备也就永远看不到。故必须以内容指纹对账。
    payloadHash(data) {
        const s = this._canon(data);
        let h1 = 0x811c9dc5, h2 = 0x01000193;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
            h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
        }
        return ("0000000" + h1.toString(16)).slice(-8) + ("0000000" + h2.toString(16)).slice(-8);
    },
    parseSnapshot(marked) {
        // marked: 传输编码串（未解密）→ 解密 → 解压 → JSON
        return this._decrypt(marked).then(txt => this._decompress(txt)).then(json => {
            const snap = JSON.parse(json);
            if (!snap || !snap.payload || !snap.rev) throw new Error("云端数据结构不完整");
            return snap;
        });
    },

    /* ---------- 供应商：textdb ---------- */
    // fetch 超时封装：不同网络（如手机 4G）下访问云端可能长时间无响应，
    // 15 秒超时快速失败 → 转入备用通道 / 触发重试，保证同步不会卡死
    _fetchT(url, opts) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.FETCH_TIMEOUT);
        return fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}))
            .finally(() => clearTimeout(t));
    },
    async textdbPush(enc) {
        const c = this.loadCfg();
        const url = "https://api.textdb.online/update/?key=" + encodeURIComponent(c.code) + "&value=" + encodeURIComponent(enc);
        const r = await this._fetchT(url, { method: "POST" });
        if (!r.ok) throw new Error("textdb 写入失败 (HTTP " + r.status + ")");
        return true;
    },
    async textdbPull() {
        const c = this.loadCfg();
        const r = await this._fetchT("https://textdb.online/" + encodeURIComponent(c.code), { cache: "no-store" });
        if (!r.ok) throw new Error("textdb 读取失败 (HTTP " + r.status + ")");
        const t = (await r.text()).trim();
        if (!t || t === "null" || t.indexOf("key not found") >= 0) return null;
        return t;
    },

    /* ---------- 供应商：GitHub Contents API ---------- */
    _ghHeaders() {
        return {
            "Authorization": "token " + this.loadCfg().ghToken,
            "Accept": "application/vnd.github.v3+json"
        };
    },
    async ghGet() {
        const c = this.loadCfg();
        const r = await this._fetchT("https://api.github.com/repos/" + c.ghRepo + "/contents/" + encodeURIComponent(c.ghPath) + "?t=" + Date.now(), { headers: this._ghHeaders(), cache: "no-store" });
        if (r.status === 404) return null;
        if (r.status === 401) throw new Error("GitHub Token 无效或已过期");
        if (!r.ok) throw new Error("GitHub 读取失败 (HTTP " + r.status + ")");
        const j = await r.json();
        if (!j.content) return null;
        const b64 = (j.content || "").replace(/\s+/g, "");
        // GitHub 对 >1KB 文件返回 base64；小文件可能为空 content + url 指向 blob
        if (!b64) throw new Error("GitHub 文件内容为空，请重试");
        return this._unb64ToText(b64);
    },
    _unb64ToText(b64) {
        return new TextDecoder().decode(this._unb64(b64));
    },
    _textToB64(text) {
        return this._b64(new TextEncoder().encode(text));
    },
    async ghPut(enc, sha) {
        const c = this.loadCfg();
        const body = { message: "ERP cloud sync " + new Date().toISOString(), content: this._textToB64(enc) };
        if (sha) body.sha = sha;
        const r = await this._fetchT("https://api.github.com/repos/" + c.ghRepo + "/contents/" + encodeURIComponent(c.ghPath), {
            method: "PUT", headers: this._ghHeaders(), body: JSON.stringify(body)
        });
        if (!r.ok) {
            const t = await r.text();
            throw new Error("GitHub 写入失败 (HTTP " + r.status + ")：" + t.slice(0, 120));
        }
        return true;
    },
    async githubPush(enc) {
        // 先取 sha（文件已存在时），409 冲突时按 LWW 判定
        let sha = null;
        try {
            const c = this.loadCfg();
            const r = await this._fetchT("https://api.github.com/repos/" + c.ghRepo + "/contents/" + encodeURIComponent(c.ghPath) + "?t=" + Date.now(), { headers: this._ghHeaders(), cache: "no-store" });
            if (r.ok) { const j = await r.json(); sha = j.sha || null; }
        } catch (e) { /* 忽略，按新建处理 */ }
        try {
            return await this.ghPut(enc, sha);
        } catch (e) {
            if (String(e.message).indexOf("409") >= 0) {
                // 冲突：重新取 sha 再试一次（LWW 由 rev 保证：能推送方通常是较新数据）
                let sha2 = null;
                try {
                    const c = this.loadCfg();
                    const r2 = await this._fetchT("https://api.github.com/repos/" + c.ghRepo + "/contents/" + encodeURIComponent(c.ghPath) + "?t=" + Date.now(), { headers: this._ghHeaders(), cache: "no-store" });
                    if (r2.ok) { const j2 = await r2.json(); sha2 = j2.sha || null; }
                } catch (e2) { }
                return await this.ghPut(enc, sha2);
            }
            throw e;
        }
    },
    async githubPull() {
        return await this.ghGet();
    },

    /* ---------- 上传 / 下载 ---------- */
    // 自动同步失败可见化（防重：同一错误只 toast 一次，错误变化或恢复后重置）
    _notifyAutoError(kind, msg) {
        const key = kind + ":" + msg;
        if (this._lastAutoErr === key) return;
        this._lastAutoErr = key;
        if (typeof toast === "function") toast("⚠ 自动" + kind + "失败：" + msg + "（详见 系统设置 / 云端同步）", "error");
    },
    async push(manual) {
        const c = this.loadCfg();
        if (!this.isConfigured()) {
            if (manual) toast("请先填写并保存同步设置", "error");
            return false;
        }
        if (this._busy) { if (manual) toast("同步操作进行中，请稍候", "error"); return false; }
        this._busy = true;
        try {
            // 本地有改动要推送时按「后推赢」LWW 直接推（推送成功后才推进本地版本号，
            // 推送失败不推进——保证后续 pull 仍能正确判断云端是否更新、不至永久失明）。
            // 旧版「推送前先比较云端、云端较新就改为下载覆盖本地」的拦截会吃掉用户未推送的改动
            // （手机本地 rev 是首拉值，电脑一旦推过云端就比它新，手机每次 push 都被拦截改为下载，
            // 手机操作永远推不上云），故移除该拦截，恢复无条件推送。
            const localHash = this.payloadHash(DB._mem); // 推送前内容指纹（成功后记录，用于下次对账判脏）
            const snap = this.buildSnapshot();
            const marked = await this._compress(JSON.stringify(snap));
            const enc = await this._encrypt(marked);
            if (c.provider === "textdb" && enc.length > this.MAX_TEXTDB_BYTES) {
                throw new Error("数据量超出 textdb 上限（约 " + Math.round(this.MAX_TEXTDB_BYTES / 1000) + "KB 编码后），请改用 GitHub 同步");
            }
            if (c.provider === "textdb") {
                // 主通道：textdb（跨网域统一空间，免设定即用）
                try {
                    await this.textdbPush(enc);
                    // 双写备份：本机若填过 GitHub 令牌，同时写入仓库保持备用源最新（备用源写失败不影响主源）
                    if (c.ghToken) {
                        try { await this.githubPush(enc); } catch (e) { /* 备用源写入失败忽略 */ }
                    }
                } catch (e1) {
                    // 【跨网络/跨网域容错】主通道 textdb 不可达（如手机 4G 访问不了 textdb.online）：
                    // 配置了 GitHub 令牌时自动切换 GitHub 备用通道写入，保证改动仍能推上云，
                    // 其他设备（pull 双源对账）照样能拉到最新数据。
                    if (c.ghToken) {
                        try {
                            await this.githubPush(enc);
                            this.setStatus({ lastAction: "push(主通道 textdb 不可达，已用 GitHub 备用通道上传)" });
                        } catch (e2) {
                            throw new Error("上传失败（textdb：" + e1.message + "；GitHub：" + e2.message + "）");
                        }
                    } else {
                        // 无备用通道：明确提示配置 GitHub 令牌可增强跨网络可靠性
                        throw new Error("textdb 不可达且未配置 GitHub 备用令牌：" + e1.message + "（可在下方填写 GitHub 访问令牌作备用通道）");
                    }
                }
            } else {
                // 主通道：GitHub
                try {
                    await this.githubPush(enc);
                } catch (e1) {
                    // GitHub 不可达 → textdb 备用通道（有同步码时）
                    if (c.code) {
                        try {
                            await this.textdbPush(enc);
                            this.setStatus({ lastAction: "push(GitHub 不可达，已用 textdb 备用通道上传)" });
                        } catch (e2) {
                            throw new Error("上传失败（GitHub：" + e1.message + "；textdb：" + e2.message + "）");
                        }
                    } else {
                        throw e1;
                    }
                }
            }
            // 推送成功后才推进本地版本号（失败时不推进，下次 pull 仍能按 LWW 正确判断）
            DB._mem.__rev = snap.rev;
            DB._mem.__device = snap.device;
            DB._mem.__hash = localHash; // 记录「已上传」的内容指纹：后续本地任何改动都会使指纹失配 → 判脏
            try { localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(DB._mem)); } catch (e) { }
            this._pendingPush = false; // 本地改动已成功上传
            this.setStatus({ lastPushAt: new Date().toISOString(), lastPushSize: enc.length, lastError: "", lastAction: "push", remoteRev: snap.rev });
            this._lastAutoErr = ""; // 恢复后重置失败提示
            if (manual) toast("已上传到云端（" + (enc.length / 1024).toFixed(1) + " KB）", "success");
            return true;
        } catch (e) {
            this.setStatus({ lastError: "上传失败：" + e.message });
            if (manual) toast("上传失败：" + e.message, "error");
            else this._notifyAutoError("上传", e.message);
            return false;
        } finally {
            this._busy = false;
        }
    },
    async pullRemote() {
        const c = this.loadCfg();
        if (c.provider === "textdb") {
            // 【双源对账】同时读 textdb 主源 + GitHub 备用备份，取版本较新者。
            // 为什么必须双源：手机在 4G 等网络下 textdb 不可达时，push 会自动切 GitHub 备用通道写入——
            // 此时 textdb 里仍是旧快照、GitHub 里才是最新。若电脑只读 textdb，就会误判「已是最新」永远看不到更新。
            // 双源对账后：任何一台设备无论从哪个通道写入，其他设备都能读到最新版本（跨网络/跨网域彻底联动）。
            let fromTextdb = null, fromGh = null, textdbErr = null;
            try { fromTextdb = await this.textdbPull(); } catch (e) { textdbErr = e; }
            try { fromGh = await this.ghRawPull(); } catch (e) { /* GitHub 不可达不影响主源 */ }
            if (fromTextdb !== null && fromGh !== null && fromGh !== "") {
                try {
                    const s1 = await this.parseSnapshot(fromTextdb);
                    const s2 = await this.parseSnapshot(fromGh);
                    if (s2.rev > s1.rev) {
                        this.setStatus({ lastAction: "已从双源取较新版本（GitHub 备用源更新，主源 textdb 滞后）" });
                        return fromGh;
                    }
                    if (s1.rev > s2.rev) return fromTextdb;
                    // rev 相同：主源优先（内容对账交给 pull() 的指纹判断）
                    return fromTextdb;
                } catch (e) { return fromTextdb; }
            }
            if (fromTextdb !== null) return fromTextdb;
            if (fromGh !== null && fromGh !== "") {
                this.setStatus({ lastAction: (!textdbErr) ? "textdb 暂无数据，已从 GitHub 备用源读取" : "textdb 暂不可达，已从备用源(GitHub)读取" });
                return fromGh;
            }
            if (textdbErr) throw textdbErr;
            return null;
        }
        return await this.githubPull();
    },
    // 从 GitHub 公开仓库读取同步文件（无需令牌）：raw.githubusercontent 主 + jsDelivr CDN 备
    async ghRawPull() {
        const c = this.loadCfg();
        const branch = "main";
        const urls = [
            "https://raw.githubusercontent.com/" + c.ghRepo + "/" + branch + "/" + encodeURIComponent(c.ghPath),
            "https://cdn.jsdelivr.net/gh/" + c.ghRepo + "@" + branch + "/" + encodeURIComponent(c.ghPath)
        ];
        for (const u of urls) {
            try {
                const r = await this._fetchT(u + "?t=" + Date.now(), { cache: "no-store" });
                if (r.ok) {
                    const t = (await r.text()).trim();
                    if (t && t !== "null") return t;
                }
            } catch (e) { /* 尝试下一个源 */ }
        }
        return null;
    },
    /* 仅取远端快照（不覆盖本地），用于测试连接 / 比较版本 */
    async peek() {
        const enc = await this.pullRemote();
        if (enc === null || enc === "") return null;
        return await this.parseSnapshot(enc);
    },
    async pull(manual) {
        const c = this.loadCfg();
        if (!this.isConfigured()) {
            if (manual) toast("请先填写并保存同步设置", "error");
            return false;
        }
        // 【关键保护】本地还有未上传的改动时（如手机端刚删除客户/供应商，上传尚未成功）：
        // 绝不能直接用云端旧数据覆盖本地——否则手机端的删除会被「还原」、电脑端永远看不到删除。
        // 做法：先推本地（后推赢 LWW，本地 rev 变成最新），推送失败则拒绝覆盖并提示，保护本地改动。
        // 注意：必须在本函数置 _busy 之前执行——否则 push() 会被自身的 _busy 守卫拒绝（死锁）。
        if (this._pendingPush && !manual) {
            if (this._busy) return false; // 已有同步在执行，等下一轮轮询再处理
            const pushed = await this.push(false);
            if (!pushed) {
                this._notifyAutoError("上传", "本地有未同步改动且上传失败，已暂停自动下载以防数据被覆盖（详见 系统设置 / 云端同步）");
                return false;
            }
            return true; // 本地最新状态已上传云端，其他设备将自动拉到，无需再下载
        }
        if (this._busy) { if (manual) toast("同步操作进行中，请稍候", "error"); return false; }
        this._busy = true;
        try {
            const enc = await this.pullRemote();
            if (enc === null || enc === "") {
                // 云端暂无数据：保留 lastAction（如「已自动启用/已切换数据源」提示），仅更新拉取时间
                this.setStatus({ lastPullAt: new Date().toISOString(), lastError: "" });
                if (manual) toast("云端暂无数据（首次使用请先上传）", "error");
                return false;
            }
            const snap = await this.parseSnapshot(enc);
            this.setStatus({ lastPullAt: new Date().toISOString(), lastPullSize: enc.length, remoteRev: snap.rev });
            const localRev = Utils.num(DB._mem.__rev) || 0;
            // 【内容指纹对账】核心修复：rev 相同但内容不同 = 本地有从未上传成功的孤儿改动
            // （典型：旧版本静默丢推 / 推送持续失败后 App 重开，_pendingPush 归零）。
            // 旧逻辑只比 rev 会误判「本地已是最新」，孤儿改动永远推不上云、其他设备永远看不到。
            const localHash = this.payloadHash(DB._mem);
            const remoteHash = this.payloadHash(snap.payload);
            const syncedHash = String(DB._mem.__hash || ""); // 上次成功推送/下载云端时记录的内容指纹
            if (remoteHash === localHash) {
                // 内容完全一致 → 真正的最新（rev 有差也只是重复推送），顺带对齐 rev 与指纹
                this._lastAutoErr = "";
                if (snap.rev > localRev || !syncedHash) {
                    DB._mem.__rev = snap.rev;
                    DB._mem.__device = snap.device;
                    DB._mem.__hash = localHash;
                    try { localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(DB._mem)); } catch (e) { }
                }
                if (manual) toast("本地已是最新版本，无需下载", "success");
                return true;
            }
            // 本地脏判定：① 上次同步后本地有改动（指纹不匹配）；② rev 相同但内容不同（孤儿改动铁证）
            const localDirty = (syncedHash && localHash !== syncedHash) || snap.rev === localRev;
            if (localDirty) {
                if (manual) {
                    // 手动下载：明确警告本地有未上传改动，下载会丢失这些改动
                    confirmModal(`⚠ 本地有未上传的改动（新增/删除/修改），下载云端会丢失这些改动（会先自动备份）。云端版本：${h(snap.updated_at)} 由 ${h(snap.device)} 更新。仍要下载吗？`, async () => {
                        await this.applyRemote(snap);
                        this._lastAutoErr = "";
                        toast("云端数据已下载并应用（本地已备份）", "success");
                    }, "下载云端数据");
                    return true;
                }
                // 自动：后推赢 LWW——先推本地孤儿改动（含手机删除），推失败绝不覆盖本地
                this._busy = false; // 释放忙碌锁再调 push，否则被 push 自身 _busy 守卫拒绝（死锁）
                const pushed = await this.push(false);
                if (!pushed) {
                    this._notifyAutoError("上传", "检测到本地有未上传的改动但上传失败，已暂停下载以防数据被覆盖（详见 系统设置 / 云端同步）");
                    return false;
                }
                toast("🔄 检测到本机有未上传的改动，已自动上传云端", "success");
                return true; // 本地最新状态已在云端，其他设备将自动拉到
            }
            if (snap.rev <= localRev) {
                this._lastAutoErr = ""; // 本地已是最新，恢复后重置失败提示
                if (manual) toast("本地已是最新版本，无需下载", "success");
                return true;
            }
            if (manual) {
                // 手动下载：确认后备份并覆盖
                confirmModal(`云端版本较新（${h(snap.updated_at)} 由 ${h(snap.device)} 更新）。下载将覆盖本地数据，系统会先自动备份当前数据，可随时恢复。确定继续吗？`, async () => {
                    await this.applyRemote(snap);
                    this._lastAutoErr = "";
                    toast("云端数据已下载并应用（本地已备份）", "success");
                }, "下载云端数据");
            } else {
                // 自动下载：远端较新即自动应用（覆盖前已自动备份，原有资料不丢失）
                // 不同设备/不同网络打开时自动获取最新数据，无需手动点「下载」
                const wasFirstSync = localRev === 0;
                await this.applyRemote(snap);
                this._lastAutoErr = ""; // 自动拉取成功，重置失败提示
                if (wasFirstSync) toast("🔄 已自动从云端下载最新数据（首次同步，本地旧数据已备份）", "success");
                else toast("🔄 已自动同步云端最新数据", "success");
            }
            return true;
        } catch (e) {
            this.setStatus({ lastError: "下载失败：" + e.message });
            if (manual) toast("下载失败：" + e.message, "error");
            else this._notifyAutoError("下载", e.message);
            return false;
        } finally {
            this._busy = false;
        }
    },
    _businessEmpty() {
        const cols = ["items", "sales_orders", "shipments", "purchase_orders", "inventory_adjusts", "sales_returns", "purchase_returns"];
        return cols.every(c => !(DB._mem[c] || []).length);
    },
    async applyRemote(snap) {
        // 1. 备份当前本地数据（保有原有资料）
        this.backupLocal("下载云端覆盖前自动备份");
        // 2. 应用远端数据（保留本地 __rev/__device 对齐远端版本）
        const payload = JSON.parse(JSON.stringify(snap.payload));
        payload.__rev = snap.rev;
        payload.__device = snap.device;
        payload.__hash = this.payloadHash(payload); // 自洽指纹：刚套用的云端内容即「已同步」状态
        DB._mem = payload;
        this._pendingPush = false; // 已整包覆盖本地，不再有「未上传的本地改动」
        this._applying = true;
        try {
            localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(DB._mem));
            // 会计模块移除迁移（幂等）：云端旧快照可能仍带 chart_accounts/vouchers/expenses，
            // 套用后立即清空并 flush 调度推送，让清空随同步扩散到所有设备；
            // 若推送失败，下轮 pull 的内容指纹对账会按「孤儿改动」后推赢补推。
            try { if (typeof DB !== "undefined" && DB.purgeAccounting) DB.purgeAccounting(); } catch (e) { /* 迁移失败不影响套用 */ }
            render();
        } finally {
            this._applying = false;
        }
    },

    /* ---------- 本地备份 ---------- */
    backups() {
        try {
            const raw = localStorage.getItem(this.BACKUP_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) { return []; }
    },
    backupLocal(reason) {
        try {
            const data = JSON.stringify(DB._mem);
            const arr = this.backups();
            arr.unshift({ ts: new Date().toISOString(), reason: reason || "手动备份", size: data.length, data });
            while (arr.length > this.BACKUP_KEEP) arr.pop();
            try { localStorage.setItem(this.BACKUP_KEY, JSON.stringify(arr)); }
            catch (e) {
                // 空间不足：丢弃最旧的一份再试
                while (arr.length > 1) { arr.pop(); try { localStorage.setItem(this.BACKUP_KEY, JSON.stringify(arr)); break; } catch (e2) { } }
            }
            return true;
        } catch (e) { return false; }
    },
    restoreBackup(i) {
        const arr = this.backups();
        const bk = arr[i];
        if (!bk) { toast("找不到该备份", "error"); return; }
        confirmModal(`确定要恢复 ${h(bk.ts)} 的备份吗？当前数据会先自动备份，然后被备份内容覆盖。`, () => {
            this.backupLocal("恢复备份前自动备份");
            try {
                DB._mem = JSON.parse(bk.data);
                localStorage.setItem("taiyuan_erp_data_v1", JSON.stringify(DB._mem));
                toast("备份已恢复", "success");
                render();
            } catch (e) {
                toast("恢复失败：" + e.message, "error");
            }
        }, "恢复备份");
    },
    clearBackups() {
        confirmModal("确定要清空全部本地备份吗？此操作不可恢复。", () => {
            localStorage.removeItem(this.BACKUP_KEY);
            toast("备份已清空", "success");
            render();
        }, "清空备份");
    },

    /* ---------- 自动调度 ---------- */
    schedulePush() {
        const c = this.loadCfg();
        if (!c.autoPush || !this.isConfigured()) return;
        // 记住有未推送的本地改动：即使当前正在执行其他同步也绝不丢弃，稍后自动重试补推
        this._pendingPush = true;
        if (this._pushTimer) clearTimeout(this._pushTimer);
        this._pushTimer = setTimeout(() => { this._runPush().catch(() => { }); }, 3000);
    },
    // 推送执行器：忙/应用远端数据时稍后重试；推送失败（网络抖动等）15 秒后自动重试，直至成功
    // （保证手机端任意保存/删除操作最终一定上传到云端，电脑端才能同步看到）
    async _runPush() {
        if (this._busy || this._applying) {
            this._pushTimer = setTimeout(() => { this._runPush().catch(() => { }); }, 3000);
            return;
        }
        const ok = await this.push(false);
        if (!ok && this._pendingPush) {
            // 上传失败且仍有未推送改动：保持待推状态，稍后自动重试（网络恢复后自愈）
            this._pushTimer = setTimeout(() => { this._runPush().catch(() => { }); }, 15000);
        }
    },
    schedulePull() {
        // 即时拉取（窗口聚焦/切回标签时触发），防抖 2 秒避免频繁请求
        if (this._busy || this._applying) return;
        const c = this.loadCfg();
        if (!c.autoPull || !this.isConfigured()) return;
        if (this._focusTimer) clearTimeout(this._focusTimer);
        this._focusTimer = setTimeout(() => {
            this.pull(false).catch(() => { });
        }, 2000);
    },
    _bindActivity() {
        if (this._activityBound) return;
        this._activityBound = true;
        // 切回标签页 / 窗口聚焦 → 立即检查云端（跨设备实时同步的关键）
        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) this.schedulePull();
        });
        window.addEventListener("focus", () => this.schedulePull());
        window.addEventListener("pageshow", (e) => { if (e.persisted) this.schedulePull(); });
        // 同一浏览器多标签页：另一标签写入数据时即时同步本页（无需等轮询）
        window.addEventListener("storage", (e) => {
            if (this._applying) return;
            if (e.key === "taiyuan_erp_data_v1" && e.newValue) {
                try {
                    DB._mem = JSON.parse(e.newValue);
                    this._pendingPush = false; // 已采纳其他标签页的数据，由该标签负责上传
                    if (typeof render === "function") render();
                } catch (err) { /* 数据格式异常忽略 */ }
            }
        });
    },
    startAuto() {
        // 开发/测试环境（localhost/127.0.0.1）默认不自动应用内置配置，避免测试数据与云端互相污染；
        // 访问地址带 ?sync=1 时强制启用（供自动化测试在本地验证自动配置逻辑）
        const isDevHost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
        const forceSync = /[?&]sync=1/.test(location.search);
        // 旧版 GitHub 同步配置自动迁移到统一 textdb 数据源（幂等；同样遵守 localhost 豁免）
        if (!this._legacyChecked) {
            this._legacyChecked = true;
            if (!isDevHost || forceSync) this.migrateLegacyCfg();
        }
        if (this._started) return;
        // 从未保存过任何同步配置，或保存过但配置不可用（旧版本残留空同步码 / 网域切换后配置分裂），
        // 且用户未手动自定义 → 自动启用内置默认配置，确保不同设备/浏览器/网域都指向同一数据空间
        if ((!isDevHost || forceSync) && this.DEFAULT_SYNC_CFG) {
            const c0 = this.loadCfg();
            const neverSaved = !localStorage.getItem(this.CFG_KEY);
            const manual = localStorage.getItem(this.MANUAL_KEY) || localStorage.getItem("taiyuan_sync_gh_choice");
            const broken = (c0.provider === "textdb" && !c0.code) || (c0.provider === "github" && (!c0.ghToken || !c0.ghRepo));
            if (neverSaved || (!manual && broken)) {
                const keep = c0.ghToken ? { ghToken: c0.ghToken } : {};
                this.saveCfg(Object.assign({}, this.DEFAULT_SYNC_CFG, keep));
                this.setStatus({ lastAction: neverSaved ? "已自动启用内置云同步配置" : "检测到同步配置不可用，已自动恢复统一数据空间（textdb）", lastError: "" });
                if (typeof toast === "function") toast(neverSaved ? "🔄 已自动启用跨设备云同步" : "🔄 检测到同步配置不可用，已自动恢复统一数据空间", "success");
            }
        }
        const c = this.loadCfg();
        if (!c.autoPull || !this.isConfigured()) return;
        this._started = true;
        this._bindActivity();
        // 登录后首拉（跨设备/跨 IP 打开时自动获取最新数据）
        setTimeout(() => { this.pull(false).catch(() => { }); }, 1500);
        this._pullTimer = setInterval(() => {
            if (document.hidden) return;          // 标签隐藏时跳过，可见时由 visibilitychange 补拉
            this.pull(false).catch(() => { });
        }, this.PULL_INTERVAL);
    }
};

/* ============================================================
   云端同步页面（系统设置 / 云端同步）
   ============================================================ */
Pages.cloudSync = function () {
    const c = CloudSync.loadCfg();
    const st = CloudSync.loadStatus();
    const bks = CloudSync.backups();

    const fmtTime = (iso) => iso ? iso.replace("T", " ").slice(0, 19) : "-";
    const providerBadge = c.provider === "textdb" ? '<span class="badge teal">textdb.online</span>' : '<span class="badge purple">GitHub</span>';
    // 同步空间标识：所有设备/网域必须指向同一空间才会联动（仅显示同步码首尾，便于核对且不泄露完整码）
    const spaceTag = c.provider === "textdb"
        ? "textdb · " + h(c.code.slice(0, 8)) + "…" + h(c.code.slice(-4))
        : "GitHub · " + h(c.ghRepo);
    const chTag = c.provider === "textdb"
        ? `textdb（主）${c.ghToken ? "＋GitHub（备）" : "（未配置备用令牌，弱网建议填 GitHub PAT）"}`
        : `GitHub（主）${c.code ? "＋textdb（备）" : ""}`;

    const backupRows = bks.map((b, i) => `<tr>
        <td>${h(fmtTime(b.ts))}</td>
        <td>${h(b.reason || "-")}</td>
        <td class="num">${(Utils.num(b.size) / 1024).toFixed(1)} KB</td>
        <td class="action-col"><button class="link-btn" onclick="Pages.syncRestoreBackup(${i})">恢复</button></td>
    </tr>`).join("");

    const content = `
    <div class="page-head">
        <div><h1>云端同步</h1><p>跨设备、跨网络共用同一份 ERP 数据：本机变更自动上传云端，其他设备打开或切回窗口时自动下载最新版本；覆盖前自动备份，原有资料不丢失。</p></div>
        <div class="head-actions">
            <button class="btn" onclick="Pages.syncTest()">🔗 测试连接</button>
            <button class="btn" onclick="Pages.syncPushNow()">☁️ 立即上传</button>
            <button class="btn primary" onclick="Pages.syncPullNow()">⬇️ 立即下载</button>
        </div>
    </div>

    ${c.autoPush && c.autoPull && CloudSync.isConfigured() ? `<div style="margin-bottom:16px;padding:12px 16px;border-radius:10px;background:#ecfdf5;color:#047857;font-size:13.5px;display:flex;align-items:center;gap:8px"><span style="font-size:18px">✅</span><div><b>实时自动同步已开启</b>：数据变动 3 秒后自动上传；每 12 秒检查云端、切回窗口/标签时即时拉取；同浏览器多标签页即时同步。<br><span style="opacity:.8">不同设备、不同浏览器、不同网域/不同网络 IP 打开本系统即自动同步，无需再手动点上传或下载。检测到旧版同步配置时自动切换到统一数据源，避免设备间数据分裂；textdb 主源不可达时自动从 GitHub 备用源读取。</span></div></div>` : (!CloudSync.isConfigured() ? `<div style="margin-bottom:16px;padding:12px 16px;border-radius:10px;background:#fff7e6;color:#92600a;font-size:13.5px">💡 填写下方同步码（或 GitHub 令牌）并保存后，将自动开启实时跨设备同步。</div>` : "")}

    <div style="margin-bottom:16px;padding:12px 16px;border-radius:10px;background:#eff6ff;color:#1e40af;font-size:13.5px;display:flex;align-items:center;gap:8px"><span style="font-size:18px">📡</span><div><b>同步空间：${spaceTag}</b> &nbsp;·&nbsp; 通道：${chTag}<br><span style="opacity:.85">所有设备/网域必须指向同一「同步空间」才会联动。手机与电脑不同步时，请先核对两端此处空间标识是否一致。textdb 主通道不可达时自动切换 GitHub 备用通道；读取时双源对账取较新版本。</span></div></div>

    <div class="kpi-grid">
        <div class="kpi-card"><span>同步状态</span><strong style="font-size:16px">${c.pass ? "已加密" : "未加密"} ${providerBadge}</strong></div>
        <div class="kpi-card"><span>上次上传</span><strong>${h(fmtTime(st.lastPushAt))}</strong></div>
        <div class="kpi-card"><span>上次下载</span><strong>${h(fmtTime(st.lastPullAt))}</strong></div>
        <div class="kpi-card"><span>本地版本号</span><strong>${Utils.num(DB._mem.__rev) || "未同步"}</strong></div>
        <div class="kpi-card"><span>云端版本</span><strong id="cloudRevKpi" style="color:var(--muted)">读取中…</strong></div>
    </div>
    ${st.lastError ? `<div style="margin-bottom:16px;padding:10px 14px;border-radius:10px;background:var(--danger-soft);color:var(--danger);font-size:13.5px">⚠ ${h(st.lastError)}</div>` : ""}
    ${!c.pass ? `<div style="margin-bottom:16px;padding:10px 14px;border-radius:10px;background:#fff7e6;color:#92600a;font-size:13.5px">💡 建议设置加密口令：同步码对应的云端地址是公开的，加密后他人即使取得地址也无法读取数据。</div>` : ""}

    <form class="form-panel" novalidate onsubmit="Pages.syncSaveCfg(event)">
        <section class="form-section">
            <div class="form-section-title"><h3>同步设置</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>同步供应商<b>*</b></label>
                    <select name="provider">
                        <option value="textdb"${c.provider === "textdb" ? " selected" : ""}>textdb.online（同步码，免设定）</option>
                        <option value="github"${c.provider === "github" ? " selected" : ""}>GitHub（PAT，适合大数据量）</option>
                    </select></div>
                <div class="form-item"><label>自动上传</label>
                    <select name="autoPush"><option value="1"${c.autoPush ? " selected" : ""}>开启（数据变动 3 秒后自动上传）</option><option value="0"${!c.autoPush ? " selected" : ""}>关闭（仅手动上传）</option></select></div>
                <div class="form-item"><label>自动下载</label>
                    <select name="autoPull"><option value="1"${c.autoPull ? " selected" : ""}>开启（每 12 秒 + 切回窗口即时同步）</option><option value="0"${!c.autoPull ? " selected" : ""}>关闭（仅手动下载）</option></select></div>
            </div>
        </section>

        <section class="form-section">
            <div class="form-section-title"><h3>textdb.online（推荐，跨 IP 即开即用）</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>同步码</label>
                    <div style="display:flex;gap:8px">
                        <input name="code" value="${h(c.code)}" placeholder="多台设备填同一个同步码即可共用数据" style="flex:1">
                        <button type="button" class="btn" onclick="Pages.syncGenCode()">生成随机码</button>
                    </div></div>
            </div>
            <p class="muted">同一同步码在任意网络 IP 打开本系统并登录后，会自动下载该同步码的最新数据；数据量超出限制（约 100KB 原始数据）时请改用 GitHub。若 textdb 暂时无法访问，系统会自动从 GitHub 备用源读取（需仓库内存在 erp-sync.json 备份）。</p>
        </section>

        <section class="form-section">
            <div class="form-section-title"><h3>GitHub（可选，适合数据量较大时）</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>访问令牌 PAT</label>
                    <input type="password" name="ghToken" value="${h(c.ghToken)}" placeholder="ghp_...（需要 repo 内容读写权限）"></div>
                <div class="form-item"><label>仓库（owner/repo）</label>
                    <input name="ghRepo" value="${h(c.ghRepo)}" placeholder="TYcompnies/taiyuan-erp"></div>
                <div class="form-item"><label>同步文件路径</label>
                    <input name="ghPath" value="${h(c.ghPath)}" placeholder="erp-sync.json"></div>
            </div>
            <p class="muted">仓库为公开时务必配合加密口令使用；私有仓库同样建议加密。</p>
        </section>

        <section class="form-section">
            <div class="form-section-title"><h3>加密（建议开启）</h3></div>
            <div class="form-grid section-grid">
                <div class="form-item"><label>加密口令</label>
                    <input type="password" name="pass" value="${h(c.pass)}" placeholder="留空 = 不加密；所有设备需一致"></div>
            </div>
            <p class="muted">采用 AES-256-GCM 加密，数据在云端始终为密文；忘记口令将无法解密云端数据（本地数据不受影响）。</p>
        </section>

        <div class="form-actions sticky-actions">
            <button class="btn primary" type="submit">保存设置</button>
            <button class="btn" type="reset">重置</button>
        </div>
    </form>

    <section class="form-section" style="margin-top:24px">
        <div class="form-section-title"><h3>本地备份（最近 ${CloudSync.BACKUP_KEEP} 份）</h3></div>
        <div class="table-wrap">
            <table class="table">
                <thead><tr><th>备份时间</th><th>原因</th><th class="num">大小</th><th class="action-col">操作</th></tr></thead>
                <tbody>${backupRows || `<tr><td colspan="4"><div class="empty-state"><div class="big">💾</div>暂无备份（下载覆盖/恢复操作前会自动产生）</div></td></tr>`}</tbody>
            </table>
        </div>
        ${bks.length ? `<button class="btn" style="margin-top:12px" onclick="Pages.syncClearBackups()">清空备份</button>` : ""}
    </section>`;

    renderShell("cloud_sync", content, "首页 / 系统设置 / 云端同步");

    // 异步填充「云端版本」KPI：peek 一次云端，与本地版本号对比，一眼看出哪一环断了同步
    // （云端 > 本地 = 有新数据未下载；云端 < 本地 = 本机未上传；相等 = 已同步）
    setTimeout(() => {
        const el = document.getElementById("cloudRevKpi");
        if (!el) return; // 用户已切走其他页面
        CloudSync.peek().then(snap => {
            if (!el) return;
            if (!snap) { el.textContent = "云端无数据"; el.style.color = "var(--warn, #b45309)"; return; }
            el.textContent = fmtTime(snap.updated_at);
            el.title = "rev " + snap.rev + " · 设备 " + snap.device;
            const localRev = Utils.num(DB._mem.__rev) || 0;
            if (snap.rev > localRev) el.style.color = "var(--primary, #2563eb)";     // 云端更新：有待下载
            else if (snap.rev < localRev) el.style.color = "var(--warn, #b45309)";   // 本机更新：未上传
            else el.style.color = "var(--muted, #6b7280)";                            // 已同步
        }).catch(e => {
            if (!el) return;
            el.textContent = "读取失败";
            el.title = e.message;
            el.style.color = "var(--danger, #dc2626)";
        });
    }, 50);
};

Pages.syncSaveCfg = function (e) {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    fd.forEach((v, k) => { data[k] = v; });
    const cfg = CloudSync.saveCfg({
        provider: data.provider,
        code: (data.code || "").trim(),
        ghToken: (data.ghToken || "").trim(),
        ghRepo: (data.ghRepo || "").trim() || "TYcompnies/taiyuan-erp",
        ghPath: (data.ghPath || "").trim() || "erp-sync.json",
        pass: data.pass || "",
        autoPush: data.autoPush === "1",
        autoPull: data.autoPull === "1"
    });
    if (cfg.provider === "textdb" && !cfg.code) { toast("请填写同步码", "error"); return; }
    if (cfg.provider === "github" && !cfg.ghToken) { toast("请填写 GitHub 访问令牌", "error"); return; }
    // 记录用户主动选择（手动保存 GitHub 配置后，自动迁移逻辑将不再干预）
    if (cfg.provider === "github") localStorage.setItem("taiyuan_sync_gh_choice", "1");
    else localStorage.removeItem("taiyuan_sync_gh_choice");
    localStorage.setItem(CloudSync.MANUAL_KEY, "1"); // 手动保存过：配置自愈逻辑不再自动覆盖
    CloudSync._started = false; // 重新评估自动同步
    CloudSync.startAuto();
    toast("同步设置已保存", "success");
    render();
};

Pages.syncGenCode = function () {
    const code = "ty" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const inp = document.querySelector('input[name="code"]');
    if (inp) inp.value = code;
    toast("已生成同步码，保存后请在其他设备填写同一同步码", "success");
};

Pages.syncPushNow = async function () {
    toast("正在上传到云端…", "success");
    await CloudSync.push(true);
    render();
};

Pages.syncPullNow = async function () {
    toast("正在从云端下载…", "success");
    await CloudSync.pull(true);
    if (!CloudSync._busy) render();
};

Pages.syncTest = async function () {
    const c = CloudSync.loadCfg();
    if (!CloudSync.isConfigured()) { toast("请先填写并保存同步设置", "error"); return; }
    toast("正在测试连接…", "success");
    try {
        const snap = await CloudSync.peek();
        if (!snap) {
            toast("连接成功，云端暂无数据（点击「立即上传」上传本机数据）", "success");
        } else {
            toast(`连接成功：云端版本 ${snap.rev}（${snap.updated_at.replace("T", " ").slice(0, 19)} 由 ${snap.device} 更新）`, "success");
        }
        CloudSync.setStatus({ lastError: "" });
    } catch (e) {
        toast("连接失败：" + e.message, "error");
    }
    render();
};

Pages.syncRestoreBackup = function (i) { CloudSync.restoreBackup(i); };
Pages.syncClearBackups = function () { CloudSync.clearBackups(); };
