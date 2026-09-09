(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const text = value => String(value ?? '');
  const errorText = error => error instanceof Error ? error.message : String(error ?? '操作失败');
  const dateText = value => {
    if (!value) return '';
    try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
    catch { return ''; }
  };
  const byteText = value => {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  };

  function create(api, options = {}) {
    const browser = api.browser;
    const getState = typeof options.getState === 'function' ? options.getState : () => undefined;
    const elements = {
      bookmark: byId('browser-bookmark'),
      library: byId('browser-library'),
      downloads: byId('browser-downloads'),
      external: byId('browser-external'),
      more: byId('browser-more'),
      overflow: byId('browser-overflow'),
      menuFind: byId('browser-menu-find'),
      menuPrint: byId('browser-menu-print'),
      menuScreenshot: byId('browser-menu-screenshot'),
      menuDevTools: byId('browser-menu-devtools'),
      zoomOut: byId('browser-zoom-out'),
      zoomIn: byId('browser-zoom-in'),
      zoomReset: byId('browser-zoom-reset'),
      zoomValue: byId('browser-zoom-value'),
      menuDownloads: byId('browser-menu-downloads'),
      menuLibrary: byId('browser-menu-library'),
      menuClear: byId('browser-menu-clear'),
      menuClose: byId('browser-menu-close'),
      find: byId('browser-find'),
      findInput: byId('browser-find-input'),
      findCount: byId('browser-find-count'),
      findPrevious: byId('browser-find-prev'),
      findNext: byId('browser-find-next'),
      findClose: byId('browser-find-close'),
      downloadDrawer: byId('browser-download-drawer'),
      downloadList: byId('browser-download-list'),
      downloadFolder: byId('browser-download-folder'),
      downloadClear: byId('browser-download-clear'),
      downloadClose: byId('browser-download-close'),
      manager: byId('browser-manager'),
      managerClose: byId('browser-manager-close'),
      managerStatus: byId('browser-manager-status'),
      sources: byId('browser-sources'),
      importNote: byId('browser-import-note'),
      homepageForm: byId('browser-homepage-form'),
      homepages: byId('browser-homepages'),
      homepageOpen: byId('browser-homepage-open'),
      homepageReset: byId('browser-homepage-reset'),
      homepageNote: byId('browser-homepage-note'),
      historyFilter: byId('browser-history-filter'),
      historyCount: byId('browser-history-count'),
      historyList: byId('browser-history-list'),
      historyClear: byId('browser-history-clear'),
      bookmarkCard: byId('browser-bookmark-card'),
      bookmarkCount: byId('browser-bookmark-count'),
      bookmarkList: byId('browser-bookmark-list'),
      bookmarkClear: byId('browser-bookmark-clear'),
      credentialForm: byId('browser-credential-form'),
      credentialOrigin: byId('browser-credential-origin'),
      credentialUsername: byId('browser-credential-username'),
      credentialPassword: byId('browser-credential-password'),
      credentialList: byId('browser-credential-list'),
      autofill: byId('browser-autofill'),
      autofillNote: byId('browser-autofill-note'),
      extensionList: byId('browser-extension-list'),
      runtimeCheck: byId('browser-runtime-check'),
      runtimeInfo: byId('browser-runtime-info'),
      historyEnabled: byId('browser-history-enabled'),
      importRetry: byId('browser-import-retry'),
      extensionsLoad: byId('browser-extensions-load'),
    };

    let librarySnapshot;
    let libraryLoading;
    let findTimer;
    let lastManagerOpen = false;
    let menuTransition = Promise.resolve();
    const pageSnapshot = document.createElement('img');
    pageSnapshot.className = 'browser-page-snapshot';
    pageSnapshot.alt = '';
    pageSnapshot.hidden = true;
    elements.overflow.parentElement.insertBefore(pageSnapshot, elements.overflow);

    const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    function clearMenuSnapshot() {
      pageSnapshot.hidden = true;
      pageSnapshot.removeAttribute('src');
      pageSnapshot.style.removeProperty('top');
      pageSnapshot.style.removeProperty('height');
    }
    async function prepareMenuSnapshot() {
      const snapshot = await browser.prepareMenuSnapshot();
      if (!snapshot || typeof snapshot.pageDataUrl !== 'string' || !snapshot.pageDataUrl.startsWith('data:image/')) return false;
      pageSnapshot.src = snapshot.pageDataUrl;
      pageSnapshot.style.top = `${Math.max(0, Number(snapshot.pageTop) || 0)}px`;
      pageSnapshot.style.height = `${Math.max(0, Number(snapshot.pageHeight) || 0)}px`;
      try { await pageSnapshot.decode(); }
      catch { clearMenuSnapshot(); return false; }
      pageSnapshot.hidden = false;
      await nextPaint();
      await nextPaint();
      return true;
    }

    function setNote(target, message, isError = false) {
      target.textContent = text(message);
      target.dataset.kind = isError ? 'error' : 'status';
    }

    function button(label, action, className = '') {
      const control = document.createElement('button');
      control.type = 'button';
      control.className = `browser-tool ${className}`.trim();
      control.textContent = label;
      control.addEventListener('click', event => {
        event.stopPropagation();
        Promise.resolve(action()).catch(error => setNote(elements.importNote, errorText(error), true));
      });
      return control;
    }

    function row(title, detail, actions = []) {
      const item = document.createElement('div');
      item.className = 'browser-manager-row';
      const copy = document.createElement('div');
      copy.className = 'browser-manager-row-copy';
      const strong = document.createElement('strong');
      strong.textContent = title || '未命名';
      const span = document.createElement('span');
      span.textContent = detail || '';
      copy.append(strong, span);
      const controls = document.createElement('div');
      controls.className = 'browser-manager-row-actions';
      for (const action of actions) controls.append(button(action.label, action.run, action.className));
      item.append(copy, controls);
      return item;
    }

    function replaceList(target, rows, emptyLabel) {
      if (rows.length) target.replaceChildren(...rows);
      else {
        const empty = document.createElement('div');
        empty.className = 'browser-manager-empty';
        empty.textContent = emptyLabel;
        target.replaceChildren(empty);
      }
    }

    async function refreshLibrary(snapshot) {
      if (snapshot) {
        librarySnapshot = snapshot;
        renderLibrary(snapshot);
        return snapshot;
      }
      if (libraryLoading) return libraryLoading;
      libraryLoading = browser.getLibrary().then(value => {
        if (value) {
          librarySnapshot = value;
          renderLibrary(value);
        }
        return value;
      }).catch(error => {
        setNote(elements.managerStatus, `资料读取失败：${errorText(error)}`, true);
        throw error;
      }).finally(() => { libraryLoading = undefined; });
      return libraryLoading;
    }

    function importSummary(result = {}) {
      const pending = Array.isArray(result.pending) && result.pending.length ? `；待重试 ${result.pending.join('、')}` : '';
      return `完成：历史 ${Number(result.history) || 0}、收藏 ${Number(result.bookmarks) || 0}、Cookie ${Number(result.cookies) || 0}、密码 ${Number(result.passwords) || 0}、自动填充 ${Number(result.autofill) || 0}、扩展 ${Number(result.extensions) || 0}${pending}`;
    }

    function renderLibrary(library) {
      if (!library) return;
      librarySnapshot = library;
      const settings = library.settings || {};
      const pending = library.pendingImport;
      elements.managerStatus.textContent = pending && Array.isArray(pending.items) && pending.items.length
        ? `待自动补迁：${pending.items.join('、')}`
        : library.encryptionAvailable ? '独立配置 · Windows 系统安全存储加密' : '系统安全存储暂不可用；不会以明文保存密码';

      const homepages = Array.isArray(settings.homepages) ? settings.homepages : [];
      if (document.activeElement !== elements.homepages) elements.homepages.value = homepages.join('\n');
      elements.homepageNote.textContent = `当前 ${homepages.length} 个首页；新标签使用首项。`;

      const sourceControls = [];
      for (const source of Array.isArray(library.sources) ? library.sources : []) {
        const control = button(source.available ? `迁移 ${text(source.name)}` : `${text(source.name)}（未发现）`, async () => {
          control.disabled = true;
          const original = control.textContent;
          control.textContent = `正在迁移 ${text(source.name)}…`;
          setNote(elements.importNote, '正在复制资料到便携盘；界面不会显示 Cookie 或密码内容。');
          try {
            const response = await browser.importProfile(text(source.id));
            if (response?.library) renderLibrary(response.library);
            setNote(elements.importNote, importSummary(response?.result));
          } catch (error) {
            setNote(elements.importNote, `迁移失败：${errorText(error)}`, true);
          } finally {
            control.disabled = !source.available;
            control.textContent = original;
          }
        }, 'primary');
        control.disabled = !source.available;
        sourceControls.push(control);
      }
      if (sourceControls.length) elements.sources.replaceChildren(...sourceControls);
      else replaceList(elements.sources, [], '未发现可迁移的浏览器配置');
      if (!elements.importNote.textContent && library.lastImport) elements.importNote.textContent = `最近迁移：${importSummary(library.lastImport).replace(/^完成：/, '')}`;

      const historyAll = Array.isArray(library.history) ? library.history : [];
      const query = elements.historyFilter.value.trim().toLowerCase();
      const history = historyAll.filter(entry => !query || `${text(entry.title)} ${text(entry.url)}`.toLowerCase().includes(query));
      elements.historyCount.textContent = `${historyAll.length} 条`;
      replaceList(elements.historyList, history.slice(0, 300).map(entry => row(entry.title || entry.url, `${entry.url} · ${dateText(entry.lastVisitAt)}`, [
        { label: '打开', run: async () => { await browser.newTab(entry.url); await browser.toggleManager(false); } },
        { label: '删除', className: 'danger', run: async () => refreshLibrary(await browser.removeLibraryItem('history', entry.id)) },
      ])), query ? '没有匹配的历史记录' : '暂无历史记录');

      const bookmarks = Array.isArray(library.bookmarks) ? library.bookmarks : [];
      elements.bookmarkCount.textContent = `${bookmarks.length} 条`;
      replaceList(elements.bookmarkList, bookmarks.map(entry => row(entry.title || entry.url, entry.url, [
        { label: '打开', run: async () => { await browser.newTab(entry.url); await browser.toggleManager(false); } },
        { label: '删除', className: 'danger', run: async () => refreshLibrary(await browser.removeLibraryItem('bookmark', entry.id)) },
      ])), '暂无收藏');

      const credentials = Array.isArray(library.credentials) ? library.credentials : [];
      replaceList(elements.credentialList, credentials.map(entry => row(entry.label || entry.origin, `${entry.username || '无用户名'} · ${entry.origin}`, [
        { label: '填入当前页', run: async () => {
          try {
            const result = await browser.fillCredential(entry.id);
            setNote(elements.autofillNote, `用户名${result?.username ? '已填入' : '未找到输入框'}，密码${result?.password ? '已填入' : '未找到输入框'}。`);
          } catch (error) { setNote(elements.autofillNote, errorText(error), true); }
        } },
        { label: '删除', className: 'danger', run: async () => refreshLibrary(await browser.removeLibraryItem('credential', entry.id)) },
      ])), '暂无保存密码');
      if (!elements.autofillNote.textContent) elements.autofillNote.textContent = library.autofill?.length
        ? `已保存 ${library.autofill.length} 条表单数据，可按字段名填充当前页。`
        : '暂无自动填充数据。';

      const extensionRows = (Array.isArray(library.extensions) ? library.extensions : []).map(entry => {
        const item = row(entry.name || entry.id, `${entry.version || ''}${entry.error ? ` · ${entry.error}` : ''}`);
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.checked = Boolean(entry.enabled);
        toggle.title = '立即应用到当前浏览器会话';
        toggle.setAttribute('aria-label', `${entry.name || entry.id} 启用状态`);
        toggle.addEventListener('change', async () => {
          toggle.disabled = true;
          try { refreshLibrary(await browser.toggleExtension(entry.id, toggle.checked)); }
          catch (error) { toggle.checked = entry.enabled; setNote(elements.importNote, `扩展状态更新失败：${errorText(error)}`, true); }
          finally { toggle.disabled = false; }
        });
        item.querySelector('.browser-manager-row-actions').append(toggle);
        return item;
      });
      replaceList(elements.extensionList, extensionRows, '暂无已迁移扩展');
      elements.historyEnabled.checked = settings.historyEnabled !== false;
      elements.importRetry.checked = settings.autoRetryImport !== false;
      elements.extensionsLoad.checked = settings.loadExtensions !== false;
    }

    function renderDownloads(downloads) {
      if (!Array.isArray(downloads) || downloads.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'browser-download-empty';
        empty.textContent = '暂无下载记录';
        elements.downloadList.replaceChildren(empty);
        return;
      }
      const rows = downloads.map(entry => {
        const item = document.createElement('div');
        item.className = 'browser-download-item';
        const copy = document.createElement('div');
        copy.className = 'browser-download-copy';
        const name = document.createElement('div');
        name.className = 'browser-download-name';
        name.textContent = entry.name || '未命名下载';
        const status = entry.status === 'progressing' ? '下载中' : entry.status === 'completed' ? '已完成' : entry.status === 'cancelled' ? '已取消' : '已中断';
        const meta = document.createElement('div');
        meta.className = 'browser-download-meta';
        meta.textContent = `${status} · ${byteText(entry.receivedBytes)}${entry.totalBytes ? ` / ${byteText(entry.totalBytes)}` : ''} · ${dateText(entry.startedAt)}`;
        copy.append(name, meta);
        if (entry.status === 'progressing') {
          const progress = document.createElement('div');
          progress.className = 'browser-download-progress';
          const bar = document.createElement('span');
          bar.style.width = `${Math.max(0, Math.min(100, Number(entry.progress) || 0))}%`;
          progress.append(bar);
          copy.append(progress);
        }
        const actions = document.createElement('div');
        actions.className = 'browser-download-actions';
        if (entry.status === 'completed') {
          actions.append(button('打开', () => browser.openDownload(entry.id)), button('定位', () => browser.showDownload(entry.id)));
          item.addEventListener('dblclick', () => browser.openDownload(entry.id));
        }
        item.append(copy, actions);
        return item;
      });
      elements.downloadList.replaceChildren(...rows);
    }

    async function openManager(focusBookmarks = false) {
      await browser.toggleManager(true);
      await refreshLibrary();
      if (focusBookmarks) requestAnimationFrame(() => elements.bookmarkCard.focus());
    }

    function setMenu(open) {
      const requestedOpen = Boolean(open);
      menuTransition = menuTransition.catch(() => undefined).then(async () => {
        if (requestedOpen) {
          if (!await prepareMenuSnapshot()) {
            clearMenuSnapshot();
            console.warn('浏览器菜单未打开：当前网页快照不可用，已保留原生网页。');
            return;
          }
          try { await browser.toggleMenu(true); }
          catch (error) { clearMenuSnapshot(); throw error; }
          return;
        }
        await browser.toggleMenu(false);
        await nextPaint();
        clearMenuSnapshot();
      });
      return menuTransition;
    }
    function openFind() {
      elements.find.hidden = false;
      elements.findInput.focus();
      elements.findInput.select();
      if (elements.findInput.value) requestFind({ forward: true, findNext: false });
    }
    function closeFind() {
      elements.find.hidden = true;
      elements.findCount.textContent = '0/0';
      browser.stopFind();
    }
    function requestFind(options) {
      const query = elements.findInput.value;
      if (!query) { elements.findCount.textContent = '0/0'; return browser.stopFind(); }
      return browser.find(query, options).catch(() => undefined);
    }

    function render(state) {
      if (!state) return;
      elements.manager.hidden = !state.managerOpen;
      elements.overflow.hidden = !state.menuOpen;
      elements.downloadDrawer.hidden = !state.downloadsOpen;
      const drawerHeight = Math.max(0, Number(state.downloadsDrawerHeight) || 0);
      elements.downloadDrawer.style.setProperty('--browser-downloads-height', `${drawerHeight}px`);
      elements.more.setAttribute('aria-expanded', String(Boolean(state.menuOpen)));
      if (!state.menuOpen && elements.overflow.hidden && !pageSnapshot.hidden) clearMenuSnapshot();
      elements.downloads.setAttribute('aria-pressed', String(Boolean(state.downloadsOpen)));
      elements.downloads.textContent = state.downloads?.some(entry => entry.status === 'progressing') ? '下载中' : '下载';
      elements.bookmark.setAttribute('aria-pressed', String(Boolean(state.bookmarked)));
      elements.bookmark.textContent = state.bookmarked ? '已收藏' : '收藏';
      elements.bookmark.title = state.bookmarked ? '取消收藏当前页' : '收藏当前页';
      elements.zoomValue.textContent = `${Number(state.pageZoomPercent) || 100}%`;
      renderDownloads(state.downloads);
      if (state.managerOpen && !lastManagerOpen) {
        refreshLibrary().catch(() => undefined);
        browser.runtimeInfo().then(runtime => {
          if (!runtime) return;
          elements.runtimeInfo.textContent = `Electron ${runtime.electron}\nChromium ${runtime.chromium}\nNode ${runtime.node}\n由桌面 A/B 更新器统一更新、验证与回滚`;
        }).catch(error => { elements.runtimeInfo.textContent = `版本读取失败：${errorText(error)}`; });
      }
      lastManagerOpen = Boolean(state.managerOpen);
    }

    elements.bookmark.addEventListener('click', async () => {
      const response = await browser.bookmarkCurrent();
      if (response?.library && getState()?.browser?.managerOpen) renderLibrary(response.library);
    });
    elements.library.addEventListener('click', () => openManager());
    elements.downloads.addEventListener('click', () => browser.toggleDownloads());
    elements.external.addEventListener('click', () => browser.openExternal());
    elements.more.addEventListener('click', event => { event.stopPropagation(); setMenu(elements.overflow.hidden); });
    elements.overflow.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => { if (!elements.overflow.hidden) setMenu(false); });
    elements.menuFind.addEventListener('click', () => { setMenu(false); openFind(); });
    elements.menuPrint.addEventListener('click', () => { setMenu(false); browser.printPage(); });
    elements.menuScreenshot.addEventListener('click', async () => {
      await setMenu(false);
      try { const name = await browser.captureScreenshot(); if (name) setNote(elements.importNote, `截图已保存：${name}`); }
      catch (error) { setNote(elements.importNote, `截图失败：${errorText(error)}`, true); }
    });
    elements.menuDevTools.addEventListener('click', () => { setMenu(false); browser.toggleDevTools(); });
    elements.zoomOut.addEventListener('click', () => browser.pageZoom('out'));
    elements.zoomIn.addEventListener('click', () => browser.pageZoom('in'));
    elements.zoomReset.addEventListener('click', () => browser.pageZoom('reset'));
    elements.menuDownloads.addEventListener('click', () => browser.toggleDownloads());
    elements.menuLibrary.addEventListener('click', () => openManager());
    elements.menuClear.addEventListener('click', async () => {
      await setMenu(false);
      if (!confirm('确定清除浏览器 Cookie、缓存和站点数据吗？收藏、历史和密码不会被删除。')) return;
      await browser.clearData();
    });
    elements.menuClose.addEventListener('click', () => { setMenu(false); browser.toggle(); });

    elements.find.addEventListener('submit', event => { event.preventDefault(); requestFind({ forward: true, findNext: true }); });
    elements.findInput.addEventListener('input', () => {
      clearTimeout(findTimer);
      findTimer = setTimeout(() => requestFind({ forward: true, findNext: false }), 120);
    });
    elements.findInput.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
      else if (event.key === 'Enter') { event.preventDefault(); requestFind({ forward: !event.shiftKey, findNext: true }); }
    });
    elements.findPrevious.addEventListener('click', () => requestFind({ forward: false, findNext: true }));
    elements.findNext.addEventListener('click', () => requestFind({ forward: true, findNext: true }));
    elements.findClose.addEventListener('click', closeFind);
    if (typeof api.onBrowserFindResult === 'function') api.onBrowserFindResult(result => {
      elements.findCount.textContent = `${Number(result?.activeMatchOrdinal) || 0}/${Number(result?.matches) || 0}`;
    });
    if (typeof api.onBrowserOpenFind === 'function') api.onBrowserOpenFind(openFind);
    if (typeof api.onBrowserFocusAddress === 'function') api.onBrowserFocusAddress(() => {
      const address = byId('browser-address');
      address.focus();
      address.select();
    });

    elements.downloadClose.addEventListener('click', () => browser.toggleDownloads());
    elements.downloadClear.addEventListener('click', () => browser.clearDownloads());
    elements.downloadFolder.addEventListener('click', () => browser.openDownloadsFolder());
    elements.managerClose.addEventListener('click', () => browser.toggleManager(false));
    elements.historyFilter.addEventListener('input', () => librarySnapshot && renderLibrary(librarySnapshot));
    elements.historyClear.addEventListener('click', async () => {
      if (confirm('确定清空浏览历史吗？')) refreshLibrary(await browser.clearLibraryItems('history'));
    });
    elements.bookmarkClear.addEventListener('click', async () => {
      if (confirm('确定清空收藏夹吗？')) refreshLibrary(await browser.clearLibraryItems('bookmarks'));
    });
    elements.homepageForm.addEventListener('submit', async event => {
      event.preventDefault();
      const homepages = elements.homepages.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      try {
        const library = await browser.saveSettings({ homepages });
        renderLibrary(library);
        setNote(elements.homepageNote, `已保存 ${library.settings.homepages.length} 个首页。`);
      } catch (error) { setNote(elements.homepageNote, errorText(error), true); }
    });
    elements.homepageOpen.addEventListener('click', async () => { await browser.openHomepages(); await browser.toggleManager(false); });
    elements.homepageReset.addEventListener('click', async () => {
      const library = await browser.saveSettings({ homepages: [] });
      renderLibrary(library);
      setNote(elements.homepageNote, '已恢复默认首页组。');
    });
    elements.credentialForm.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        const library = await browser.saveCredential({
          origin: elements.credentialOrigin.value,
          username: elements.credentialUsername.value,
          password: elements.credentialPassword.value,
        });
        elements.credentialPassword.value = '';
        renderLibrary(library);
        setNote(elements.autofillNote, '密码已使用 Windows 系统安全存储加密并保存到便携盘。');
      } catch (error) { setNote(elements.autofillNote, errorText(error), true); }
    });
    elements.autofill.addEventListener('click', async () => {
      try { const result = await browser.autofillPage(); setNote(elements.autofillNote, `当前页已填充 ${Number(result?.filled) || 0} 个字段。`); }
      catch (error) { setNote(elements.autofillNote, errorText(error), true); }
    });
    for (const input of [elements.historyEnabled, elements.importRetry, elements.extensionsLoad]) {
      input.addEventListener('change', async () => {
        const previous = !input.checked; input.disabled = true;
        try { refreshLibrary(await browser.saveSettings({
        historyEnabled: elements.historyEnabled.checked,
        autoRetryImport: elements.importRetry.checked,
        loadExtensions: elements.extensionsLoad.checked,
        })); } catch (error) { input.checked = previous; setNote(elements.importNote, `设置保存失败：${errorText(error)}`, true); }
        finally { input.disabled = false; }
      });
    }
    elements.runtimeCheck.addEventListener('click', async () => {
      elements.runtimeCheck.disabled = true;
      elements.runtimeInfo.textContent = '正在连接 Electron 官方版本服务…';
      try {
        const result = await browser.checkRuntime();
        elements.runtimeInfo.textContent = `当前 Electron ${result.current}\n官方稳定版 ${result.latest}\n${result.updateAvailable ? '发现新版本；由桌面 A/B 更新器处理。' : '当前已经是最新或更新版本。'}\n检查时间 ${dateText(result.checkedAt)}`;
      } catch (error) { elements.runtimeInfo.textContent = `检查失败：${errorText(error)}`; }
      finally { elements.runtimeCheck.disabled = false; }
    });

    document.addEventListener('keydown', event => {
      const state = getState()?.browser;
      if (!state?.visible) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openFind(); }
      else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); byId('browser-address').focus(); byId('browser-address').select(); }
      else if (event.key === 'Escape' && !elements.find.hidden) closeFind();
    });

    return { render, openFind, openManager, refreshLibrary };
  }

  window.DshBrowserWorkspace = Object.freeze({ create });
})();
